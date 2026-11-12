import type { ApplicationService } from '@adonisjs/core/types';
import type { AgoraDoctorCheck, AgoraDoctorResult } from './agora_doctor.js';
import {
  checkAccessTokens,
  checkAccountExpiration,
  checkAccountStore,
  checkAccountStoreColumns,
  checkAdapterVolatility,
  checkAdmin,
  checkAlly,
  checkAuthMethodsSetting,
  checkBotProtection,
  checkClients,
  checkConfigResolves,
  checkConsoleSignIn,
  checkEmailChange,
  checkFirstPartyClients,
  checkIssuer,
  checkJwks,
  checkOrganizations,
  checkOtpLockout,
  checkPasskeyAutofill,
  checkPasswordExpiration,
  checkPasswordHistory,
  checkPasswordPepper,
  checkPasswordPolicy,
  checkRateLimit,
  checkRequireVerifiedEmail,
  checkRolesCatalog,
  checkSecurityNotifications,
  checkSession,
  checkSessionPolicy,
  checkSettings,
  checkShield,
  checkSudoMode,
  checkWebauthn,
  type DoctorInput,
  type Finding,
} from './checks.js';

export const AUTHKIT_DOCTOR_DOCS =
  'https://davidecarvalho.github.io/agora/docs/authkit/health-check';

type CheckFn = (input: DoctorInput) => Finding | Finding[] | null;

/**
 * The `authkit:doctor` checks, in `runAllChecks` order, with their frozen `agora:doctor` ids
 * (`authkit.` + the function name without `check`, in kebab case). Ids are public: never rename.
 */
export const AUTHKIT_DOCTOR_TABLE: ReadonlyArray<
  readonly [id: string, title: string, fn: CheckFn]
> = [
  ['authkit.config-resolves', 'config/authkit.ts resolves', checkConfigResolves],
  ['authkit.issuer', 'Issuer and mount path', checkIssuer],
  ['authkit.clients', 'OIDC clients', checkClients],
  ['authkit.adapter-volatility', 'Persistent adapter', checkAdapterVolatility],
  ['authkit.account-store', 'Account store capabilities', checkAccountStore],
  ['authkit.account-store-columns', 'Account store columns', checkAccountStoreColumns],
  ['authkit.session', 'Session', checkSession],
  ['authkit.shield', 'Shield (CSRF)', checkShield],
  ['authkit.ally', 'Social login (ally)', checkAlly],
  ['authkit.rate-limit', 'Rate limiting', checkRateLimit],
  ['authkit.admin', 'Admin console', checkAdmin],
  ['authkit.require-verified-email', 'Verified e-mail gate', checkRequireVerifiedEmail],
  ['authkit.bot-protection', 'Bot protection', checkBotProtection],
  ['authkit.webauthn', 'Passkeys (WebAuthn)', checkWebauthn],
  ['authkit.password-policy', 'Password policy', checkPasswordPolicy],
  ['authkit.jwks', 'Signing keys (JWKS)', checkJwks],
  ['authkit.access-tokens', 'Access tokens', checkAccessTokens],
  ['authkit.organizations', 'Organizations', checkOrganizations],
  ['authkit.settings', 'Runtime settings', checkSettings],
  ['authkit.auth-methods-setting', 'Sign-in methods setting', checkAuthMethodsSetting],
  ['authkit.email-change', 'E-mail change', checkEmailChange],
  ['authkit.security-notifications', 'Security notifications', checkSecurityNotifications],
  ['authkit.password-pepper', 'Password pepper', checkPasswordPepper],
  ['authkit.password-history', 'Password history', checkPasswordHistory],
  ['authkit.password-expiration', 'Password expiration', checkPasswordExpiration],
  ['authkit.session-policy', 'Session policy', checkSessionPolicy],
  ['authkit.roles-catalog', 'Roles catalog', checkRolesCatalog],
  ['authkit.otp-lockout', 'OTP lockout', checkOtpLockout],
  ['authkit.sudo-mode', 'Sudo mode', checkSudoMode],
  ['authkit.account-expiration', 'Account expiration', checkAccountExpiration],
  ['authkit.passkey-autofill', 'Passkey autofill', checkPasskeyAutofill],
  ['authkit.first-party-clients', 'First-party clients', checkFirstPartyClients],
  ['authkit.console-sign-in', 'Console sign-in', checkConsoleSignIn],
];

export const AUTHKIT_DOCTOR_PACKAGE = '@adonis-agora/authkit-server';

interface Prepared {
  input: DoctorInput | null;
  error: string | null;
  /** `agora:doctor --no-boot`: config is not loaded, so the config checks cannot run. */
  notBooted?: boolean;
}

/** One input per app per doctor run: every check reads the same resolved config. */
const prepared = new WeakMap<object, Promise<Prepared>>();

function prepare(app: ApplicationService): Promise<Prepared> {
  let entry = prepared.get(app);
  const state = (app as { getState?(): string }).getState?.();
  if (state === 'created' || state === 'initiated') {
    return Promise.resolve({ input: null, error: null, notBooted: true });
  }
  if (!entry) {
    // Loaded on demand: the provider imports this module, and the input builder pulls in adapters.
    entry = import('./doctor_input.js')
      .then(({ buildDoctorInput }) => buildDoctorInput(app))
      .then(
        (input) => ({ input, error: null }),
        (error: unknown) => ({
          input: null,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    prepared.set(app, entry);
  }
  return entry;
}

function toResults(found: Finding | Finding[] | null): AgoraDoctorResult[] {
  const list = found === null ? [] : Array.isArray(found) ? found : [found];
  if (list.length === 0) return [{ status: 'skip', message: 'not applicable to this config' }];
  return list.map((finding) => ({
    status: finding.level,
    message: finding.message,
    ...(finding.level === 'ok' ? {} : { docs: AUTHKIT_DOCTOR_DOCS }),
  }));
}

/** `admin.authorize` omitted: open outside production, denies every request in production. */
export function consoleGateResult(
  authkitConfig: Record<string, any> | null,
  inProduction: boolean,
): AgoraDoctorResult {
  const admin = authkitConfig?.admin;
  if (!admin || admin.enabled !== true) {
    return { status: 'skip', message: 'admin console is off' };
  }
  if (admin.authorize) {
    return { status: 'ok', message: 'admin console has `admin.authorize`' };
  }
  const fix = 'Set `admin.authorize` in config/authkit.ts';
  return inProduction
    ? {
        status: 'error',
        message: 'admin console has no `admin.authorize`: it denies every request in production',
        fix,
        docs: AUTHKIT_DOCTOR_DOCS,
      }
    : {
        status: 'warn',
        message:
          'admin console has no `admin.authorize`: open here, denies every request in production',
        fix,
        docs: AUTHKIT_DOCTOR_DOCS,
      };
}

/** The checks authkit registers into `agora:doctor`. */
export function authkitDoctorChecks(): AgoraDoctorCheck[] {
  const checks: AgoraDoctorCheck[] = AUTHKIT_DOCTOR_TABLE.map(([id, title, fn]) => ({
    id,
    lib: 'authkit',
    package: AUTHKIT_DOCTOR_PACKAGE,
    title,
    async run(app) {
      const { input, error, notBooted } = await prepare(app);
      if (notBooted)
        return [{ status: 'skip', message: 'needs a booted app (run without --no-boot)' }];
      if (input === null) {
        return id === 'authkit.config-resolves'
          ? [
              {
                status: 'error',
                message: `config/authkit.ts failed to resolve: ${error}`,
                docs: AUTHKIT_DOCTOR_DOCS,
              },
            ]
          : [{ status: 'skip', message: 'config/authkit.ts did not resolve' }];
      }
      return toResults(fn(input));
    },
  }));
  checks.push(
    {
      id: 'authkit.signing-key-age',
      lib: 'authkit',
      package: AUTHKIT_DOCTOR_PACKAGE,
      title: 'Signing key age',
      async run(app) {
        const { input, notBooted } = await prepare(app);
        if (notBooted) {
          return { status: 'skip', message: 'needs a booted app (run without --no-boot)' };
        }
        if (!input) return toResults(null);
        const { managedSigningKeyAgeFinding } = await import('./doctor_input.js');
        return toResults(await managedSigningKeyAgeFinding(app, input.authkitConfig));
      },
    },
    {
      id: 'authkit.console-gate',
      lib: 'authkit',
      package: AUTHKIT_DOCTOR_PACKAGE,
      title: 'Admin console access in production',
      async run(app) {
        const { input, notBooted } = await prepare(app);
        if (notBooted)
          return { status: 'skip', message: 'needs a booted app (run without --no-boot)' };
        return consoleGateResult(input?.authkitConfig ?? null, app.inProduction);
      },
    },
  );
  return checks;
}
