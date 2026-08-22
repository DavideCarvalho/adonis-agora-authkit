/**
 * Tipos do cliente tipado AuthKit.
 *
 * Espelham os DTOs do servidor SEM importar nada do pacote server — o pacote
 * front-end é completamente desacoplado. Cada tipo é derivado da inspeção dos
 * controllers/DTOs do authkit-server.
 */

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
  disabled: boolean;
  /** Apenas em create: indica se o usuário foi convidado via e-mail. */
  invited?: boolean;
}

export interface AdminUserListResult {
  data: AdminUser[];
  total: number;
  page: number;
  limit: number;
}

export interface CreateUserInput {
  email: string;
  name?: string | null;
  password?: string | null;
  invite?: boolean;
}

export interface UpdateUserInput {
  globalRoles?: string[];
  name?: string | null;
  avatarUrl?: string | null;
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

export interface UserSessionsResult {
  supported: boolean;
  /** true quando o número de sessões foi truncado ao limite máximo da listagem global. */
  truncated?: boolean;
  sessions: AdminSessionEntry[];
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
  grants: string[];
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  tokenEndpointAuthMethod: string;
  backchannelLogoutUri: string | null;
  backchannelLogoutSessionRequired: boolean;
}

export interface AdminClientListResult {
  data: AdminClient[];
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
  backchannelLogoutUri?: string;
  backchannelLogoutSessionRequired?: boolean;
}

export type UpdateClientInput = CreateClientInput;

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

export interface AdminOrgListResult {
  data: AdminOrgEntry[];
}

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

export interface AuditListResult {
  data: AuditEventEntry[];
  total: number;
  page: number;
  limit: number;
}

export interface AuditListParams {
  type?: string;
  page?: number;
  limit?: number;
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
  auditTotal: number;
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
  accessTokens: number;
  refreshTokens: number;
}

export interface AccountAppsResult {
  supported: boolean;
  apps: AccountAppEntry[];
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
  recovery: { available: boolean };
}

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
