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
}
