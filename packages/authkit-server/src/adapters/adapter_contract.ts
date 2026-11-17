/** Forma mínima do payload persistido pelo oidc-provider. */
export interface OidcPayload {
  [key: string]: unknown;
  grantId?: string;
  userCode?: string;
  uid?: string;
  consumed?: unknown;
}

/** Um client OIDC enumerado do adapter (id + payload de metadata persistido). */
export interface EnumeratedClient {
  clientId: string;
  payload: Record<string, unknown>;
}

/** Um artefato OIDC enumerado de um model qualquer (id + payload persistido). */
export interface EnumeratedArtifact {
  id: string;
  payload: Record<string, unknown>;
}

/** Posição em {@link OidcAdapter.listRecent}: o `expires_at` (epoch ms) e o id da última linha lida. */
export interface RecentPosition {
  expiresAt: number;
  id: string;
}

/** Contrato que o oidc-provider espera de um adapter (um por model). */
export interface OidcAdapter {
  upsert(id: string, payload: OidcPayload, expiresIn: number): Promise<void>;
  find(id: string): Promise<OidcPayload | undefined>;
  findByUserCode(userCode: string): Promise<OidcPayload | undefined>;
  findByUid(uid: string): Promise<OidcPayload | undefined>;
  consume(id: string): Promise<void>;
  destroy(id: string): Promise<void>;
  /** Extend an existing remembered Session atomically; never recreate revoked records. */
  renewSession?(id: string, expiresIn: number): Promise<boolean>;
  revokeByGrantId(grantId: string): Promise<void>;
  /**
   * Enumeração GENÉRICA dos artefatos do model deste adapter (id + payload). Usada
   * pelo console admin para listar `Client` (CRUD) e `Session`/`Grant`/tokens
   * (sessões ativas + revogação). Capacidade OPCIONAL (estilo `AuditSink.list`):
   * adapters que não conseguem enumerar de forma barata omitem o método e a UI
   * degrada graciosamente. O adapter já é escopado a UM model na construção
   * (`new AdapterClass(model)`), então não recebe parâmetro.
   */
  list?(): Promise<EnumeratedArtifact[]>;
  /**
   * Artefatos vivos deste model cujo `payload.accountId` é `accountId` — o mesmo
   * resultado de `list()` filtrado pela conta, sem enumerar as outras contas.
   * OPCIONAL: ausente, os consumidores caem em `list()` + filtro. Tem de ser completo
   * (a revogação confia nele): um artefato que fique de fora continua valendo.
   */
  listByAccount?(accountId: string): Promise<EnumeratedArtifact[]>;
  /**
   * Artefatos vivos deste model cujo `payload.grantId` está em `grantIds` — o
   * mesmo resultado de `list()` filtrado pelos grants. OPCIONAL, como `listByAccount`.
   */
  listByGrantIds?(grantIds: string[]): Promise<EnumeratedArtifact[]>;
  /**
   * Artefatos vivos deste model, os de expiração mais distante primeiro — `(expires_at, id)`
   * decrescente, que para uma sessão é a atividade mais recente (cada gravação renova o TTL) —,
   * no máximo `limit`, estritamente depois de `after`. Uma página por vez, sem carregar o model
   * inteiro: o que o console lista. OPCIONAL: sem ele o console carrega `list()` (limitado).
   * Artefatos sem expiração ficam de fora.
   */
  listRecent?(query: {
    limit: number;
    after?: RecentPosition;
  }): Promise<Array<EnumeratedArtifact & { expiresAt: number }>>;
  /**
   * Apaga (ou só conta, com `dryRun`) os artefatos EXPIRADOS deste model. OPCIONAL: um adapter
   * cujo backend já expira sozinho (Redis, com TTL) omite — não há o que apagar.
   */
  purgeExpired?(options?: { dryRun?: boolean }): Promise<number>;
}
