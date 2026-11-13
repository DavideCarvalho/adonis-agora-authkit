/**
 * SDK-owned types. We DELIBERATELY duplicate the DTO shapes returned by the
 * Admin REST API (`packages/authkit-server/.../admin_api/dto.ts`) rather than
 * importing them from `@adonis-agora/authkit-server`, so that remote-only
 * consumers can install JUST this package with ZERO dependency on the server
 * kit. The embedded driver maps the server's runtime values into these exact
 * shapes — keep them in sync with the server DTOs.
 */

import type { CursorPageResponse, OffsetPage } from '@adonis-agora/filter-client';

export type {
  CursorPageMeta,
  CursorPageResponse,
  OffsetPage,
  OffsetPageMeta,
} from '@adonis-agora/filter-client';

/** First page — offset pagination is 1-based. */
export const LIST_FIRST_PAGE = 1;

/** Page size the server uses when a listing call omits `size` (or `first`/`last`). */
export const ADMIN_LIST_DEFAULT_SIZE = 20;

/** Largest page size the server accepts; bigger values are clamped. */
export const ADMIN_LIST_MAX_SIZE = 200;

/** Offset paging and sort shared by `users.list`, `clients.list` and `organizations.list`. */
export interface OffsetListParams {
  /** Free-text search (what it matches depends on the list). */
  search?: string;
  /** Sort, `-field` for descending: `'-createdAt'`, `'name,slug'`. */
  sort?: string;
  /** 1-based page. Default 1. */
  page?: number;
  /** Page size. Default 20, at most 200. */
  size?: number;
}

/** Cursor paging of the audit log (newest first). */
export interface CursorListParams {
  /** The `meta.nextCursor` of a page: returns the next (older) page. */
  after?: string;
  /** The `meta.prevCursor` of a page: returns the previous (newer) page. */
  before?: string;
  /** Page size when paging forward. Default 20, at most 200. */
  first?: number;
  /** Page size when paging backward. Default 20, at most 200. */
  last?: number;
}

/** A user/account as projected by the Admin API (`userDto`). */
export interface AuthkitUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  globalRoles: string[];
  disabled: boolean;
}

/** Result of `users.create` — the user plus whether an invite e-mail was sent. */
export interface AuthkitCreatedUser extends AuthkitUser {
  invited: boolean;
}

/** `users.list`: `search` matches the email; the list is sorted by email (`sort: 'email'`). */
export type ListUsersParams = OffsetListParams;

/** A page of users. */
export type ListUsersResult = OffsetPage<AuthkitUser>;

export interface CreateUserInput {
  email: string;
  name?: string | null;
  password?: string | null;
  /** When true (and no password), creates with a random password and sends an invite/reset e-mail. */
  invite?: boolean;
}

export interface UpdateUserInput {
  globalRoles?: string[];
  name?: string | null;
  avatarUrl?: string | null;
}

/** An active IdP session (`sessionDto`). */
export interface AuthkitSession {
  id: string;
  accountId: string;
  loginTs: number | null;
  amr: string[];
  /** Raw user-agent of the login (joined from the audit log). */
  userAgent: string | null;
  /** Browser family parsed from the user-agent (e.g. 'Chrome'). */
  browser: string | null;
  /** Operating system parsed from the user-agent (e.g. 'macOS'). */
  os: string | null;
  /** IP address of the login. */
  ip: string | null;
  /** Human-readable location resolved via the host `resolveGeo` hook (null without one). */
  location: string | null;
}

/** A grant with live token counts (`grantDto`). */
export interface AuthkitGrant {
  id: string;
  accountId: string;
  clientId: string | null;
  accessTokens: number;
  refreshTokens: number;
}

export interface ListSessionsResult {
  canList: boolean;
  sessions: AuthkitSession[];
  grants: AuthkitGrant[];
}

/** Counts returned by a bulk session/grant revocation. */
export interface RevokeSessionsResult {
  sessions: number;
  grants: number;
  accessTokens: number;
  refreshTokens: number;
}

/** An OIDC client as projected by the Admin API (`clientDto`). */
export interface AuthkitClient {
  clientId: string;
  confidential: boolean;
  grantTypes: string[];
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  tokenEndpointAuthMethod: string;
  /** Registered `client_name`, or `null`. */
  clientName: string | null;
  /** Registered `logo_uri`, or `null`. */
  logoUri: string | null;
  /** Disabled clients get no tokens until enabled again. */
  disabled: boolean;
  /** Service-tenant settings, or `null` for a regular client. */
  serviceTenant: { partition: string; capabilities: string[] } | null;
}

/** `clients.list`: `search` matches the client id or name; `sort` is `clientId` or `clientName`. */
export type ListClientsParams = OffsetListParams;

/** A page of clients. `canList` is `false` when the adapter cannot enumerate clients. */
export interface ListClientsResult extends OffsetPage<AuthkitClient> {
  canList: boolean;
}

export type TokenEndpointAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

export interface ClientInput {
  clientId?: string;
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  grantTypes?: string[];
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
  /**
   * Makes the client a service tenant (confidential, `client_credentials` only, no
   * redirect URIs). On update, `null` turns it back into a regular client.
   */
  serviceTenant?: { partition: string; capabilities?: string[] } | null;
}

/** Created/regenerated client — the secret is shown ONCE (`createdClientDto`). */
export interface AuthkitCreatedClient {
  clientId: string;
  clientSecret: string | null;
}

export interface RegeneratedSecret {
  clientId: string;
  clientSecret: string;
}

export interface DeletedClient {
  clientId: string;
  deleted: boolean;
}

/** An audit event (`auditDto`). */
export interface AuthkitAuditEvent {
  id: string | number;
  type: string;
  accountId: string | null;
  email: string | null;
  clientId: string | null;
  actorId: string | null;
  ip: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/** `audit.list`: newest first, by cursor. */
export interface ListAuditParams extends CursorListParams {
  /** Only events of this type, or of any of these types. */
  type?: string | string[];
  /** Only events about this account id. */
  subject?: string;
}

/** A page of audit events, newest first. */
export type ListAuditResult = CursorPageResponse<AuthkitAuditEvent>;

/** A daily series point (ISO `YYYY-MM-DD` day + count). */
export interface AuthkitDailyPoint {
  date: string;
  count: number;
}

/** IdP summary metrics (`computeAdminStats`). */
export interface AuthkitStats {
  totalUsers: number;
  /** Active sessions; null when the OIDC adapter does not enumerate. */
  activeSessions: number | null;
  /** Monthly Active Users: unique accounts with a login.success in the last 30 days. */
  mau: number;
  signInsPerDay: AuthkitDailyPoint[];
  signUpsPerDay: AuthkitDailyPoint[];
  signInsTotal: number;
  signUpsTotal: number;
  /** Whether the audit sink supports querying (series are empty when false). */
  auditSupported: boolean;
  windowDays: number;
}

/** Generic token introspection result (`VerifyResult`). */
export type VerifyTokenResult =
  | { active: false }
  | {
      active: true;
      tokenType: 'pat' | 'access_token';
      sub: string;
      email?: string | null;
      name?: string | null;
      roles?: string[];
      scopes?: string[];
      audience?: string | string[] | null;
      clientId?: string | null;
      exp?: number | null;
    };

/** Result of `users.disable`/`users.enable`. */
export interface UserStatusResult {
  id: string;
  disabled: boolean;
}

/** Result of `users.resetPassword`. */
export interface ResetPasswordResult {
  id: string;
  sent: boolean;
}

/**
 * Result of `users.delete` — the cascade counts of what was removed (sessions,
 * grants, tokens, PATs, passkeys, linked identities) plus how many audit rows were
 * anonymized (kept, not deleted) and whether the avatar was removed.
 */
export interface DeletedUser {
  id: string;
  deleted: boolean;
  sessions: number;
  grants: number;
  accessTokens: number;
  refreshTokens: number;
  pats: number;
  passkeys: number;
  providerIdentities: number;
  auditAnonymized: number;
  avatarDeleted: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Organizations
// ──────────────────────────────────────────────────────────────────────────

/** An organization as returned by the Admin API. */
export interface AuthkitOrganization {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  memberCount?: number;
}

/** An organization with full members and pending invitations (GET /:id). */
export interface AuthkitOrganizationDetail extends AuthkitOrganization {
  members: AuthkitOrgMember[];
  pendingInvitations: AuthkitOrgInvitation[];
}

export interface AuthkitOrgMember {
  accountId: string;
  email: string | null;
  role: string;
  joinedAt: string;
}

export interface AuthkitOrgInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  invitedBy: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

/**
 * `organizations.list`: `search` matches the name or slug; `sort` is `name`, `slug`,
 * `createdAt` or `memberCount`.
 */
export type ListOrganizationsParams = OffsetListParams;

/** A page of organizations, with their member counts. */
export type ListOrganizationsResult = OffsetPage<AuthkitOrganization>;

export interface CreateOrganizationInput {
  name: string;
  slug: string;
  ownerAccountId: string;
  logoUrl?: string | null;
}

export interface UpdateOrganizationInput {
  name?: string;
  logoUrl?: string | null;
}

export interface AddOrgMemberInput {
  accountId: string;
  role: string;
}

export interface CreateOrgInvitationInput {
  email: string;
  role: string;
}

export interface DeletedOrganization {
  id: string;
  deleted: boolean;
}

export interface AddedOrgMember {
  orgId: string;
  accountId: string;
  role: string;
  added: boolean;
}

export interface RemovedOrgMember {
  orgId: string;
  accountId: string;
  removed: boolean;
}

export interface UpdatedOrgMemberRole {
  orgId: string;
  accountId: string;
  role: string;
  updated: boolean;
}

export interface RevokedOrgInvitation {
  orgId: string;
  invitationId: string;
  revoked: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// Keys (keystore management)
// ──────────────────────────────────────────────────────────────────────────

/** Status of the managed signing key, returned by `keys.status()`. */
export interface KeysStatus {
  ageDays: number;
  policy: {
    enabled: boolean;
    maxAgeDays: number;
    keep: number;
  };
  nextRotationInDays: number | null;
}

/** Input for `keys.rotate()`. */
export interface KeysRotateInput {
  retire?: boolean;
  keep?: number;
}

/** Result of `keys.rotate()`. */
export interface KeysRotateResult {
  rotated: true;
  newKid: string;
  retiredKids: string[];
  keptKids: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// Runtime Settings
// ──────────────────────────────────────────────────────────────────────────

/** A runtime setting entry as projected by the Admin API. */
export interface AuthkitSetting {
  key: string;
  value: unknown;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface ListSettingsResult {
  data: AuthkitSetting[];
}

export interface DeletedSetting {
  key: string;
  deleted: boolean;
}

/** The shared SDK interface, implemented identically by both drivers. */
export interface Authkit {
  users: {
    list(params?: ListUsersParams): Promise<ListUsersResult>;
    get(id: string): Promise<AuthkitUser>;
    create(input: CreateUserInput): Promise<AuthkitCreatedUser>;
    update(id: string, input: UpdateUserInput): Promise<AuthkitUser>;
    disable(id: string): Promise<UserStatusResult>;
    enable(id: string): Promise<UserStatusResult>;
    resetPassword(id: string): Promise<ResetPasswordResult>;
    /** Permanently deletes a user and cascades all associated data (LGPD/GDPR). */
    delete(id: string): Promise<DeletedUser>;
  };
  sessions: {
    list(userId: string): Promise<ListSessionsResult>;
    revokeAll(userId: string): Promise<RevokeSessionsResult>;
  };
  clients: {
    list(params?: ListClientsParams): Promise<ListClientsResult>;
    get(id: string): Promise<AuthkitClient>;
    create(input: ClientInput): Promise<AuthkitCreatedClient>;
    update(id: string, input: ClientInput): Promise<AuthkitClient>;
    regenerateSecret(id: string): Promise<RegeneratedSecret>;
    /** Stops issuing tokens to the client (`invalid_client`) until `enable`. */
    disable(id: string): Promise<AuthkitClient>;
    enable(id: string): Promise<AuthkitClient>;
    delete(id: string): Promise<DeletedClient>;
  };
  audit: {
    list(params?: ListAuditParams): Promise<ListAuditResult>;
  };
  /** IdP summary metrics for dashboards (totals + MAU + 30-day series). */
  stats(): Promise<AuthkitStats>;
  tokens: {
    verify(token: string): Promise<VerifyTokenResult>;
  };
  organizations: {
    list(params?: ListOrganizationsParams): Promise<ListOrganizationsResult>;
    create(input: CreateOrganizationInput): Promise<AuthkitOrganization>;
    get(id: string): Promise<AuthkitOrganizationDetail>;
    update(id: string, input: UpdateOrganizationInput): Promise<AuthkitOrganization>;
    delete(id: string): Promise<DeletedOrganization>;
    members: {
      list(orgId: string): Promise<AuthkitOrgMember[]>;
      add(orgId: string, input: AddOrgMemberInput): Promise<AddedOrgMember>;
      remove(orgId: string, accountId: string): Promise<RemovedOrgMember>;
      updateRole(orgId: string, accountId: string, role: string): Promise<UpdatedOrgMemberRole>;
    };
    invitations: {
      create(orgId: string, input: CreateOrgInvitationInput): Promise<AuthkitOrgInvitation>;
      revoke(orgId: string, invitationId: string): Promise<RevokedOrgInvitation>;
    };
  };
  /** Runtime settings — CRUD for entries in `auth_settings` table. */
  settings: {
    list(): Promise<ListSettingsResult>;
    get(key: string): Promise<AuthkitSetting>;
    set(key: string, value: unknown): Promise<AuthkitSetting>;
    delete(key: string): Promise<DeletedSetting>;
  };
  /** Managed signing-key status and rotation (remote = Admin REST API, embedded = in-process; returns 501/throws when jwks is not managed+store). */
  keys: {
    /** GET /keys — age, policy and ETA to next rotation. */
    status(): Promise<KeysStatus>;
    /** POST /keys/rotate — rotate now, optionally retiring old keys. */
    rotate(input?: KeysRotateInput): Promise<KeysRotateResult>;
  };
}
