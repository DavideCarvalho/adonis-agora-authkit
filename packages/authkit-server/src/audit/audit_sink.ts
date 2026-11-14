/**
 * Tipos de eventos de auditoria emitidos pelo IdP, como VALOR em runtime.
 *
 * A união {@link AuditEventType} é DERIVADA desta lista, e não escrita à mão,
 * porque uma união escrita à mão não tem como ser conferida contra o que o
 * código de fato emite — foi assim que cinco eventos passaram a existir sem
 * estar no tipo. Com a lista em runtime, `tests/audit/audit_event_drift.spec.ts`
 * varre os `audit.record({ type: ... })` do `src/` e falha quando um evento
 * emitido não está aqui.
 */
export const AUDIT_EVENT_TYPES = [
  'login.success',
  'login.failure',
  'signup',
  'password_reset.issued',
  'password_reset.consumed',
  'pat.issued',
  'pat.revoked',
  'pat.used',
  // O exchange RFC 8693 de fato aconteceu: uma identidade foi assumida.
  'impersonation',
  // O admin abriu o painel do console e revelou os parâmetros do exchange.
  // NÃO é uma impersonação: nada foi assumido ainda, e o exchange pode nunca
  // acontecer. Manter os dois separados é o que impede a trilha de auditoria de
  // afirmar uma impersonação que só foi consultada.
  'impersonation.panel_viewed',
  // Uma impersonation foi encerrada no RP (`stopImpersonation`, com o
  // `impersonationId` no metadata). Fecha o par aberto pelo `impersonation`.
  'impersonation.stopped',
  'mfa.enabled',
  'mfa.disabled',
  // Os recovery codes foram TROCADOS: os antigos (inclusive os não usados)
  // deixaram de valer no mesmo instante. Evento próprio, e não `mfa.enabled`,
  // porque o fator não mudou — mudou o conjunto de credenciais de contorno.
  'mfa.recovery_codes_regenerated',
  'account.locked',
  'passkey.registered',
  'passkey.removed',
  'email_verification.issued',
  'email_verification.consumed',
  'client.created',
  'client.updated',
  'client.deleted',
  'session.revoked_all',
  'password.changed',
  'password.rehashed',
  'email.change_requested',
  'email.changed',
  'login.new_ip_notified',
  'login.new_device',
  // Login por OTP (código digitável)
  'login.otp_sent',
  'login.otp_verified',
  'login.otp_failed',
  'login.otp_invalidated',
  'bot_protection.rejected',
  'grant.revoked_by_user',
  'user.created',
  'user.password_reset_sent',
  'user.disabled',
  'user.enabled',
  'user.deleted',
  'profile.updated',
  'account.deleted',
  'account.exported',
  'keys.rotated',
  'organization.created',
  'organization.updated',
  'organization.deleted',
  'organization.member_added',
  'organization.member_removed',
  'organization.member_role_changed',
  'organization.member_role_updated',
  'organization.switched',
  'organization.deactivated',
  'organization.invitation_sent',
  'organization.invitation_accepted',
  'organization.invitation_revoked',
  // Email change (verified flow)
  'email_change.requested',
  'email_change.confirmed',
  'email_change.cancelled',
  // Security notices
  'security_notice.sent',
  // Settings
  'settings.updated',
  'maintenance.enabled',
  'maintenance.disabled',
  'trusted_device.revoked',
  // Password hygiene
  'password.expired_change_forced',
  // OTP lockout
  'otp.locked',
  'otp.unlocked',
  'otp.unlock_failed',
  // Sudo mode
  'sudo.confirmed',
  // Session
  'session.single_enforced',
  // Account expiration
  'account.expired_login_blocked',
  'account.expiration_warned',
  // Emitidos pelo host-kit e antes AUSENTES desta lista — o switch exaustivo
  // de um consumidor os perdia silenciosamente. Ver `audit_event_drift.spec.ts`,
  // que varre os call sites e falha se a divergência voltar.
  'login.magic_link_sent',
  'session.revoked',
  'account.signed_out_all',
  'client.secret_regenerated',
  // A client was disabled (no new tokens) or enabled again.
  'client.disabled',
  'client.enabled',
  // A service tenant got a token (`partition`, `resource`, `jti` in the metadata).
  'service_tenant.token_issued',
  'roles_catalog.updated',
  // Personal agents (PACT §5): o usuário aprovou/negou a delegação pedida por um
  // agente, ou revogou um grant no console. `clientId` = issuer do agente.
  'agent.delegation_approved',
  'agent.delegation_denied',
  'agent.grant_revoked',
  // Console admin: um admin revogou a conexão de um usuário, ou liberou/bloqueou um
  // agente (PACT pelo `iss`; uma extension pelo identificador dela).
  'agent.grant_revoked_by_admin',
  'agent.allowed',
  'agent.blocked',
  'agent.registry_removed',
  // Console de conta: uma action de extension mandou o usuário para fora do app
  // (`redirectTo.external`), ou uma action sensível (sudo/danger) rodou.
  'account.extension.redirect',
  'account.extension.action',
  // Um client foi revogado: desabilitado (quando tem cadastro) e grants/tokens de todas as contas cortados.
  'client.revoked',
  // Login de clientes MCP ligado/desligado pela setting `mcp_clients` (`from`/`to` no metadata).
  'mcp_clients.updated',
  // Chaves de assinatura: uma chave nova publicada sem assinar ainda, ou uma chave antiga retirada.
  'keys.generated',
  'keys.retired',
  // `node ace authkit:purge`: contagens do que foi apagado, por tipo.
  'oidc.purged',
] as const;

/** Tipos de eventos de auditoria relevantes para segurança emitidos pelo IdP. */
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/**
 * Evento de auditoria a registrar. O timestamp é definido pelo sink (não aqui).
 */
export interface AuditEvent {
  type: AuditEventType;
  accountId?: string | null;
  email?: string | null;
  clientId?: string | null;
  /** Impersonation: quem agiu (o admin). */
  actorId?: string | null;
  /**
   * Organização (tenant) a que o evento pertence, quando houver. Campo de
   * PRIMEIRA CLASSE — e não uma chave de `metadata` — de propósito: `metadata`
   * é livre e por isso é DROPADO na projeção que vai para o barramento de
   * diagnostics (ver `redactAuditEventForDiagnostics`), enquanto os ids internos
   * opacos (`accountId`/`actorId`/`clientId`/`orgId`) são preservados. É esse
   * campo que permite a um consumidor do barramento — p.ex. o provisioning do
   * `@adonis-agora/authz` — saber QUAL tenant provisionar sem receber PII.
   */
  orgId?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Evento de auditoria já persistido (lido de volta pelo console admin). Carrega
 * o id e o timestamp atribuídos pelo sink.
 */
export interface StoredAuditEvent extends AuditEvent {
  id: string;
  createdAt: Date | string | null;
}

/**
 * What {@link AuditSink.list} returns: one page of the log, NEWEST FIRST, read by cursor.
 *
 * The log is append-only and grows without bound, so it pages by an opaque cursor rather than
 * by page number: `after` = the `nextCursor` of the previous page (older events), `before` =
 * the `prevCursor` of a page (newer events). The cursor's content is the sink's business; the
 * caller hands back what the sink returned.
 */
export interface ListAuditParams {
  /** Only events of this type (or of any of these types). */
  type?: string | readonly string[];
  /** Only events about this account (`accountId`). */
  subject?: string;
  /** Events per page. Default 20. */
  size?: number;
  /** The page after this cursor (older events). Wins over `before`. */
  after?: string;
  /** The page before this cursor (newer events). */
  before?: string;
}

/** The filters of {@link AuditSink.count}. */
export type CountAuditParams = Pick<ListAuditParams, 'type' | 'subject'>;

/** One page of events, newest first, and the cursors around it. */
export interface AuditPage {
  data: StoredAuditEvent[];
  /** Cursor of the next (older) page, `null` on the last one. */
  nextCursor: string | null;
  /** Cursor of the previous (newer) page, `null` on the first one. */
  prevCursor: string | null;
  hasNext: boolean;
  hasPrev: boolean;
}

/**
 * Sink plugável de auditoria. Implementações devem ser best-effort: `record`
 * NUNCA deve lançar para dentro do caminho da request.
 *
 * `list` é OPCIONAL: sinks customizados podem só implementar `record` (write-only).
 * O console admin degrada graciosamente ("consulta não suportada") quando o sink
 * configurado não fornece `list`.
 */
export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
  /** One page of events, newest first (optional: only sinks that can be queried). */
  list?(params: ListAuditParams): Promise<AuditPage>;
  /** How many events match (optional; the admin overview shows it when present). */
  count?(params: CountAuditParams): Promise<number>;
  /**
   * Anonimiza (LGPD/GDPR) os eventos de uma conta SEM apagar o histórico: remove
   * os identificadores pessoais (`email`, `ip`) e re-escreve o `accountId` para um
   * pseudônimo estável (`anon:<hash>`), preservando a linha do tempo, o `type` e a
   * forma para auditoria/forense. OPCIONAL: sinks write-only podem omitir — a
   * deleção de conta segue funcionando (best-effort), só não anonimiza.
   * Retorna a quantidade de linhas afetadas.
   */
  anonymizeAccount?(accountId: string): Promise<number>;
}
