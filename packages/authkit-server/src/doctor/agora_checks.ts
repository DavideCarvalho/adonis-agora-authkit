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
  checkMcpClients,
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
  ['authkit.mcp-clients', 'MCP client login', checkMcpClients],
];

export const AUTHKIT_DOCTOR_PACKAGE = '@adonis-agora/authkit-server';

interface Prepared {
  input: DoctorInput | null;
  error: string | null;
  /** The resolution error itself (`error` is its message). */
  cause?: unknown;
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
          cause: error,
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

const CRYPTO_DOCS = 'https://davidecarvalho.github.io/agora/docs/authkit/encryption-at-rest';

/** `authkit.crypto`: values sealed with a retired key or in the old format warn; unreadable errors. */
export function sealedAtRestResult(report: {
  columns: Array<{
    column: string;
    scanned: number;
    retired: number;
    legacy: number;
    unreadable: number;
  }>;
}): AgoraDoctorResult {
  if (report.columns.length === 0) {
    return { status: 'skip', message: 'nothing sealed at rest (no encrypted keystore, no TOTP)' };
  }
  const sum = (field: 'scanned' | 'retired' | 'legacy' | 'unreadable') =>
    report.columns.reduce((total, c) => total + c[field], 0);
  const where = (field: 'retired' | 'legacy' | 'unreadable') =>
    report.columns
      .filter((c) => c[field] > 0)
      .map((c) => `${c.column}: ${c[field]}`)
      .join(', ');
  if (sum('unreadable') > 0) {
    return {
      status: 'error',
      message: `${sum('unreadable')} sealed value(s) do not open with the configured keys (${where('unreadable')})`,
      fix: 'Put the key they were sealed with back in `crypto.keys` (config/authkit.ts)',
      docs: CRYPTO_DOCS,
    };
  }
  if (sum('retired') + sum('legacy') > 0) {
    const parts = [
      sum('legacy') > 0 ? `${sum('legacy')} in the pre-1.0 format (${where('legacy')})` : '',
      sum('retired') > 0 ? `${sum('retired')} under a retired key (${where('retired')})` : '',
    ].filter(Boolean);
    return {
      status: 'warn',
      message: `${parts.join('; ')} of ${sum('scanned')} sealed value(s)`,
      fix: 'Run `node ace authkit:crypto:reseal`',
      docs: CRYPTO_DOCS,
    };
  }
  return { status: 'ok', message: `${sum('scanned')} sealed value(s), all on the current key` };
}

/**
 * `authkit.keystore-read-only`: with `jwks.readOnly`, ok when the keystore the writer instance
 * keeps reads back; error when it is missing or does not open (that instance does not boot).
 */
export function keystoreReadOnlyResult(error: unknown, keyCount?: number): AgoraDoctorResult {
  if (error) {
    const missing = (error as { reason?: string }).reason === 'missing';
    return {
      status: 'error',
      message: missing
        ? 'jwks.readOnly is set but the keystore is empty: this instance never creates it, so it does not boot'
        : `jwks.readOnly is set but the keystore does not read: ${error instanceof Error ? error.message : String(error)}`,
      fix: missing
        ? 'Boot the instance that writes the keystore first, or point `jwks.store` at the table/key it uses'
        : 'Use the same `jwks.store`, `jwks.encrypt` and `crypto.keys` as the instance that writes the keystore',
      docs: KEYS_DOCS,
    };
  }
  return {
    status: 'ok',
    message: `reads the keystore another instance writes (${keyCount} key(s)); rotation runs there`,
  };
}

const KEYS_DOCS =
  'https://davidecarvalho.github.io/agora/docs/authkit/keystore-vaults#two-servers-one-identity';

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
      id: 'authkit.db-schema',
      lib: 'authkit',
      package: AUTHKIT_DOCTOR_PACKAGE,
      title: 'Database schema',
      cost: 'deep',
      async run(app) {
        const { input, notBooted } = await prepare(app);
        if (notBooted || !input?.authkitConfig?.schema?.name) return [];
        const { dbSchemaResults } = await import('./db_schema_check.js');
        return dbSchemaResults(
          input.authkitConfig,
          () => app.container.make('lucid.db' as any),
          AUTHKIT_DOCTOR_DOCS,
        );
      },
    },
    {
      id: 'authkit.crypto',
      lib: 'authkit',
      package: AUTHKIT_DOCTOR_PACKAGE,
      title: 'Secrets sealed at rest',
      cost: 'deep',
      async run(app) {
        const { input, notBooted } = await prepare(app);
        if (notBooted || !input) {
          return { status: 'skip', message: 'needs a booted app (run without --no-boot)' };
        }
        const service: any = await app.container.make('authkit.server' as any);
        return sealedAtRestResult(await service.sealedAtRest({ report: true }));
      },
    },
    {
      id: 'authkit.keystore-read-only',
      lib: 'authkit',
      package: AUTHKIT_DOCTOR_PACKAGE,
      title: 'Keystore read-only',
      async run(app) {
        const { input, notBooted, cause } = await prepare(app);
        if (notBooted) {
          return { status: 'skip', message: 'needs a booted app (run without --no-boot)' };
        }
        // A read-only instance whose keystore is missing never resolves its config: report that.
        if (!input) {
          if ((cause as { code?: string } | undefined)?.code === 'E_KEYSTORE_UNAVAILABLE') {
            return keystoreReadOnlyResult(cause);
          }
          return { status: 'skip', message: 'config/authkit.ts did not resolve' };
        }
        const jwks = input.authkitConfig?.jwksConfig;
        if (jwks?.readOnly !== true) {
          return {
            status: 'skip',
            message: 'jwks.readOnly is off: this instance writes its keystore',
          };
        }
        const { readKeystoreRequired } = await import('./doctor_input.js');
        try {
          return keystoreReadOnlyResult(null, await readKeystoreRequired(app, input.authkitConfig));
        } catch (error) {
          return keystoreReadOnlyResult(error);
        }
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
