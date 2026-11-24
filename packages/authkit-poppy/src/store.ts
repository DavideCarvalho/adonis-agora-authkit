/**
 * Persistência do Poppy — tabelas LIB-OWNED (ver `tables.ts`): Sessions, access tokens (só o
 * hash), pedidos de sign-in e de entrada de navegador, e `jti` vistos. Os refresh tokens
 * reaproveitam o ledger de grants do authkit (`PersonalAgentGrantLedger`).
 *
 * Query builder puro, datas comparadas em JS
 * depois de buscar a linha pela chave, transições de estado atômicas por
 * `where status = from`.
 */

export const SESSION_TABLE = 'auth_poppy_sessions';
export const TOKEN_TABLE = 'auth_poppy_tokens';
export const REQUEST_TABLE = 'auth_poppy_requests';
export const GRANT_KEY_TABLE = 'auth_poppy_grant_keys';
export const GRANT_RESOURCES_TABLE = 'auth_poppy_grant_resources';
export const DELEGATED_KEY_TABLE = 'auth_poppy_delegated_keys';
export const FEEDBACK_TABLE = 'auth_poppy_feedback';
export const OPERATION_TABLE = 'auth_poppy_operations';
export const REVISION_TABLE = 'auth_poppy_operation_revisions';

export interface SessionRow {
  /** Derivado de `client_id` + `sid` + User ID (§5.3). */
  id: string;
  clientId: string;
  userId: string;
  agentId: string | null;
  /** Conta que a Session já usou: recusamos outra com `invalid_session` (§5.4). */
  accountId: string | null;
  /** Colunas da Draft 0.1, sem uso: o acesso à conta não passa pela Session. */
  grantId: string | null;
  scope: string;
  /** O `sid` do agente (§5.2); `null` em Sessions de antes da coluna. */
  sid: string | null;
  /** O `Poppy-Version` com que a Session começou (§3.4); `null` em Sessions de antes da coluna. */
  protocolVersion: string | null;
  expiresAt: Date;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type OperationInterface = 'api' | 'mcp' | 'conversation' | 'website';
export type OperationStatus = 'pending' | 'approved' | 'performing' | 'performed';

/** Uma operação (extensão Operations 3). */
export interface OperationRow {
  id: string;
  clientId: string;
  userId: string;
  /** Conta dona da operação; `null` = devolvida numa Session deslogada. */
  accountId: string | null;
  interface: OperationInterface;
  /** A revisão atual: a última devolvida. */
  revision: string;
  status: OperationStatus;
  refHash: string | null;
  approvedRevision: string | null;
  approver: 'user' | 'agent' | null;
  approvedAt: number | null;
  inputType: string | null;
  reference: string | null;
  /** Quando a aprovação foi gravada (site) ou aceita. */
  recordedAt: Date | null;
  /** A resposta da execução (`markPerformed`), repetida nos retries. */
  response: unknown;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface RevisionRow {
  revision: string;
  operationId: string;
  fingerprint: string;
  terms: Record<string, unknown>;
  summary: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Um relato de feedback (§9.3). */
export interface FeedbackRow {
  id: string;
  clientId: string;
  userId: string;
  agentId: string | null;
  sessionId: string;
  accountId: string | null;
  protocolVersion: string;
  task: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Access token (§4.5). */
export interface TokenRow {
  tokenHash: string;
  clientId: string;
  accountId: string | null;
  grantId: string | null;
  scope: string;
  resource: string | null;
  /** Thumbprint da chave DPoP; `null` = Bearer. */
  jkt: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export type RequestKind = 'authorize' | 'par' | 'device' | 'mediated' | 'browser';
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
    agentId: row.agent_id ?? null,
    accountId: row.account_id ?? null,
    grantId: row.grant_id ?? null,
    scope: row.scope ?? '',
    sid: row.sid ?? null,
    protocolVersion: row.protocol_version ?? null,
    expiresAt: toDate(row.expires_at),
    endedAt: toDateOrNull(row.ended_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function toToken(row: any): TokenRow {
  return {
    tokenHash: row.token_hash,
    clientId: row.client_id,
    accountId: row.account_id ?? null,
    grantId: row.grant_id ?? null,
    scope: row.scope ?? '',
    resource: row.resource ?? null,
    jkt: row.jkt ?? null,
    expiresAt: toDate(row.expires_at),
    createdAt: toDate(row.created_at),
  };
}

function parseJson(value: unknown): any {
  if (value === null || value === undefined || value === '') return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function toOperation(row: any): OperationRow {
  return {
    id: row.id,
    clientId: row.client_id,
    userId: row.user_id,
    accountId: row.account_id ?? null,
    interface: row.interface,
    revision: row.revision,
    status: row.status,
    refHash: row.ref_hash ?? null,
    approvedRevision: row.approved_revision ?? null,
    approver: row.approver ?? null,
    approvedAt:
      row.approved_at === null || row.approved_at === undefined ? null : Number(row.approved_at),
    inputType: row.input_type ?? null,
    reference: row.reference ?? null,
    recordedAt: toDateOrNull(row.recorded_at),
    response: parseJson(row.response),
    expiresAt: toDate(row.expires_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function toRevision(row: any): RevisionRow {
  return {
    revision: row.revision,
    operationId: row.operation_id,
    fingerprint: row.fingerprint,
    terms: parseJson(row.terms) ?? {},
    summary: row.summary ?? null,
    expiresAt: toDate(row.expires_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
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
  constructor(
    private conn: () => any,
    /** Nome da tabela como os statements o escrevem (`schema.tabela` quando o app usa um schema). */
    private t: (name: string) => string = (name) => name,
  ) {}

  // ─── sessions ─────────────────────────────────────────────────────────────

  async insertSession(row: Omit<SessionRow, 'endedAt'>): Promise<void> {
    await this.conn().table(this.t(SESSION_TABLE)).insert({
      id: row.id,
      client_id: row.clientId,
      user_id: row.userId,
      agent_id: row.agentId,
      account_id: row.accountId,
      grant_id: row.grantId,
      scope: row.scope,
      sid: row.sid,
      protocol_version: row.protocolVersion,
      expires_at: row.expiresAt,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    });
  }

  /**
   * Completa `sid` e `protocol_version` de uma Session de antes dessas colunas. Atômico: só onde
   * a versão ainda é `null`; `false` = outra request gravou antes.
   */
  async fillSessionColumns(
    id: string,
    sid: string,
    protocolVersion: string,
    at: Date,
  ): Promise<boolean> {
    const result = await this.conn()
      .from(this.t(SESSION_TABLE))
      .where('id', id)
      .whereNull('protocol_version')
      .update({ sid, protocol_version: protocolVersion, updated_at: at });
    return affected(result) > 0;
  }

  async findSession(id: string): Promise<SessionRow | null> {
    if (typeof id !== 'string' || !id) return null;
    const row = await this.conn().from(this.t(SESSION_TABLE)).where('id', id).first();
    return row ? toSession(row) : null;
  }

  /** Estende a vida da Session (uso). */
  async touchSession(id: string, expiresAt: Date, at: Date): Promise<void> {
    await this.conn()
      .from(this.t(SESSION_TABLE))
      .where('id', id)
      .whereNull('ended_at')
      .update({ expires_at: expiresAt, updated_at: at });
  }

  /**
   * Registra a conta que a Session usa (§5.4). Atômico: só se nenhuma foi registrada ou é a MESMA.
   * `false` = outra conta chegou nesse meio-tempo.
   */
  async bindSessionAccount(id: string, accountId: string, at: Date): Promise<boolean> {
    const result = await this.conn()
      .from(this.t(SESSION_TABLE))
      .where('id', id)
      .where((q: any) => q.whereNull('account_id').orWhere('account_id', accountId))
      .update({ account_id: accountId, updated_at: at });
    return affected(result) > 0;
  }

  /** Encerra todas as Sessions de um agente (bloqueio no console): param na hora. */
  async endSessionsOfClient(clientId: string, at: Date): Promise<number> {
    const result = await this.conn()
      .from(this.t(SESSION_TABLE))
      .where('client_id', clientId)
      .whereNull('ended_at')
      .update({ ended_at: at, grant_id: null, scope: '', updated_at: at });
    return affected(result);
  }

  // ─── access tokens ────────────────────────────────────────────────────────

  async insertToken(row: TokenRow): Promise<void> {
    await this.conn().table(this.t(TOKEN_TABLE)).insert({
      token_hash: row.tokenHash,
      // `session_id`/`user_id` são NOT NULL desde a Draft 0.1 e o schema só é aditivo; o sign-in
      // não conhece a Session nem o User ID (§4.4).
      session_id: '',
      client_id: row.clientId,
      user_id: '',
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
    const row = await this.conn().from(this.t(TOKEN_TABLE)).where('token_hash', hash).first();
    return row ? toToken(row) : null;
  }

  async deleteToken(hash: string): Promise<boolean> {
    return (
      affected(await this.conn().from(this.t(TOKEN_TABLE)).where('token_hash', hash).delete()) > 0
    );
  }

  async deleteTokensExpiredBefore(before: Date): Promise<void> {
    await this.conn().from(this.t(TOKEN_TABLE)).where('expires_at', '<', before).delete();
  }

  // ─── chave DPoP dos refresh tokens (§4.4) ──────────────────────────────────

  async insertGrantKey(grantId: string, jkt: string, at: Date): Promise<void> {
    await this.conn().table(this.t(GRANT_KEY_TABLE)).insert({
      grant_id: grantId,
      jkt,
      created_at: at,
      updated_at: at,
    });
  }

  /** Thumbprint da chave DPoP a que o refresh token do grant está preso; `null` = solto. */
  async findGrantKey(grantId: string): Promise<string | null> {
    const row = await this.conn().from(this.t(GRANT_KEY_TABLE)).where('grant_id', grantId).first();
    return row?.jkt ?? null;
  }

  // ─── resources de um sign-in limitado (§4.5) ───────────────────────────────

  async insertGrantResources(grantId: string, resources: string[], at: Date): Promise<void> {
    await this.conn()
      .table(this.t(GRANT_RESOURCES_TABLE))
      .insert({
        grant_id: grantId,
        resources: JSON.stringify(resources),
        created_at: at,
        updated_at: at,
      });
  }

  /** Os resources a que o grant ficou limitado; `null` = cobre todos. */
  async findGrantResources(grantId: string): Promise<string[] | null> {
    const row = await this.conn()
      .from(this.t(GRANT_RESOURCES_TABLE))
      .where('grant_id', grantId)
      .first();
    const list = row ? parseJson(row.resources) : null;
    return Array.isArray(list) ? list.map(String) : null;
  }

  // ─── chaves delegadas (§5.2) ───────────────────────────────────────────────

  /**
   * Liga a chave delegada (`id`) ao User ID que assinou com ela, até `expiresAt`. Devolve o User
   * ID a que ela está ligada agora — outro que o pedido = a chave já assinou por outro usuário.
   */
  async bindDelegatedKey(
    id: string,
    clientId: string,
    userId: string,
    expiresAt: Date,
    now: Date,
  ): Promise<string> {
    const table = this.t(DELEGATED_KEY_TABLE);
    const row = await this.conn().from(table).where('id', id).first();
    if (row && toDate(row.expires_at) > now) {
      // Uma delegação nova para a mesma chave estende a ligação.
      if (row.user_id === userId && toDate(row.expires_at) < expiresAt) {
        await this.conn()
          .from(table)
          .where('id', id)
          .where('user_id', userId)
          .update({ expires_at: expiresAt, updated_at: now });
      }
      return row.user_id;
    }
    if (row) {
      // Ligação vencida: a chave pode ser de outro usuário agora. Atômico sobre o vencimento lido.
      const moved = await this.conn()
        .from(table)
        .where('id', id)
        .where('expires_at', row.expires_at)
        .update({ client_id: clientId, user_id: userId, expires_at: expiresAt, updated_at: now });
      if (affected(moved) > 0) return userId;
    } else {
      try {
        await this.conn().table(table).insert({
          id,
          client_id: clientId,
          user_id: userId,
          expires_at: expiresAt,
          created_at: now,
          updated_at: now,
        });
        return userId;
      } catch {
        // Outra request inseriu antes: vale o que ela gravou.
      }
    }
    const current = await this.conn().from(table).where('id', id).first();
    return current?.user_id ?? userId;
  }

  async deleteDelegatedKeysExpiredBefore(before: Date): Promise<void> {
    await this.conn().from(this.t(DELEGATED_KEY_TABLE)).where('expires_at', '<', before).delete();
  }

  // ─── feedback (§9.3) ───────────────────────────────────────────────────────

  async insertFeedback(row: FeedbackRow): Promise<void> {
    await this.conn().table(this.t(FEEDBACK_TABLE)).insert({
      id: row.id,
      client_id: row.clientId,
      user_id: row.userId,
      agent_id: row.agentId,
      session_id: row.sessionId,
      account_id: row.accountId,
      protocol_version: row.protocolVersion,
      task: row.task,
      description: row.description,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    });
  }

  /** Os relatos mais recentes primeiro. */
  async listFeedback(limit: number): Promise<FeedbackRow[]> {
    const rows = await this.conn()
      .from(this.t(FEEDBACK_TABLE))
      .orderBy('created_at', 'desc')
      .limit(limit);
    return rows.map((row: any) => ({
      id: row.id,
      clientId: row.client_id,
      userId: row.user_id,
      agentId: row.agent_id ?? null,
      sessionId: row.session_id,
      accountId: row.account_id ?? null,
      protocolVersion: row.protocol_version,
      task: row.task,
      description: row.description,
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at),
    }));
  }

  // ─── operações (extensão Operations 3) ─────────────────────────────────────

  async insertOperation(
    row: Pick<
      OperationRow,
      | 'id'
      | 'clientId'
      | 'userId'
      | 'accountId'
      | 'interface'
      | 'revision'
      | 'refHash'
      | 'expiresAt'
    > & { at: Date },
  ): Promise<void> {
    await this.conn().table(this.t(OPERATION_TABLE)).insert({
      id: row.id,
      client_id: row.clientId,
      user_id: row.userId,
      account_id: row.accountId,
      interface: row.interface,
      revision: row.revision,
      status: 'pending',
      ref_hash: row.refHash,
      expires_at: row.expiresAt,
      created_at: row.at,
      updated_at: row.at,
    });
  }

  async findOperation(id: string): Promise<OperationRow | null> {
    if (typeof id !== 'string' || !id) return null;
    const row = await this.conn().from(this.t(OPERATION_TABLE)).where('id', id).first();
    return row ? toOperation(row) : null;
  }

  async findOperationByRefHash(hash: string): Promise<OperationRow | null> {
    const row = await this.conn().from(this.t(OPERATION_TABLE)).where('ref_hash', hash).first();
    return row ? toOperation(row) : null;
  }

  /**
   * Operações do site com aprovação gravada e ainda não usada, de quem pode aprová-las, da mais
   * antiga para a mais nova (Operations 3, §6 "Websites").
   */
  async listRecordedWebsiteApprovals(input: {
    clientId: string;
    userId: string;
    accountId: string | null;
  }): Promise<OperationRow[]> {
    const q = this.conn()
      .from(this.t(OPERATION_TABLE))
      .where('client_id', input.clientId)
      .where('user_id', input.userId)
      .where('interface', 'website')
      .where('status', 'approved');
    if (input.accountId === null) q.whereNull('account_id');
    else q.where('account_id', input.accountId);
    const rows = await q.orderBy('recorded_at', 'asc').orderBy('id', 'asc');
    return rows.map(toOperation);
  }

  /** Transição atômica de status — só se a operação ainda está num dos `from`. */
  async transitionOperation(
    id: string,
    from: OperationStatus[],
    patch: {
      status: OperationStatus;
      approvedRevision?: string | null;
      approver?: 'user' | 'agent' | null;
      approvedAt?: number | null;
      inputType?: string | null;
      reference?: string | null;
      recordedAt?: Date | null;
      response?: unknown;
      expiresAt?: Date;
      at: Date;
    },
  ): Promise<boolean> {
    const update: Record<string, unknown> = { status: patch.status, updated_at: patch.at };
    if (patch.approvedRevision !== undefined) update.approved_revision = patch.approvedRevision;
    if (patch.approver !== undefined) update.approver = patch.approver;
    if (patch.approvedAt !== undefined) update.approved_at = patch.approvedAt;
    if (patch.inputType !== undefined) update.input_type = patch.inputType;
    if (patch.reference !== undefined) update.reference = patch.reference;
    if (patch.recordedAt !== undefined) update.recorded_at = patch.recordedAt;
    if (patch.response !== undefined) {
      update.response = patch.response === null ? null : JSON.stringify(patch.response);
    }
    if (patch.expiresAt !== undefined) update.expires_at = patch.expiresAt;
    const result = await this.conn()
      .from(this.t(OPERATION_TABLE))
      .where('id', id)
      .whereIn('status', from)
      .update(update);
    return affected(result) > 0;
  }

  /**
   * Troca a revisão atual de uma operação ainda não executada (termos novos) e estende a
   * lembrança até `expiresAt`, quando for mais longe. `false` = a operação já saiu de `pending`.
   */
  async replaceRevision(id: string, revision: string, expiresAt: Date, at: Date): Promise<boolean> {
    const current = await this.findOperation(id);
    if (!current || current.status !== 'pending') return false;
    const result = await this.conn()
      .from(this.t(OPERATION_TABLE))
      .where('id', id)
      .where('status', 'pending')
      .update({
        revision,
        expires_at: current.expiresAt > expiresAt ? current.expiresAt : expiresAt,
        updated_at: at,
      });
    return affected(result) > 0;
  }

  async insertRevision(row: RevisionRow): Promise<void> {
    await this.conn()
      .table(this.t(REVISION_TABLE))
      .insert({
        revision: row.revision,
        operation_id: row.operationId,
        fingerprint: row.fingerprint,
        terms: JSON.stringify(row.terms),
        summary: row.summary,
        expires_at: row.expiresAt,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      });
  }

  async findRevision(revision: string): Promise<RevisionRow | null> {
    if (typeof revision !== 'string' || !revision) return null;
    const row = await this.conn().from(this.t(REVISION_TABLE)).where('revision', revision).first();
    return row ? toRevision(row) : null;
  }

  /**
   * Esquece operações vencidas (Operations 3, §7): nunca uma em execução. As revisões vão junto.
   */
  async deleteOperationsExpiredBefore(before: Date): Promise<void> {
    const ids = (
      await this.conn()
        .from(this.t(OPERATION_TABLE))
        .where('expires_at', '<', before)
        .whereNot('status', 'performing')
        .select('id')
        .limit(500)
    ).map((r: any) => r.id);
    if (ids.length === 0) return;
    await this.conn().from(this.t(REVISION_TABLE)).whereIn('operation_id', ids).delete();
    await this.conn().from(this.t(OPERATION_TABLE)).whereIn('id', ids).delete();
  }

  // ─── sign-in requests ─────────────────────────────────────────────────────

  async insertRequest(
    row: Omit<RequestRow, 'attempts' | 'lastPolledAt' | 'grantedScope'> & {
      grantedScope?: string | null;
    },
  ): Promise<void> {
    await this.conn()
      .table(this.t(REQUEST_TABLE))
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
    const row = await this.conn().from(this.t(REQUEST_TABLE)).where('id', id).first();
    return row ? toRequest(row) : null;
  }

  async findRequestByCodeHash(hash: string): Promise<RequestRow | null> {
    const row = await this.conn().from(this.t(REQUEST_TABLE)).where('code_hash', hash).first();
    return row ? toRequest(row) : null;
  }

  async findRequestByUserCode(userCode: string): Promise<RequestRow | null> {
    const row = await this.conn().from(this.t(REQUEST_TABLE)).where('user_code', userCode).first();
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
      clientId?: string;
      sessionId?: string;
      data?: Record<string, unknown>;
    },
  ): Promise<boolean> {
    const update: Record<string, unknown> = { status: patch.status };
    if (patch.accountId !== undefined) update.account_id = patch.accountId;
    if (patch.grantedScope !== undefined) update.granted_scope = patch.grantedScope;
    if (patch.codeHash !== undefined) update.code_hash = patch.codeHash;
    if (patch.attempts !== undefined) update.attempts = patch.attempts;
    if (patch.expiresAt !== undefined) update.expires_at = patch.expiresAt;
    if (patch.clientId !== undefined) update.client_id = patch.clientId;
    if (patch.sessionId !== undefined) update.session_id = patch.sessionId;
    if (patch.data !== undefined) update.data = JSON.stringify(patch.data);
    const result = await this.conn()
      .from(this.t(REQUEST_TABLE))
      .where('id', id)
      .where('status', from)
      .update(update);
    return affected(result) > 0;
  }

  /** Conta uma tentativa errada (atômico sobre o valor lido). */
  async bumpAttempts(id: string, from: number): Promise<boolean> {
    const result = await this.conn()
      .from(this.t(REQUEST_TABLE))
      .where('id', id)
      .where('attempts', from)
      .update({ attempts: from + 1 });
    return affected(result) > 0;
  }

  async setRequestData(id: string, data: Record<string, unknown>): Promise<void> {
    await this.conn()
      .from(this.t(REQUEST_TABLE))
      .where('id', id)
      .update({ data: JSON.stringify(data) });
  }

  async markPolled(id: string, at: Date): Promise<void> {
    await this.conn().from(this.t(REQUEST_TABLE)).where('id', id).update({ last_polled_at: at });
  }

  async deleteRequestsExpiredBefore(before: Date): Promise<void> {
    await this.conn().from(this.t(REQUEST_TABLE)).where('expires_at', '<', before).delete();
  }
}
