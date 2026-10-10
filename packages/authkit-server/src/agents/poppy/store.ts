/**
 * Persistência do Poppy — tabelas LIB-OWNED (ver `schema/ensure.ts`): Sessions,
 * Session Tokens (só o hash), pedidos de sign-in (autorização Direct, códigos,
 * device codes, Mediated) e `jti` vistos. Os Account Tokens reaproveitam
 * `auth_agent_grants` + `auth_agent_refresh_tokens` (ver `DelegationStore`).
 *
 * Mesmas regras do `DelegationStore`: query builder puro, datas comparadas em JS
 * depois de buscar a linha pela chave, transições de estado atômicas por
 * `where status = from`.
 */

export const SESSION_TABLE = 'auth_poppy_sessions';
export const TOKEN_TABLE = 'auth_poppy_tokens';
export const REQUEST_TABLE = 'auth_poppy_requests';

export interface SessionRow {
  id: string;
  clientId: string;
  userId: string;
  /** Conta a que a Session está PRESA (uma vez logada, não troca — §4.4). */
  accountId: string | null;
  /** Grant (Account Token) com que está logada agora; `null` = deslogada. */
  grantId: string | null;
  scope: string;
  expiresAt: Date;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TokenRow {
  tokenHash: string;
  sessionId: string;
  clientId: string;
  userId: string;
  accountId: string | null;
  grantId: string | null;
  scope: string;
  resource: string | null;
  /** Thumbprint da chave DPoP; `null` = Bearer (só MCP). */
  jkt: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export type RequestKind = 'authorize' | 'device' | 'mediated';
export type RequestStatus = 'pending' | 'approved' | 'denied' | 'consumed' | 'failed';

export interface RequestRow {
  id: string;
  kind: RequestKind;
  /** Hash do código de autorização / device code. */
  codeHash: string | null;
  userCode: string | null;
  clientId: string;
  sessionId: string | null;
  accountId: string | null;
  requestedScope: string;
  grantedScope: string | null;
  redirectUri: string | null;
  codeChallenge: string | null;
  status: RequestStatus;
  attempts: number;
  intervalSeconds: number | null;
  lastPolledAt: Date | null;
  data: Record<string, unknown> | null;
  expiresAt: Date;
  createdAt: Date;
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return new Date(Number(value));
  return new Date(String(value));
}

function toDateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

function affected(result: unknown): number {
  if (typeof result === 'number') return result;
  if (Array.isArray(result)) return result.length;
  return 0;
}

function toSession(row: any): SessionRow {
  return {
    id: row.id,
    clientId: row.client_id,
    userId: row.user_id,
    accountId: row.account_id ?? null,
    grantId: row.grant_id ?? null,
    scope: row.scope ?? '',
    expiresAt: toDate(row.expires_at),
    endedAt: toDateOrNull(row.ended_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function toToken(row: any): TokenRow {
  return {
    tokenHash: row.token_hash,
    sessionId: row.session_id,
    clientId: row.client_id,
    userId: row.user_id,
    accountId: row.account_id ?? null,
    grantId: row.grant_id ?? null,
    scope: row.scope ?? '',
    resource: row.resource ?? null,
    jkt: row.jkt ?? null,
    expiresAt: toDate(row.expires_at),
    createdAt: toDate(row.created_at),
  };
}

function toRequest(row: any): RequestRow {
  let data: Record<string, unknown> | null = null;
  if (row.data) {
    try {
      data = JSON.parse(row.data);
    } catch {
      data = null;
    }
  }
  return {
    id: row.id,
    kind: row.kind,
    codeHash: row.code_hash ?? null,
    userCode: row.user_code ?? null,
    clientId: row.client_id,
    sessionId: row.session_id ?? null,
    accountId: row.account_id ?? null,
    requestedScope: row.requested_scope ?? '',
    grantedScope: row.granted_scope ?? null,
    redirectUri: row.redirect_uri ?? null,
    codeChallenge: row.code_challenge ?? null,
    status: row.status,
    attempts: Number(row.attempts ?? 0),
    intervalSeconds:
      row.interval_seconds === null || row.interval_seconds === undefined
        ? null
        : Number(row.interval_seconds),
    lastPolledAt: toDateOrNull(row.last_polled_at),
    data,
    expiresAt: toDate(row.expires_at),
    createdAt: toDate(row.created_at),
  };
}

export class PoppyStore {
  constructor(private conn: () => any) {}

  // ─── sessions ─────────────────────────────────────────────────────────────

  async insertSession(row: Omit<SessionRow, 'endedAt'>): Promise<void> {
    await this.conn().table(SESSION_TABLE).insert({
      id: row.id,
      client_id: row.clientId,
      user_id: row.userId,
      account_id: row.accountId,
      grant_id: row.grantId,
      scope: row.scope,
      expires_at: row.expiresAt,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    });
  }

  async findSession(id: string): Promise<SessionRow | null> {
    if (typeof id !== 'string' || !id) return null;
    const row = await this.conn().from(SESSION_TABLE).where('id', id).first();
    return row ? toSession(row) : null;
  }

  /** Estende a vida da Session (uso). */
  async touchSession(id: string, expiresAt: Date, at: Date): Promise<void> {
    await this.conn()
      .from(SESSION_TABLE)
      .where('id', id)
      .whereNull('ended_at')
      .update({ expires_at: expiresAt, updated_at: at });
  }

  /**
   * Loga a Session numa conta. Atômico: só se ainda estiver deslogada ou presa
   * à MESMA conta. `false` = presa a outra conta (ou terminou) nesse meio-tempo.
   */
  async signInSession(
    id: string,
    patch: { accountId: string; grantId: string; scope: string; expiresAt: Date; at: Date },
  ): Promise<boolean> {
    const result = await this.conn()
      .from(SESSION_TABLE)
      .where('id', id)
      .whereNull('ended_at')
      .where((q: any) => q.whereNull('account_id').orWhere('account_id', patch.accountId))
      .update({
        account_id: patch.accountId,
        grant_id: patch.grantId,
        scope: patch.scope,
        expires_at: patch.expiresAt,
        updated_at: patch.at,
      });
    return affected(result) > 0;
  }

  /** Sign-out (§4.9): as Sessions logadas com o grant continuam, deslogadas. */
  async signOutSessionsOfGrant(grantId: string, at: Date): Promise<number> {
    const result = await this.conn()
      .from(SESSION_TABLE)
      .where('grant_id', grantId)
      .update({ grant_id: null, scope: '', updated_at: at });
    return affected(result);
  }

  // ─── session tokens ───────────────────────────────────────────────────────

  async insertToken(row: TokenRow): Promise<void> {
    await this.conn().table(TOKEN_TABLE).insert({
      token_hash: row.tokenHash,
      session_id: row.sessionId,
      client_id: row.clientId,
      user_id: row.userId,
      account_id: row.accountId,
      grant_id: row.grantId,
      scope: row.scope,
      resource: row.resource,
      jkt: row.jkt,
      expires_at: row.expiresAt,
      created_at: row.createdAt,
    });
  }

  async findToken(hash: string): Promise<TokenRow | null> {
    const row = await this.conn().from(TOKEN_TABLE).where('token_hash', hash).first();
    return row ? toToken(row) : null;
  }

  async deleteToken(hash: string): Promise<boolean> {
    return affected(await this.conn().from(TOKEN_TABLE).where('token_hash', hash).delete()) > 0;
  }

  async deleteTokensExpiredBefore(before: Date): Promise<void> {
    await this.conn().from(TOKEN_TABLE).where('expires_at', '<', before).delete();
  }

  // ─── sign-in requests ─────────────────────────────────────────────────────

  async insertRequest(
    row: Omit<RequestRow, 'attempts' | 'lastPolledAt' | 'grantedScope'> & {
      grantedScope?: string | null;
    },
  ): Promise<void> {
    await this.conn()
      .table(REQUEST_TABLE)
      .insert({
        id: row.id,
        kind: row.kind,
        code_hash: row.codeHash,
        user_code: row.userCode,
        client_id: row.clientId,
        session_id: row.sessionId,
        account_id: row.accountId,
        requested_scope: row.requestedScope,
        granted_scope: row.grantedScope ?? null,
        redirect_uri: row.redirectUri,
        code_challenge: row.codeChallenge,
        status: row.status,
        attempts: 0,
        interval_seconds: row.intervalSeconds,
        data: row.data ? JSON.stringify(row.data) : null,
        expires_at: row.expiresAt,
        created_at: row.createdAt,
      });
  }

  async findRequest(id: string): Promise<RequestRow | null> {
    if (typeof id !== 'string' || !id) return null;
    const row = await this.conn().from(REQUEST_TABLE).where('id', id).first();
    return row ? toRequest(row) : null;
  }

  async findRequestByCodeHash(hash: string): Promise<RequestRow | null> {
    const row = await this.conn().from(REQUEST_TABLE).where('code_hash', hash).first();
    return row ? toRequest(row) : null;
  }

  async findRequestByUserCode(userCode: string): Promise<RequestRow | null> {
    const row = await this.conn().from(REQUEST_TABLE).where('user_code', userCode).first();
    return row ? toRequest(row) : null;
  }

  /** Transição atômica — só se o pedido ainda está em `from`. */
  async transitionRequest(
    id: string,
    from: RequestStatus,
    patch: {
      status: RequestStatus;
      accountId?: string;
      grantedScope?: string;
      codeHash?: string;
      attempts?: number;
      expiresAt?: Date;
    },
  ): Promise<boolean> {
    const update: Record<string, unknown> = { status: patch.status };
    if (patch.accountId !== undefined) update.account_id = patch.accountId;
    if (patch.grantedScope !== undefined) update.granted_scope = patch.grantedScope;
    if (patch.codeHash !== undefined) update.code_hash = patch.codeHash;
    if (patch.attempts !== undefined) update.attempts = patch.attempts;
    if (patch.expiresAt !== undefined) update.expires_at = patch.expiresAt;
    const result = await this.conn()
      .from(REQUEST_TABLE)
      .where('id', id)
      .where('status', from)
      .update(update);
    return affected(result) > 0;
  }

  /** Conta uma tentativa errada (atômico sobre o valor lido). */
  async bumpAttempts(id: string, from: number): Promise<boolean> {
    const result = await this.conn()
      .from(REQUEST_TABLE)
      .where('id', id)
      .where('attempts', from)
      .update({ attempts: from + 1 });
    return affected(result) > 0;
  }

  async setRequestData(id: string, data: Record<string, unknown>): Promise<void> {
    await this.conn()
      .from(REQUEST_TABLE)
      .where('id', id)
      .update({ data: JSON.stringify(data) });
  }

  async markPolled(id: string, at: Date): Promise<void> {
    await this.conn().from(REQUEST_TABLE).where('id', id).update({ last_polled_at: at });
  }

  async deleteRequestsExpiredBefore(before: Date): Promise<void> {
    await this.conn().from(REQUEST_TABLE).where('expires_at', '<', before).delete();
  }
}
