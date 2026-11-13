/**
 * Tipos do cliente tipado AuthKit.
 *
 * Espelham os DTOs do servidor SEM importar nada do pacote server — o pacote
 * front-end é completamente desacoplado. Cada tipo é derivado da inspeção dos
 * controllers/DTOs do authkit-server.
 */

import type { CursorPageResponse, OffsetPage } from '@adonis-agora/filter-client';

export type {
  CursorPageMeta,
  CursorPageResponse,
  OffsetPage,
  OffsetPageMeta,
} from '@adonis-agora/filter-client';

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

/** Envelope de erro retornado pelo servidor. */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Admin – Usuários
// ---------------------------------------------------------------------------

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  globalRoles: string[];
  /**
   * Papéis efetivos (mesma fonte do claim `roles`). Igual a `globalRoles` sem
   * `resolveTokenRoles`; com ele, vem da fonte do app (ex.: authz).
   */
  roles?: string[];
  disabled: boolean;
  /** Apenas em create: indica se o usuário foi convidado via e-mail. */
  invited?: boolean;
}

/** Offset paging, search and sort of the console lists (users, clients, orgs, sessions). */
export interface AdminListParams {
  /** Free-text search (what it matches depends on the list). */
  search?: string;
  /** Sort, `-field` for descending: `'-loginTs'`, `'name'`. */
  sort?: string;
  /** 1-based page. Default 1. */
  page?: number;
  /** Page size. Default 20, at most 200. */
  size?: number;
}

/** Cursor paging of a feed (the audit log). */
export interface CursorListParams {
  /** `meta.nextCursor` of a page → the next (older) page. */
  after?: string;
  /** `meta.prevCursor` of a page → the previous (newer) page. */
  before?: string;
  /** Page size going forward. Default 20, at most 200. */
  first?: number;
  /** Page size going backward. Default 20, at most 200. */
  last?: number;
}

/** A page of users (`GET {base}/users`). */
export type AdminUserListResult = OffsetPage<AdminUser>;

export interface CreateUserInput {
  email: string;
  name?: string;
  password?: string;
  invite?: boolean;
}

/** The console's user update sets the global roles; name and avatar are the user's own. */
export interface UpdateUserInput {
  globalRoles?: string[];
}

export interface AdminSessionEntry {
  id: string;
  accountId: string;
  /** Email da conta — presente na listagem global (sem accountId). */
  email: string | null;
  loginTs: string | null;
  amr: string[];
  userAgent: string | null;
  browser: string | null;
  os: string | null;
  ip: string | null;
  location: string | null;
}

export interface AdminGrantEntry {
  id: string;
  accountId: string;
  clientId: string | null;
  accessTokens: number;
  refreshTokens: number;
}

/** Sessions and grants of one user (`GET {base}/users/:id/sessions`). */
export interface UserSessionsResult {
  supported: boolean;
  truncated?: boolean;
  sessions: AdminSessionEntry[];
  grants: AdminGrantEntry[];
}

/** `GET {base}/sessions`: `filter[accountId]`, `search` (email or IP), `sort` `loginTs`/`email`. */
export interface AdminSessionListParams extends AdminListParams {
  accountId?: string;
}

/**
 * A page of active sessions. `truncated`: the global listing hit its cap. `grants`: the
 * account's grants when filtered by `accountId` (`[]` otherwise).
 */
export interface AdminSessionListResult extends OffsetPage<AdminSessionEntry> {
  supported: boolean;
  truncated: boolean;
  grants: AdminGrantEntry[];
}

export interface RevokeSessionsResult {
  revoked?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Admin – Sessões
// ---------------------------------------------------------------------------

export interface AdminSessionListResult {
  canList: boolean;
  sessions: AdminSessionEntry[];
  grants: AdminGrantEntry[];
}

// ---------------------------------------------------------------------------
// Admin – Clients OIDC
// ---------------------------------------------------------------------------

export interface AdminClient {
  clientId: string;
  confidential: boolean;
  grantTypes: string[];
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  tokenEndpointAuthMethod: string;
  /** `'native'` = app mobile/desktop (RFC 8252). Ausente em servidores antigos (= `'web'`). */
  applicationType?: 'web' | 'native';
  backchannelLogoutUri: string | null;
  backchannelLogoutSessionRequired: boolean;
  /** Registered `client_name`, or `null`. */
  clientName: string | null;
  /** Registered `logo_uri`, or `null`. */
  logoUri: string | null;
  /** Disabled clients get no tokens. Absent on older servers (= `false`). */
  disabled?: boolean;
  /** Service-tenant settings, or `null` for a regular client. Absent on older servers. */
  serviceTenant?: ServiceTenantSettings | null;
}

/** A service tenant: `client_credentials` tokens carrying `partition` (and `capabilities`). */
export interface ServiceTenantSettings {
  partition: string;
  capabilities: string[];
}

/** A page of clients; `canList` is `false` when the adapter cannot enumerate them. */
export interface AdminClientListResult extends OffsetPage<AdminClient> {
  canList: boolean;
}

export interface CreatedClientResult {
  clientId: string;
  clientSecret: string | null;
}

export interface RegenerateSecretResult {
  clientId: string;
  clientSecret: string;
}

export interface CreateClientInput {
  clientId?: string;
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  grantTypes?: string[];
  tokenEndpointAuthMethod?: string;
  /** `'native'` (RFC 8252) aceita redirect de esquema privado/loopback e é sempre público. */
  applicationType?: 'web' | 'native';
  backchannelLogoutUri?: string;
  backchannelLogoutSessionRequired?: boolean;
  clientName?: string;
  logoUri?: string;
  /** Makes it a service tenant (confidential, `client_credentials` only, no redirect URIs). */
  serviceTenant?: { partition: string; capabilities?: string[] };
}

/**
 * Like {@link CreateClientInput}; `null` removes `backchannelLogoutUri`, `clientName` or
 * `logoUri`, and turns a service tenant back into a regular client.
 */
export type UpdateClientInput = Omit<
  CreateClientInput,
  'backchannelLogoutUri' | 'clientName' | 'logoUri' | 'serviceTenant'
> & {
  backchannelLogoutUri?: string | null;
  clientName?: string | null;
  logoUri?: string | null;
  serviceTenant?: { partition: string; capabilities?: string[] } | null;
};

// ---------------------------------------------------------------------------
// Admin – Roles
// ---------------------------------------------------------------------------

export interface RoleCatalogEntry {
  name: string;
  description?: string;
}

export interface RoleListResult {
  data: RoleCatalogEntry[];
}

export interface CreateRoleInput {
  name: string;
  description?: string;
}

export interface UpdateRoleInput {
  description?: string;
}

// ---------------------------------------------------------------------------
// Admin – Organizações
// ---------------------------------------------------------------------------

export interface AdminOrgEntry {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  metadata: unknown | null;
  createdAt: string;
  memberCount?: number;
}

export interface AdminOrgMember {
  accountId: string;
  email: string | null;
  role: string;
  joinedAt: string;
}

export interface AdminOrgInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  invitedBy: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

export interface AdminOrgDetail extends AdminOrgEntry {
  members: AdminOrgMember[];
  pendingInvitations: AdminOrgInvitation[];
}

/** A page of organizations, with member counts. */
export type AdminOrgListResult = OffsetPage<AdminOrgEntry>;

export interface CreateOrgInput {
  name: string;
  slug: string;
  ownerAccountId: string;
  logoUrl?: string | null;
}

export interface UpdateOrgInput {
  name?: string;
  logoUrl?: string | null;
}

// ---------------------------------------------------------------------------
// Admin – Auditoria
// ---------------------------------------------------------------------------

export interface AuditEventEntry {
  id: string;
  type: string;
  accountId: string | null;
  email: string | null;
  clientId: string | null;
  actorId: string | null;
  ip: string | null;
  metadata: unknown | null;
  createdAt: string;
}

/** A page of the audit log, newest first. */
export type AuditListResult = CursorPageResponse<AuditEventEntry>;

/** `GET {base}/audit`: `filter[type]`, `filter[subject]` and the cursor params. */
export interface AuditListParams extends CursorListParams {
  type?: string | string[];
  subject?: string;
}

// ---------------------------------------------------------------------------
// Admin – Settings
// ---------------------------------------------------------------------------

export interface SettingEntry {
  key: string;
  /** null = setting global; uuid = setting escopada a uma organização */
  organizationId: string | null;
  value: unknown;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SettingListResult {
  data: SettingEntry[];
  /** Keys locked by `defineConfig` (read-only at runtime). */
  locked: string[];
}

/** Response of a delete (`users.remove`, `clients.remove`). */
export interface DeletedResult {
  ok: true;
  deleted: string;
}

/** Response of `users.resetPassword`: the reset e-mail went to `email`. */
export interface ResetPasswordResult {
  ok: true;
  email: string;
}

// ---------------------------------------------------------------------------
// Admin – Impersonation
// ---------------------------------------------------------------------------

/**
 * Parâmetros RFC 8693 que o console devolve para o admin assumir a identidade de
 * um usuário. NÃO é uma sessão pronta e NÃO carrega URL de redirect: o exchange
 * exige um access token do próprio admin como `subject_token`, coisa que o
 * console (autenticado por sessão) não tem. A UI mostra os parâmetros e o curl.
 *
 * FECHADO de propósito. O `[key: string]: unknown` que existia aqui deixava
 * `panel.url` type-checkar contra um campo que o servidor nunca devolveu — e foi
 * exatamente assim que o botão "Impersonate" abriu `about:blank` por releases a
 * fio, sem um único erro de compilação.
 */
export interface ImpersonationPanel {
  targetUserId: string;
  targetEmail: string;
  /** Client habilitado ao grant token-exchange usado no exemplo. */
  clientId: string;
  tokenEndpoint: string;
  grantType: string;
  subjectTokenType: string;
  requestedSubject: string;
  /** Comando curl pronto (o `subject_token` fica como placeholder). */
  curl: string;
}

// ---------------------------------------------------------------------------
// Admin – Overview (stats)
// ---------------------------------------------------------------------------

export interface DailyPoint {
  date: string;
  count: number;
}

export interface AdminOverview {
  usersTotal: number;
  activeSessions: number | null;
  mau: number;
  signInsTotal: number;
  signUpsTotal: number;
  signInsPerDay: DailyPoint[];
  signUpsPerDay: DailyPoint[];
  windowDays: number;
  auditSupported: boolean;
  clientsCount: number;
  /** `null` when the audit sink cannot count. */
  auditTotal: number | null;
  recentEvents: AuditEventEntry[];
}

// ---------------------------------------------------------------------------
// Account – Me / Security
// ---------------------------------------------------------------------------

export interface AccountCapabilities {
  securitySupported: boolean;
  profileSupported: boolean;
  passkeysSupported: boolean;
  orgsSupported: boolean;
  tokensSupported: boolean;
  avatarUploadSupported: boolean;
  sessionsSupported: boolean;
}

export interface AccountMe {
  id: string;
  email: string;
  emailVerified: boolean | null;
  name: string | null;
  avatarUrl: string | null;
  globalRoles: string[];
  hasPassword: boolean;
  mfaEnabled: boolean;
  passkeyCount: number;
  sudoActive: boolean;
  capabilities: AccountCapabilities;
}

export interface AccountSessionEntry {
  id: string;
  loginTs: string | null;
  browser: string | null;
  os: string | null;
  ip: string | null;
  location: string | null;
  amr: string[];
}

export interface AccountSecurityOverview {
  email: string;
  pendingEmail: string | null;
  securitySupported: boolean;
  profileSupported: boolean;
  sessionsSupported: boolean;
  activeSessions: AccountSessionEntry[];
  mfa: {
    enabled: boolean;
    totpEnrolled: boolean;
    passkeyCount: number;
    passkeysSupported: boolean;
  };
}

// ---------------------------------------------------------------------------
// Account – Login methods (preferência por usuário de tipos de login)
// ---------------------------------------------------------------------------

/** Métodos que o usuário pode ligar/desligar para a própria conta. */
export interface UserLoginMethodsInput {
  password?: boolean;
  magicLink?: boolean;
  passkey?: boolean;
  social?: boolean;
}

export interface AccountLoginMethodsResult {
  /** false quando o store não suporta a preferência (feature no-op). */
  supported: boolean;
  /** Preferência crua do usuário; null = sem preferência (herda globais). */
  methods: UserLoginMethodsInput | null;
  /** Estado final por método (global ∩ preferência) — o que a tela mostra. */
  available: {
    password: boolean;
    magicLink: boolean;
    passkey: boolean;
    social: string[];
    forgotPassword: boolean;
  } | null;
  /**
   * Métodos fora do controle do usuário (globalmente indisponíveis ou fixados
   * no config do host).
   */
  locked: {
    password: boolean;
    magicLink: boolean;
    passkey: boolean;
    social: boolean;
  } | null;
}

export interface UpdateLoginMethodsResult {
  ok: boolean;
  methods: UserLoginMethodsInput;
}

// ---------------------------------------------------------------------------
// Account – Sessões
// ---------------------------------------------------------------------------

export interface AccountSessionsResult {
  supported: boolean;
  sessions: AccountSessionEntry[];
}

export interface RevokeSessionResult {
  ok: boolean;
  revoked: string;
}

export interface RevokeOthersResult {
  ok: boolean;
  [key: string]: unknown;
}

export interface RevokeAllResult {
  ok: boolean;
  /** true quando a sessão Adonis do console também foi encerrada (logout global) */
  signedOut: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Account – Apps / Grants
// ---------------------------------------------------------------------------

export interface AccountAppEntry {
  clientId: string;
  /** The client's registered `client_name`, or its `clientId`. */
  name: string;
  /** The client's registered `logo_uri`, or `null`. */
  logoUrl: string | null;
  accessTokens: number;
  refreshTokens: number;
}

export interface AccountAppsResult {
  supported: boolean;
  apps: AccountAppEntry[];
}

// ---------------------------------------------------------------------------
// Account – Personal agents
// ---------------------------------------------------------------------------

/** A personal agent's live delegation on the account (`GET /account/api/agents`). */
export interface AccountAgentGrant {
  id: string;
  clientId: string;
  /** Which personal-agent protocol granted it: `'pact'` or a `personalAgents.extensions` id. */
  protocol: PersonalAgentProtocol;
  scopes: Array<{ id: string; description: string }>;
  /** ISO dates, as the JSON API serializes them. */
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface AccountAgentsResult {
  agents: AccountAgentGrant[];
}

export interface RevokeAppResult {
  ok: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Account – MFA
// ---------------------------------------------------------------------------

export interface PasskeySummaryEntry {
  id: string;
  label: string | null;
  createdAt: string | null;
}

export interface AccountMfaStatus {
  enabled: boolean;
  totp: { enrolled: boolean };
  passkeys: {
    supported: boolean;
    count: number;
    items: PasskeySummaryEntry[];
  };
  recovery: {
    available: boolean;
    /**
     * Quantos recovery codes ainda não foram consumidos. `null` quando o store
     * não sabe contar (capacidade opcional) — DIFERENTE de `0`, que significa
     * "acabaram, gere novos".
     */
    remaining: number | null;
    /** `true` quando o store sabe regenerar — o host só mostra o botão se houver como. */
    regenerable: boolean;
  };
}

// ---------------------------------------------------------------------------
// Account – MFA (escrita headless: TOTP + recovery codes + passkey)
// ---------------------------------------------------------------------------

/** Enrolamento TOTP iniciado. O segredo só sai AQUI — depois só o hash fica. */
export interface MfaEnrollResult {
  secret: string;
  otpauthUri: string;
  /** O mesmo `otpauthUri` já renderizado como QR (data-URL PNG), pronto para `<img src>`. */
  qrDataUrl: string;
}

/**
 * Enrolamento confirmado. `recoveryCodes` vem em claro UMA ÚNICA vez — o
 * servidor guarda só o hash, e nenhuma leitura posterior os devolve.
 */
export interface MfaConfirmResult {
  ok: boolean;
  enabled: boolean;
  recoveryCodes: string[];
}

export interface MfaDisableResult {
  ok: boolean;
  enabled: boolean;
}

/** Recovery codes regenerados — também em claro uma única vez. */
export interface MfaRecoveryCodesResult {
  ok: boolean;
  recoveryCodes: string[];
}

/**
 * `PublicKeyCredentialCreationOptions` serializadas (o que `startRegistration()`
 * do `@simplewebauthn/browser` espera). Opaco de propósito: o formato é do
 * WebAuthn, não do AuthKit.
 */
export type PasskeyRegistrationOptions = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Account – Passkeys
// ---------------------------------------------------------------------------

export interface AccountPasskeysResult {
  supported: boolean;
  passkeys: PasskeySummaryEntry[];
}

export interface RemovePasskeyResult {
  ok: boolean;
  removed: string;
}

// ---------------------------------------------------------------------------
// Account – Tokens (PAT)
// ---------------------------------------------------------------------------

export interface PatEntry {
  id: string;
  name: string;
  scopes: string[];
  audience: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreatedPatResult extends PatEntry {
  /** Mostrado apenas uma vez. */
  secret: string;
}

export interface AccountTokensResult {
  supported: boolean;
  tokens: PatEntry[];
}

export interface CreateTokenInput {
  name?: string;
}

export interface RevokeTokenResult {
  ok: boolean;
  revoked: string;
}

// ---------------------------------------------------------------------------
// Account – Perfil
// ---------------------------------------------------------------------------

export interface UpdateProfileInput {
  name?: string | null;
  avatarUrl?: string | null;
}

export interface UpdateProfileResult {
  id: string;
  name: string | null;
  avatarUrl: string | null;
}

// ---------------------------------------------------------------------------
// Account – Senha / E-mail
// ---------------------------------------------------------------------------

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface RequestEmailChangeInput {
  newEmail: string;
  currentPassword?: string;
}

export interface OkResult {
  ok: boolean;
}

export interface EmailChangeResult {
  ok: boolean;
  email: string;
}

// ---------------------------------------------------------------------------
// Account – Organizações
// ---------------------------------------------------------------------------

export interface AccountOrgEntry {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  role: string;
  isActive: boolean;
}

export interface AccountOrgsResult {
  supported: boolean;
  activeOrgId: string | null;
  orgs: AccountOrgEntry[];
}

export interface AccountOrgDetail {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  role: string;
  canManage: boolean;
  members: Array<{
    accountId: string;
    email: string | null;
    role: string;
    joinedAt: string;
  }>;
}

export interface AccountOrgInvitationsResult {
  supported: boolean;
  invitations: Array<{
    id: string;
    organizationId: string;
    orgName: string;
    orgSlug: string;
    email: string;
    role: string;
    expiresAt: string;
    createdAt: string;
  }>;
}

// ---------------------------------------------------------------------------
// Account – Orgs (escrita headless)
// ---------------------------------------------------------------------------

export interface CreateAccountOrgInput {
  name: string;
  slug: string;
}

/** Org recém-criada. Quem cria entra como `owner`. */
export interface CreatedAccountOrgResult {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  role: string;
}

export interface ActivateOrgResult {
  ok: boolean;
  activeOrgId: string;
  slug: string;
  role: string;
}

export interface DeactivateOrgResult {
  ok: boolean;
  activeOrgId: null;
}

export interface LeaveOrgResult {
  ok: boolean;
  orgId: string;
}

export interface InviteOrgMemberInput {
  email: string;
  role?: string;
}

/**
 * Convite criado. O TOKEN DE ACEITE NÃO VOLTA: ele é a credencial que viaja por
 * e-mail, e um admin que o lesse aqui entraria na org como o convidado.
 */
export interface CreatedOrgInvitationResult {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  expiresAt: string | null;
  createdAt: string | null;
}

export interface RevokeOrgInvitationResult {
  ok: boolean;
  revoked: string;
}

export interface UpdateOrgMemberRoleResult {
  ok: boolean;
  orgId: string;
  accountId: string;
  role: string;
}

export interface RemoveOrgMemberResult {
  ok: boolean;
  orgId: string;
  accountId: string;
}

export interface AcceptOrgInvitationResult {
  ok: boolean;
  organizationId: string;
  role: string;
}

// ---------------------------------------------------------------------------
// Admin — Key rotation (JWKS signing keys)
// ---------------------------------------------------------------------------

/** Info pública de uma chave de assinatura managed (sem material privado). */
export interface ManagedKeyInfo {
  kid: string;
  alg: string;
  ageDays: number;
  /** true para a chave de assinatura corrente. */
  active: boolean;
}

/** Status da chave de assinatura managed (GET {base}/keys). */
export interface KeysStatus {
  ageDays: number;
  policy: { enabled: boolean; maxAgeDays: number; keep: number };
  nextRotationInDays: number | null;
  keys: ManagedKeyInfo[];
}

/** Body de POST {base}/keys/rotate. */
export interface KeysRotateInput {
  retire?: boolean;
  keep?: number;
}

/** Resultado de uma rotação. */
export interface KeysRotateResult {
  rotated: true;
  newKid: string;
  retiredKids: string[];
  keptKids: string[];
}

// ---------------------------------------------------------------------------
// Admin — Personal agents (PACT e `personalAgents.extensions`)
// ---------------------------------------------------------------------------

/** `'pact'` ou o id de uma extension (`personalAgents.extensions`). */
export type PersonalAgentProtocol = 'pact' | (string & {});
export type PersonalAgentListStatus = 'allowed' | 'blocked';

/** Um agente no console: o que o config e o console dizem, e quantas contas conectadas. */
export interface PersonalAgentEntry {
  protocol: PersonalAgentProtocol;
  /** PACT: o `iss`. Extensions: o identificador do agente no protocolo delas. */
  identifier: string;
  name: string;
  /** O que o `defineConfig` diz (só listas estáticas); `null` = nada. */
  config: PersonalAgentListStatus | null;
  /** O que o console diz; `null` = nada. */
  console: {
    id: string;
    status: PersonalAgentListStatus;
    updatedAt: string;
    updatedBy: string | null;
  } | null;
  /** Bloqueado em qualquer lado vence; senão liberado em qualquer lado; senão `unlisted`. */
  effective: PersonalAgentListStatus | 'unlisted';
  jwksUri: string | null;
  connections: number;
}

/** GET {base}/personal-agents */
export interface PersonalAgentsOverview {
  /** `pact`, e uma entrada por extension ligada (pelo id dela). */
  protocols: {
    pact: PersonalAgentPactOverview | null;
    [protocol: string]: PersonalAgentPactOverview | PersonalAgentExtensionOverview | null;
  };
  agents: PersonalAgentEntry[];
}

export interface PersonalAgentPactOverview {
  open: boolean;
  hostResolver: boolean;
}

/** Uma `personalAgents.extensions` no console. */
export interface PersonalAgentExtensionOverview {
  /** Nome do protocolo (`'Poppy'`). */
  label: string;
  /** Só agentes listados conectam. */
  requireRegistration: boolean;
  /** Parte da lista vem de uma função do host (o console não enxerga). */
  hostResolver: boolean;
  /** Identificadores `http://` aceitos (só desenvolvimento). */
  allowHttpIdentifiers: boolean;
  /** Rótulo do campo do identificador. */
  identifierLabel: string;
  identifierPlaceholder: string | null;
}

/** Uma conexão (grant vivo) de um usuário com um agente. */
export interface PersonalAgentConnection {
  id: string;
  protocol: PersonalAgentProtocol;
  clientId: string;
  agentName: string;
  accountId: string;
  accountEmail: string | null;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface PersonalAgentConnectionsParams {
  protocol?: PersonalAgentProtocol;
  clientId?: string;
  accountId?: string;
  page?: number;
  size?: number;
}

/** A page of live connections, newest first. */
export type PersonalAgentConnectionsResult = OffsetPage<PersonalAgentConnection>;

/** Body de POST {base}/personal-agents/registry. */
export interface PersonalAgentRegistryInput {
  protocol: PersonalAgentProtocol;
  identifier: string;
  status: PersonalAgentListStatus;
  name?: string;
  /** Obrigatório para liberar um agente PACT. */
  jwksUri?: string;
}

export interface PersonalAgentRegistryResult {
  entry: {
    id: string;
    protocol: PersonalAgentProtocol;
    identifier: string;
    status: PersonalAgentListStatus;
    name: string | null;
    jwksUri: string | null;
    updatedAt: string;
  };
  /** Conexões cortadas (bloqueio). */
  disconnected: number;
}
