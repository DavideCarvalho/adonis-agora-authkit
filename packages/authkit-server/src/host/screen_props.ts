/**
 * Props of every screen authkit-server renders through `cfg.render` — what an
 * `inertiaRenderer` page (or a custom renderer) receives for each view.
 *
 * `AuthkitScreenProps['<view>']` is the shape a page gets, `messages` included
 * (the renderer adds it). The controllers call `cfg.render` with
 * {@link ScreenRenderProps} (the same shape without `messages`), and `render` is
 * typed per view, so a controller that drifts from these types fails the
 * package's `tsc`.
 */

import type { ResolvedActionStep } from '../account/http.js';
import type { AccountNavEntry, ResolvedAccountPage } from '../account/runtime.js';
import type { OrgInvitation, OrgMember, OrgSummary } from '../accounts/account_store.js';
import type { PatRecord } from '../pat/pat_store.js';
import type {
  AccountConfirmProps,
  AccountEmailConfirmedProps,
  AccountLoginProps,
  AccountMfaProps,
  AccountSecurityProps,
} from './account_screen_props.js';
import type { BotProtectionWidget } from './bot_protection.js';
import type { ClientBrand } from './branding.js';
import type { CustomMfaDescriptor } from './custom_mfa.js';
import type { AuthMessages } from './i18n.js';
import type { LastLoginMethod } from './last_login_method.js';
import type { MagicChannelProp } from './login_channel.js';
import type { ResolvedAuthMethods, ResolvedOrganizationsPolicySetting } from './runtime_toggles.js';

/** What every screen receives from the renderer. */
interface WithMessages {
  /** The i18n catalog for the request's locale (added by the renderer). */
  messages: AuthMessages;
}

/** The account a login step is about (step 2+), or `null`. */
export interface LoginAccount {
  fullName: string | null;
  globalRoles: string[];
}

/**
 * `login` — the OIDC interaction's login screen. `step` drives the sub-view:
 * `identifier` (ask for the e-mail), `password`, or `password_expired`.
 */
export interface LoginProps extends WithMessages {
  uid: string;
  csrfToken: string;
  brand?: ClientBrand;
  step?: 'identifier' | 'password' | 'password_expired';
  email?: string;
  account?: LoginAccount | null;
  error?: string | null;
  /** `true` shows the link to sign up. */
  registrationEnabled?: boolean;
  /** Login methods allowed now (global settings × the account's preference). */
  authMethods?: ResolvedAuthMethods;
  magicLinkAvailable?: boolean;
  otpEnabled?: boolean;
  /** The method this device signed in with last time, for the "last used" badge. */
  lastUsedLoginMethod?: LastLoginMethod;
  passkeyFirstAvailable?: boolean;
  botProtection?: BotProtectionWidget;
  rememberEnabled?: boolean;
  rememberDays?: number;
  /** `true` after a magic link / code was sent. */
  magicLinkSent?: boolean;
  /** Which part of the "sent" state to show; `none` hides both. */
  magicChannel?: MagicChannelProp | 'none';
  /** Error of the one-time code field. */
  otpError?: string;
}

/** `signup` — the interaction's registration screen. */
export interface SignupProps extends WithMessages {
  uid: string;
  csrfToken: string;
  brand?: ClientBrand;
  error?: string;
  registrationDisabled?: boolean;
  registrationDisabledMessage?: string;
  /** `true` when signup sends a magic link instead of asking for a password. */
  passwordlessSignup?: boolean;
  botProtection?: BotProtectionWidget;
  /** `true` after the passwordless signup link was sent. */
  magicLinkSent?: boolean;
  otpEnabled?: boolean;
}

/** `forgot` — request a password reset e-mail. */
export interface ForgotProps extends WithMessages {
  csrfToken: string;
  error?: string;
  botProtection?: BotProtectionWidget;
  /** `true` after the e-mail was sent. */
  sent?: boolean;
}

/** `reset` — choose a new password from the e-mailed link. */
export interface ResetProps extends WithMessages {
  token: string;
  csrfToken: string;
  error?: string;
  /** `true` once the password was changed. */
  done?: boolean;
}

/** `verify-email` — result of the e-mail verification link. */
export interface VerifyEmailProps extends WithMessages {
  verified: boolean;
}

/** A host-registered second factor, as the `mfa-challenge` screen lists it. */
export type MfaChallengeCustomMethod = CustomMfaDescriptor & {
  beginUrl: string;
  verifyUrl: string;
  started: boolean;
};

/** `mfa-challenge` — the second factor of a login. */
export interface MfaChallengeProps extends WithMessages {
  uid: string;
  csrfToken: string;
  brand?: ClientBrand;
  error?: string;
  totpAvailable?: boolean;
  passkeyAvailable?: boolean;
  /** MFA is required but the account has no factor enrolled. */
  noEnrollment?: boolean;
  trustedDevicesEnabled?: boolean;
  trustedDeviceDays?: number;
  /** Too many wrong codes: the code field is locked for now. */
  otpLocked?: boolean;
  customMfaMethods?: MfaChallengeCustomMethod[];
  completedMfaMethods?: string[];
  requiredMfaFactors?: number;
}

/** A scope on the consent screen. */
export interface ConsentScope {
  id: string;
  label: string;
}

/**
 * The authorization request behind a consent, as the provider parsed it. Only
 * `client_id` is always there: device-flow and CIBA requests carry no
 * `redirect_uri` / `response_type`, and plain OAuth requests may omit `scope`.
 * Every other request parameter (`audience`, `resource`, `claims`, …) keeps its
 * raw value under its own name.
 */
export type ConsentRequestParams = {
  client_id: string;
  redirect_uri?: string;
  response_type?: string;
  scope?: string;
  state?: string;
  prompt?: string;
  nonce?: string;
  code_challenge?: string;
  code_challenge_method?: string;
} & Record<string, unknown>;

/** `consent` — the user grants the client the requested scopes. */
export interface ConsentProps extends WithMessages {
  uid: string;
  csrfToken: string;
  brand?: ClientBrand;
  /** The authorization request parameters. */
  params: ConsentRequestParams;
  /** The client's registered `client_name`, or its `client_id`. */
  clientName: string;
  /** `clientName`, HTML-escaped (Edge raw output). */
  clientNameHtml: string;
  scopes: ConsentScope[];
}

/** `maintenance` — maintenance mode is on. */
export interface MaintenanceProps extends WithMessages {
  uid?: string;
  csrfToken: string;
  brand?: ClientBrand;
  message: string;
  /** Admins may still sign in. */
  adminLoginAllowed?: boolean;
  adminLoginNote?: string;
}

/** `otp-unlock` — result of the "unlock my code login" link. */
export interface OtpUnlockProps extends WithMessages {
  ok: boolean;
  expired?: boolean;
}

/** `session-expired` — the interaction expired or was lost. */
export interface SessionExpiredProps extends WithMessages {
  /** Where the "sign in again" button goes (`interactionRecovery.redirectTo`). */
  loginUrl: string;
  brand?: ClientBrand;
}

/** `throttled` — the request hit a rate limit. */
export interface ThrottledProps extends WithMessages {
  brand?: ClientBrand;
  /** Seconds until a retry is allowed, or `null` when unknown. */
  retryAfter: number | null;
  retryUrl: string;
}

/** The agent asking for access, on `agents/consent`. */
/** One scope on the personal-agent consent screen. */
export interface AgentConsentScope {
  id: string;
  description: string;
  /** i18n key shown instead of `description` (an extension's message). */
  descriptionKey?: string;
  /** Not ticked for the person: granted only if they tick it themselves. */
  optIn?: boolean;
}

export interface AgentConsentRequest {
  /** Device-flow user code, when the agent uses it. */
  userCode?: string;
  agentName: string | null;
  agentOrigin: string | null;
  logoUri?: string | null;
  scopes: Array<AgentConsentScope>;
  /** Extra hidden form fields to send back. */
  hidden?: Array<{ name: string; value: string }>;
}

/** `agents/consent` — the user approves a personal agent's request. */
export interface AgentsConsentProps extends WithMessages {
  csrfToken: string;
  /** The form's POST target. */
  action: string;
  /** `null` while the user still has to enter a user code. */
  request: AgentConsentRequest | null;
  account: { email: string | null } | null;
  /** i18n key of the error to show, or `null`. */
  error: string | null;
}

/** `agents/done` — outcome of a personal agent consent. */
export interface AgentsDoneProps extends WithMessages {
  status: 'approved' | 'denied' | 'expired' | 'invalid';
  agentName: string | null;
  scopes: Array<AgentConsentScope>;
}

/** `account/apps` — apps and personal agents with access to the account. */
export interface AccountAppsProps extends WithMessages {
  csrfToken: string;
  supported: boolean;
  /** Personal agents with a delegation, or `null` when the feature is off. */
  agents: Array<{
    id: string;
    name: string;
    scopes: Array<{ id: string; description: string }>;
  }> | null;
  /** Flash with the revoked app, or `null`. */
  revoked: string | null;
  apps: Array<{
    clientId: string;
    name: string;
    /** The client's registered `logo_uri`, or `null`. */
    logoUrl: string | null;
    accessTokens: number;
    refreshTokens: number;
  }>;
}

/** `account/tokens` — personal access tokens. */
export interface AccountTokensProps extends WithMessages {
  csrfToken: string;
  /** The token just created, shown once, or `null`. */
  createdToken: string | null;
  tokens: Array<
    Pick<PatRecord, 'id' | 'name' | 'scopes' | 'audience' | 'lastUsedAt' | 'createdAt'>
  >;
}

/** An organization on `account/orgs`. */
export type AccountOrg = OrgSummary & {
  role: string;
  members: OrgMember[];
  canManage: boolean;
  isActive: boolean;
};

/**
 * `account/orgs` — the user's organizations. With `subview: 'accept-invitation'`
 * it is the invitation acceptance screen (`invitation`, `token`).
 */
export interface AccountOrgsProps extends WithMessages {
  csrfToken: string;
  supported?: boolean;
  orgs?: AccountOrg[];
  pendingInvitations?: Array<OrgInvitation & { orgName: string }>;
  allowSelfCreate?: ResolvedOrganizationsPolicySetting['allowSelfCreate'];
  availableRoles?: ResolvedOrganizationsPolicySetting['roles'];
  subview?: 'accept-invitation';
  invitation?: OrgInvitation | null;
  token?: string;
}

/**
 * `account/extension` — a page an account console extension added. `page` is the resolved page
 * (texts translated, values formatted); `step` is set on the confirmation step of an action.
 * `accountNav` (the console navigation) is added by the renderer to every account screen.
 */
export interface AccountExtensionProps extends WithMessages {
  csrfToken: string;
  page: ResolvedAccountPage;
  step: ResolvedActionStep | null;
  flash: { tone: 'success' | 'danger'; text: string } | null;
  /** The response's CSP nonce, for the scripts of `component` blocks. */
  cspNonce: string | null;
  accountNav?: AccountNavEntry[] | null;
  /** `<html lang>` of the console locale. */
  htmlLang?: string;
  /** Edge only: the `<script>` tag of a `component` block's script (nonce included). */
  scriptTag?: (script: { src: string; integrity: string | null; module: boolean }) => string;
}

/** Props of every screen, by view name. */
export interface AuthkitScreenProps {
  login: LoginProps;
  signup: SignupProps;
  consent: ConsentProps;
  forgot: ForgotProps;
  reset: ResetProps;
  'verify-email': VerifyEmailProps;
  'mfa-challenge': MfaChallengeProps;
  'otp-unlock': OtpUnlockProps;
  maintenance: MaintenanceProps;
  'session-expired': SessionExpiredProps;
  throttled: ThrottledProps;
  'agents/consent': AgentsConsentProps;
  'agents/done': AgentsDoneProps;
  'account/login': AccountLoginProps;
  'account/tokens': AccountTokensProps;
  'account/mfa': AccountMfaProps;
  'account/security': AccountSecurityProps;
  'account/apps': AccountAppsProps;
  'account/orgs': AccountOrgsProps;
  'account/confirm': AccountConfirmProps;
  'account/email-confirmed': AccountEmailConfirmedProps;
  'account/extension': AccountExtensionProps;
}

/** Every screen authkit-server renders. */
export type AuthkitScreen = keyof AuthkitScreenProps;

/** What a controller hands `cfg.render` for a view: the page props without `messages`. */
export type ScreenRenderProps<View extends AuthkitScreen> = Omit<
  AuthkitScreenProps[View],
  'messages'
>;

/** `cfg.render`, typed per view. */
export type AuthkitScreenRenderer = <View extends AuthkitScreen>(
  ctx: import('@adonisjs/core/http').HttpContext,
  view: View,
  props: ScreenRenderProps<View>,
) => unknown;
