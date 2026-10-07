/**
 * Persistência da delegação de personal agents — três tabelas LIB-OWNED (ver
 * `schema/ensure.ts`): pedidos de device flow, grants e refresh tokens.
 *
 * Query builder puro (sem model Lucid): as tabelas são da lib, o host não as
 * estende. Comparações de data acontecem em JS depois de buscar a linha pela
 * chave — timestamp em SQL compara diferente em sqlite/pg/mysql; status e
 * chaves únicas, não.
 */

export const DEVICE_TABLE = 'auth_agent_device_codes';
export const GRANT_TABLE = 'auth_agent_grants';
export const REFRESH_TABLE = 'auth_agent_refresh_tokens';

export type DeviceStatus = 'pending' | 'approved' | 'denied' | 'consumed';

export interface DeviceCodeRow {
  id: string;
  deviceCodeHash: string;
  userCode: string;
  clientId: string;
  agentSub: string;
  requestedScope: string;
  status: DeviceStatus;
  accountId: string | null;
  grantId: string | null;
  intervalSeconds: number;
  lastPolledAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface GrantRow {
  id: string;
  accountId: string;
  clientId: string;
  agentSub: string;
  scope: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** sqlite devolve epoch-ms, mysql/pg devolvem Date, alguns drivers string. */
function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return new Date(Number(value));
  return new Date(String(value));
}

function toDateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

function toDevice(row: any): DeviceCodeRow {
  return {
    id: row.id,
    deviceCodeHash: row.device_code_hash,
    userCode: row.user_code,
    clientId: row.client_id,
    agentSub: row.agent_sub,
    requestedScope: row.requested_scope,
    status: row.status,
    accountId: row.account_id ?? null,
    grantId: row.grant_id ?? null,
    intervalSeconds: Number(row.interval_seconds),
    lastPolledAt: toDateOrNull(row.last_polled_at),
    expiresAt: toDate(row.expires_at),
    createdAt: toDate(row.created_at),
  };
}

function toGrant(row: any): GrantRow {
  return {
    id: row.id,
    accountId: row.account_id,
    clientId: row.client_id,
    agentSub: row.agent_sub,
    scope: row.scope,
    expiresAt: toDate(row.expires_at),
    revokedAt: toDateOrNull(row.revoked_at),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}

function affected(result: unknown): number {
  // knex devolve o número de linhas; alguns drivers, um array.
  if (typeof result === 'number') return result;
  if (Array.isArray(result)) return result.length;
  return 0;
}

export class DelegationStore {
  /** `conn` = uma conexão Lucid (`db.connection(name?)`) — ou uma transação. */
  constructor(private conn: () => any) {}

  // ─── device codes ─────────────────────────────────────────────────────────

  async insertDevice(row: Omit<DeviceCodeRow, 'accountId' | 'grantId' | 'lastPolledAt'>) {
    await this.conn().table(DEVICE_TABLE).insert({
      id: row.id,
      device_code_hash: row.deviceCodeHash,
      user_code: row.userCode,
      client_id: row.clientId,
      agent_sub: row.agentSub,
      requested_scope: row.requestedScope,
      status: row.status,
      interval_seconds: row.intervalSeconds,
      expires_at: row.expiresAt,
      created_at: row.createdAt,
    });
  }

  async findDeviceByCodeHash(hash: string): Promise<DeviceCodeRow | null> {
    const row = await this.conn().from(DEVICE_TABLE).where('device_code_hash', hash).first();
    return row ? toDevice(row) : null;
  }

  async findDeviceByUserCode(userCode: string): Promise<DeviceCodeRow | null> {
    const row = await this.conn().from(DEVICE_TABLE).where('user_code', userCode).first();
    return row ? toDevice(row) : null;
  }

  /** Liga o pedido aprovado ao grant — a partir daqui o polling do agente recebe o token. */
  async setDeviceGrant(id: string, grantId: string): Promise<void> {
    await this.conn().from(DEVICE_TABLE).where('id', id).update({ grant_id: grantId });
  }

  async markPolled(id: string, at: Date): Promise<void> {
    await this.conn().from(DEVICE_TABLE).where('id', id).update({ last_polled_at: at });
  }

  /**
   * Transição de estado ATÔMICA: só aplica se o pedido ainda está em `from`.
   * `false` = outra request chegou antes (aprovação dupla, poll concorrente).
   */
  async transitionDevice(
    id: string,
    from: DeviceStatus,
    patch: { status: DeviceStatus; accountId?: string; grantId?: string },
  ): Promise<boolean> {
    const update: Record<string, unknown> = { status: patch.status };
    if (patch.accountId !== undefined) update.account_id = patch.accountId;
    if (patch.grantId !== undefined) update.grant_id = patch.grantId;
    const result = await this.conn()
      .from(DEVICE_TABLE)
      .where('id', id)
      .where('status', from)
      .update(update);
    return affected(result) > 0;
  }

  /**
   * Housekeeping: apaga pedidos que expiraram antes de `before`. O parâmetro
   * vai pelo mesmo binding do INSERT, então a comparação é coerente no dialeto.
   */
  async deleteDevicesExpiredBefore(before: Date): Promise<void> {
    await this.conn().from(DEVICE_TABLE).where('expires_at', '<', before).delete();
  }

  // ─── grants ───────────────────────────────────────────────────────────────

  async insertGrant(row: Omit<GrantRow, 'revokedAt'>): Promise<void> {
    await this.conn().table(GRANT_TABLE).insert({
      id: row.id,
      account_id: row.accountId,
      client_id: row.clientId,
      agent_sub: row.agentSub,
      scope: row.scope,
      expires_at: row.expiresAt,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    });
  }

  async findGrant(id: string): Promise<GrantRow | null> {
    const row = await this.conn().from(GRANT_TABLE).where('id', id).first();
    return row ? toGrant(row) : null;
  }

  /** Grants NÃO revogados da tripla (conta, agente, usuário do agente). */
  async findGrantsFor(accountId: string, clientId: string, agentSub: string): Promise<GrantRow[]> {
    const rows = await this.conn()
      .from(GRANT_TABLE)
      .where('account_id', accountId)
      .where('client_id', clientId)
      .where('agent_sub', agentSub)
      .whereNull('revoked_at');
    return rows.map(toGrant);
  }

  /** Atualiza um grant NÃO revogado. `false` = revogado (ou sumiu) nesse meio-tempo. */
  async updateGrant(
    id: string,
    patch: { scope: string; expiresAt: Date; updatedAt: Date },
  ): Promise<boolean> {
    const result = await this.conn()
      .from(GRANT_TABLE)
      .where('id', id)
      .whereNull('revoked_at')
      .update({ scope: patch.scope, expires_at: patch.expiresAt, updated_at: patch.updatedAt });
    return affected(result) > 0;
  }

  async listGrants(accountId: string): Promise<GrantRow[]> {
    const rows = await this.conn()
      .from(GRANT_TABLE)
      .where('account_id', accountId)
      .whereNull('revoked_at')
      .orderBy('created_at', 'desc');
    return rows.map(toGrant);
  }

  /** Revoga um grant DA CONTA. `false` = não existe, é de outra conta ou já revogado. */
  async revokeGrant(accountId: string, id: string, at: Date): Promise<boolean> {
    const result = await this.conn()
      .from(GRANT_TABLE)
      .where('id', id)
      .where('account_id', accountId)
      .whereNull('revoked_at')
      .update({ revoked_at: at, updated_at: at });
    return affected(result) > 0;
  }

  async revokeAllGrants(accountId: string, at: Date): Promise<number> {
    const result = await this.conn()
      .from(GRANT_TABLE)
      .where('account_id', accountId)
      .whereNull('revoked_at')
      .update({ revoked_at: at, updated_at: at });
    return affected(result);
  }

  /** Revoga um grant sem checar a conta — reação a reuso de refresh token. */
  async revokeGrantById(id: string, at: Date): Promise<void> {
    await this.conn()
      .from(GRANT_TABLE)
      .where('id', id)
      .whereNull('revoked_at')
      .update({ revoked_at: at, updated_at: at });
  }

  // ─── refresh tokens ───────────────────────────────────────────────────────

  async insertRefreshToken(row: {
    tokenHash: string;
    grantId: string;
    expiresAt: Date;
    createdAt: Date;
  }) {
    await this.conn().table(REFRESH_TABLE).insert({
      token_hash: row.tokenHash,
      grant_id: row.grantId,
      expires_at: row.expiresAt,
      created_at: row.createdAt,
    });
  }

  async findRefreshToken(
    tokenHash: string,
  ): Promise<{ grantId: string; expiresAt: Date; usedAt: Date | null } | null> {
    const row = await this.conn().from(REFRESH_TABLE).where('token_hash', tokenHash).first();
    return row
      ? {
          grantId: row.grant_id,
          expiresAt: toDate(row.expires_at),
          usedAt: toDateOrNull(row.used_at),
        }
      : null;
  }

  /** Marca o refresh como usado (uso único, atômico). `false` = já tinha sido usado. */
  async useRefreshToken(tokenHash: string, at: Date): Promise<boolean> {
    const result = await this.conn()
      .from(REFRESH_TABLE)
      .where('token_hash', tokenHash)
      .whereNull('used_at')
      .update({ used_at: at });
    return affected(result) > 0;
  }
}
