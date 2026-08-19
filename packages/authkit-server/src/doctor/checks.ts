/**
 * Funções puras de verificação para `node ace authkit:doctor`. Não dependem do
 * Ace nem do container — recebem objetos simples para serem testáveis em
 * isolamento. O comando `authkit:doctor` só coleta o ambiente e imprime os
 * resultados destas funções.
 */

export type FindingLevel = 'ok' | 'warn' | 'error';

export interface Finding {
  level: FindingLevel;
  message: string;
}

/** Entrada mínima necessária para rodar os checks (subconjunto da config AuthKit). */
export interface DoctorInput {
  /** A config `authkit` resolvida pelo container, ou null se não resolver. */
  authkitConfig: Record<string, any> | null;
  /** A config `session` do app (config('session')), ou null se ausente. */
  sessionConfig: Record<string, any> | null;
  /** Resultado de tentar resolver cada peer (true = importável). */
  peers: {
    session: boolean;
    shield: boolean;
    ally: boolean;
    limiter: boolean;
  };
  /**
   * Whether the `auth_settings` table is present (runtime settings capability).
   * Provided by the doctor command; undefined = not checked (doctor runs old version).
   */
  settingsTablePresent?: boolean;
  /**
   * Classes de adapter para detecção de volatilidade (injetadas pelo doctor command
   * em runtime). Quando ausente, o check de volatilidade usa heurística conservadora.
   * Uso interno — não deve ser definido pelo host.
   */
  __adapterClasses?: { DatabaseAdapter?: new (...args: any[]) => any };
}

/** Type guard estrutural: o store expõe um método (capacidade presente). */
function has(store: any, method: string): boolean {
  return !!store && typeof store[method] === 'function';
}

/** config('authkit') resolve? */
export function checkConfigResolves(input: DoctorInput): Finding {
  if (!input.authkitConfig) {
    return {
      level: 'error',
      message: "config('authkit') did not resolve — config/authkit.ts is missing or invalid.",
    };
  }
  return { level: 'ok', message: "config('authkit') resolved." };
}

/** issuer é uma URL válida e seu pathname casa com o mountPath. */
export function checkIssuer(input: DoctorInput): Finding[] {
  const cfg = input.authkitConfig;
  if (!cfg) return [];
  const issuer: unknown = cfg.issuer;
  const mountPath: string = cfg.mountPath ?? '/oidc';

  if (typeof issuer !== 'string' || issuer.length === 0) {
    return [{ level: 'error', message: 'issuer missing in config.' }];
  }

  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return [{ level: 'error', message: `issuer is not a valid URL: "${issuer}".` }];
  }

  const findings: Finding[] = [
    { level: 'ok', message: `valid issuer: ${url.origin}${url.pathname}` },
  ];
  const normalize = (p: string) => (p.endsWith('/') ? p.slice(0, -1) : p) || '/';
  if (normalize(url.pathname) !== normalize(mountPath)) {
    findings.push({
      level: 'warn',
      message: `issuer pathname ("${url.pathname}") differs from mountPath ("${mountPath}"). OIDC routes may not match the URLs announced in discovery.`,
    });
  }
  return findings;
}

/**
 * Clients: verifica que não há clients estáticos no config (clients são 100%
 * runtime via console admin / Admin API).
 */
export function checkClients(input: DoctorInput): Finding {
  const cfg = input.authkitConfig;
  if (!cfg) return { level: 'error', message: 'no config to validate clients.' };
  // clients sempre é [] no config resolvido — info apenas.
  return {
    level: 'ok',
    message:
      'clients are managed at runtime via admin console / Admin API — use `node ace authkit:clients:create` to add clients.',
  };
}

/**
 * Aviso de adapter volátil. Como clients são 100% runtime (sem config estático),
 * um adapter volátil (Redis sem persistência, in-memory) pode perder os clients
 * num restart sem aviso prévio.
 *
 * Detecção de volatilidade: o `AdapterClass` é inspecionado estruturalmente:
 *   - `DatabaseAdapter` (ou subclasse) → persistente (sem warn)
 *   - qualquer outra classe → pode ser volátil → warn informativo
 */
export function checkAdapterVolatility(input: DoctorInput): Finding | null {
  const cfg = input.authkitConfig;
  if (!cfg) return null;

  const AdapterClass = cfg.AdapterClass;
  if (!AdapterClass) return null;

  // Verifica se é um DatabaseAdapter (persistente). Usamos a cadeia de protótipos
  // para detectar subclasses (o factory retorna uma subclasse anônima de DatabaseAdapter).
  let isPersistent = false;
  try {
    const { DatabaseAdapter } = input.__adapterClasses ?? {};
    if (DatabaseAdapter && AdapterClass.prototype instanceof DatabaseAdapter) {
      isPersistent = true;
    }
  } catch {
    // sem __adapterClasses disponível — trata como desconhecido
  }

  if (isPersistent) {
    return {
      level: 'ok',
      message:
        'adapter is DatabaseAdapter (persistent) — clients managed via console/API survive restarts.',
    };
  }

  // Adapter desconhecido ou volátil (Redis, memory, custom) — warn informativo.
  return {
    level: 'warn',
    message:
      'No static clients in config: if the OIDC adapter is volatile (Redis without AOF/RDB, in-memory, etc.), ' +
      'clients managed via console/API will be lost on restart. ' +
      'Use a persistent adapter (DatabaseAdapter) or keep static clients as a fallback.',
  };
}

/** accountStore presente + quais capacidades implementa. */
export function checkAccountStore(input: DoctorInput): Finding[] {
  const cfg = input.authkitConfig;
  if (!cfg) return [];
  const store = cfg.accountStore;
  if (!store) {
    return [{ level: 'error', message: 'accountStore missing — required.' }];
  }
  const findings: Finding[] = [{ level: 'ok', message: 'accountStore present.' }];
  const caps: string[] = [];
  if (has(store, 'getMfaState')) caps.push('MFA');
  if (has(store, 'listPasskeys')) caps.push('passkeys/WebAuthn');
  if (has(store, 'findByProviderIdentity')) caps.push('account-linking');
  if (has(store, 'changePassword')) caps.push('account-security');
  if (has(store, 'isEmailVerified')) caps.push('email-verification-status');
  if (has(store, 'deleteAccount')) caps.push('account-deletion');
  findings.push({
    level: 'ok',
    message: caps.length
      ? `Optional capabilities: ${caps.join(', ')}.`
      : 'accountStore core only (no MFA/passkeys/linking/security).',
  });
  return findings;
}

/**
 * Propriedades do model que o account store Lucid escreve/lê, agrupadas pelo
 * FLUXO que deixa de funcionar quando a coluna não existe. Agrupar por fluxo (e
 * não listar colunas soltas) é o que torna o achado acionável: "falta
 * `password_reset_token`" não diz nada a quem não conhece o interior da lib;
 * "o reset de senha vai quebrar" diz.
 */
const REQUIRED_COLUMN_GROUPS: { flow: string; properties: string[] }[] = [
  { flow: 'identity (every flow)', properties: ['email'] },
  { flow: 'password login', properties: ['password'] },
  { flow: 'role claims / admin', properties: ['globalRoles'] },
  {
    flow: 'password reset',
    properties: ['passwordResetToken', 'passwordResetExpiresAt'],
  },
  {
    flow: 'email verification',
    properties: ['emailVerifiedAt', 'emailVerificationToken'],
  },
];

/**
 * Propriedades OPCIONAIS: a capability correspondente é detectada pela presença
 * da coluna, então ausência é configuração válida (feature desligada) e nunca
 * um erro — só vale reportar para que a ausência seja uma escolha, e não uma
 * surpresa.
 */
const OPTIONAL_COLUMN_GROUPS: { capability: string; properties: string[] }[] = [
  { capability: 'profile (name/avatar)', properties: ['fullName', 'avatarUrl'] },
  { capability: 'disable/enable account', properties: ['disabledAt'] },
  { capability: 'password expiration', properties: ['passwordChangedAt'] },
];

/**
 * Valida que o model por trás do account store tem as colunas que o store
 * escreve. Existe por causa da adoção brownfield: quando o host aponta o
 * AuthKit para a tabela `users` que ele JÁ tinha, as colunas dos mixins
 * (`password_reset_token`, `email_verification_token`, …) não existem, o app
 * sobe normalmente, e a falha só aparece quando alguém clica em "esqueci minha
 * senha" — em produção. Este check antecipa isso para o boot.
 *
 * Silencioso quando não há o que inspecionar: um store custom (não-Lucid) não
 * expõe `__model`, e nesse caso o contrato é responsabilidade de quem o
 * implementou.
 */
export function checkAccountStoreColumns(input: DoctorInput): Finding[] {
  const store = input.authkitConfig?.accountStore;
  const model = store?.__model;
  const definitions: Map<string, { columnName?: string }> | undefined = model?.$columnsDefinitions;
  if (!definitions || typeof definitions.get !== 'function') return [];

  /** Nome da coluna real (o que o DBA procura), com fallback à propriedade. */
  const columnOf = (property: string): string => definitions.get(property)?.columnName ?? property;
  const missing = (properties: string[]): string[] => properties.filter((p) => !definitions.has(p));

  const findings: Finding[] = [];

  for (const { flow, properties } of REQUIRED_COLUMN_GROUPS) {
    const absent = missing(properties);
    if (absent.length === 0) continue;
    const named = absent.map((p) => `\`${p}\` (column \`${columnOf(p)}\`)`).join(', ');
    findings.push({
      level: 'error',
      message: `accountStore model (${model.name ?? 'model'}) is missing ${named} — ${flow} will fail at runtime. Add the column(s) with a migration, or map an existing one with @column({ columnName: '…' }).`,
    });
  }

  const off = OPTIONAL_COLUMN_GROUPS.filter((g) => missing(g.properties).length > 0);
  if (off.length > 0) {
    findings.push({
      level: 'ok',
      message: `Capabilities off (column absent): ${off.map((g) => g.capability).join(', ')}.`,
    });
  }

  if (findings.every((f) => f.level === 'ok')) {
    findings.unshift({
      level: 'ok',
      message: `accountStore model (${model.name ?? 'model'}) has every required column.`,
    });
  }

  return findings;
}

/** session provider configurado + warn se cookie store com tokenSets grandes. */
export function checkSession(input: DoctorInput): Finding[] {
  if (!input.peers.session) {
    return [
      {
        level: 'error',
        message: '@adonisjs/session is not importable — install it (required peer).',
      },
    ];
  }
  if (!input.sessionConfig) {
    return [
      {
        level: 'warn',
        message: "config('session') missing — the session provider may not be configured.",
      },
    ];
  }
  const findings: Finding[] = [{ level: 'ok', message: 'session provider configured.' }];
  const driver = input.sessionConfig.store ?? input.sessionConfig.driver;
  if (driver === 'cookie') {
    findings.push({
      level: 'warn',
      message:
        'session store = cookie: large token sets may exceed the 4KB cookie limit. Prefer `redis`/`file` in production.',
    });
  }
  return findings;
}

/** Hint de exceções de CSRF do shield para o mountPath. */
export function checkShield(input: DoctorInput): Finding {
  if (!input.peers.shield) {
    return {
      level: 'error',
      message: '@adonisjs/shield is not importable — install it (required peer).',
    };
  }
  const mountPath = input.authkitConfig?.mountPath ?? '/oidc';
  return {
    level: 'warn',
    message: `Make sure the IdP POST routes under "${mountPath}" are in the shield CSRF exceptions (e.g. the /token endpoint), otherwise server-to-server calls fail.`,
  };
}

/** ally só é necessário quando social está configurado. */
export function checkAlly(input: DoctorInput): Finding {
  const social = input.authkitConfig?.social;
  const usesSocial =
    !!social &&
    (Array.isArray(social.providers)
      ? social.providers.length > 0
      : Object.keys(social).length > 0);
  if (!usesSocial) {
    return { level: 'ok', message: 'social login not configured — @adonisjs/ally is optional.' };
  }
  if (!input.peers.ally) {
    return {
      level: 'error',
      message: 'social login configured, but @adonisjs/ally is not importable.',
    };
  }
  return { level: 'ok', message: 'social login configured and @adonisjs/ally available.' };
}

/**
 * OTP lockout: informativa. Avisa quando enabled mas limiter ausente (no-op).
 * Não emite nada quando OTP lockout está desligado por setting (runtime).
 */
export function checkOtpLockout(input: DoctorInput): Finding | null {
  // O OTP lockout usa o mesmo limiter do lockout de conta.
  // Sem limiter → OTP lockout é no-op.
  if (!input.peers.limiter) {
    return {
      level: 'warn',
      message:
        'otp_lockout is enabled by default but @adonisjs/limiter is not installed — OTP factor lockout will be a no-op. Install @adonisjs/limiter to enable it.',
    };
  }
  return { level: 'ok', message: 'otp_lockout: @adonisjs/limiter available.' };
}

/**
 * Sudo mode: informativa. O sudo mode requer sessões Adonis (sempre disponíveis
 * no console de conta). Apenas informa o estado.
 */
export function checkSudoMode(_input: DoctorInput): Finding | null {
  return {
    level: 'ok',
    message:
      'sudo_mode: enabled by default (15 min grace). Configure via admin settings or sudo_mode runtime setting.',
  };
}

/** rateLimit ligado mas @adonisjs/limiter ausente → warn. */
export function checkRateLimit(input: DoctorInput): Finding {
  const cfg = input.authkitConfig;
  const rateLimit = cfg?.rateLimit;
  const enabled = rateLimit === undefined ? true : rateLimit?.enabled !== false;
  if (!enabled) {
    return { level: 'ok', message: 'rate-limiting disabled by config.' };
  }
  if (!input.peers.limiter) {
    return {
      level: 'warn',
      message:
        'rate-limiting is on (default), but @adonisjs/limiter is not importable — becomes a no-op (no anti-brute-force protection).',
    };
  }
  return { level: 'ok', message: 'rate-limiting on and @adonisjs/limiter available.' };
}

/** admin.enabled mas sem roles → warn. Reporta o modo de UI ativo. */
export function checkAdmin(input: DoctorInput): Finding | null {
  const admin = input.authkitConfig?.admin;
  if (!admin || admin.enabled !== true) return null;
  const roles = Array.isArray(admin.roles) ? admin.roles : [];
  if (roles.length === 0) {
    return {
      level: 'warn',
      message:
        'admin console on, but no `admin.roles` — nobody will have access (the default ["ADMIN"] was not resolved here).',
    };
  }
  return {
    level: 'ok',
    message: `admin console on for roles: ${roles.join(', ')} (React SPA self-contained — JSON API under {prefix}/api/*).`,
  };
}

/** requireVerifiedEmail ligado mas o store não sabe checar verificação → warn. */
export function checkRequireVerifiedEmail(input: DoctorInput): Finding | null {
  const cfg = input.authkitConfig;
  const login = cfg?.login;
  if (!login || login.requireVerifiedEmail !== true) return null;
  const store = cfg?.accountStore;
  if (!has(store, 'isEmailVerified')) {
    return {
      level: 'warn',
      message:
        'login.requireVerifiedEmail is on, but the accountStore has no `isEmailVerified` capability — the check is a no-op (nobody is blocked). Add an `email_verified_at` column (or a store that tracks it).',
    };
  }
  return {
    level: 'ok',
    message: 'login.requireVerifiedEmail on and the accountStore can check it.',
  };
}

/**
 * Bot protection (informativo): ativo quando `botProtection.verify` é uma função.
 * Reporta em quais ações está ligado e lembra da semântica fail-safe. Silencioso
 * quando não configurado.
 */
export function checkBotProtection(input: DoctorInput): Finding | null {
  const bot = input.authkitConfig?.botProtection;
  if (!bot) return null;
  if (typeof bot.verify !== 'function') {
    return {
      level: 'warn',
      message:
        'botProtection is set but `verify` is not a function — the check is skipped (no protection).',
    };
  }
  const on = Array.isArray(bot.on) && bot.on.length > 0 ? bot.on : ['login', 'signup'];
  return {
    level: 'ok',
    message: `bot protection on for: ${on.join(', ')} — fail-safe (verify errors/timeouts allow the request, availability over protection).`,
  };
}

/** webauthn rpId deve casar com o host do issuer. */
export function checkWebauthn(input: DoctorInput): Finding | null {
  const cfg = input.authkitConfig;
  const webauthn = cfg?.webauthn;
  if (!webauthn || !webauthn.rpId) return null;
  const issuer: unknown = cfg.issuer;
  if (typeof issuer !== 'string') return null;
  let host: string;
  try {
    host = new URL(issuer).hostname;
  } catch {
    return null;
  }
  if (webauthn.rpId !== host) {
    return {
      level: 'warn',
      message: `webauthn.rpId ("${webauthn.rpId}") differs from the issuer host ("${host}") — passkeys will not validate in the browser.`,
    };
  }
  return { level: 'ok', message: `webauthn.rpId matches the issuer host (${host}).` };
}

/**
 * Política de senha + checagem de vazamento (config do accountStore — opção
 * `password`). Valida o shape da policy e informa quando o HIBP está ligado. A
 * config vive no store (não no nível raiz da config authkit), então lemos de
 * `accountStore` quando o host a expõe via `__passwordConfig` (best-effort) — na
 * ausência, este check é silencioso (não falha).
 */
export function checkPasswordPolicy(input: DoctorInput): Finding | null {
  const store = input.authkitConfig?.accountStore;
  const pwConfig = store?.__passwordConfig as
    | { policy?: Record<string, unknown>; checkPwned?: { enabled?: boolean } }
    | undefined;
  if (!pwConfig) return null;

  const policy = pwConfig.policy;
  if (policy) {
    const minLength = policy.minLength;
    if (minLength !== undefined && (typeof minLength !== 'number' || minLength < 1)) {
      return {
        level: 'warn',
        message: `password.policy.minLength is invalid (${String(minLength)}) — expected a positive number.`,
      };
    }
    if (typeof minLength === 'number' && minLength < 8) {
      return {
        level: 'warn',
        message: `password.policy.minLength is ${minLength} — values below 8 are discouraged.`,
      };
    }
  }

  if (pwConfig.checkPwned?.enabled) {
    return {
      level: 'ok',
      message:
        'password.checkPwned is on — new passwords are checked against HaveIBeenPwned (k-anonymity, fail-safe on network errors).',
    };
  }
  return { level: 'ok', message: 'password policy configured.' };
}

/** info sobre rotação quando jwks é managed; warn se managed sem store (sem rotação real). */
export function checkJwks(input: DoctorInput): Finding | null {
  // No config RESOLVIDO o `jwks` é o keyset materializado ({ keys }) e perde
  // source/store — o shape de input fica ecoado em `jwksConfig`. Prefira-o.
  const jwks = input.authkitConfig?.jwksConfig ?? input.authkitConfig?.jwks;
  if (!jwks) return null;
  if (jwks.source === 'managed') {
    if (!jwks.store) {
      return {
        level: 'warn',
        message:
          'jwks managed WITHOUT a `store` — a fresh ephemeral key is generated each boot (tokens stop validating after a restart and `node ace authkit:keys:rotate` has no effect). Set `jwks.store` to persist and enable real rotation.',
      };
    }
    return {
      level: 'ok',
      message:
        'jwks managed with a persisted store — rotate the signing keys with `node ace authkit:keys:rotate` (--dry-run to preview, --retire to drop old keys, --keep=N for the grace window).',
    };
  }
  return { level: 'ok', message: 'jwks provided inline (source=jwks).' };
}

/**
 * Formato dos Access Tokens (RFC 9068). Informa o formato configurado e, no modo
 * JWT, lembra que o JWKS precisa ser estável (store persistido) para que os RPs
 * validem os ATs via jwks_uri através de reinícios/rotação.
 */
export function checkAccessTokens(input: DoctorInput): Finding | null {
  const cfg = input.authkitConfig;
  const at = cfg?.accessTokens;
  if (!at) return null;
  const resources = at.resources ?? {};
  const resourceCount = Object.keys(resources).length;
  const anyJwt =
    at.anyJwt ??
    (at.format === 'jwt' || Object.values(resources).some((r: any) => r?.format === 'jwt'));

  if (!anyJwt) {
    return {
      level: 'ok',
      message:
        'access tokens are opaque (default) — introspect them at the introspection endpoint.',
    };
  }

  const detail = resourceCount
    ? `format=${at.format}, ${resourceCount} resource(s) configured`
    : `format=jwt, audience=${at.audience}`;
  const jwks = cfg?.jwks;
  if (jwks?.source === 'managed' && !jwks.store) {
    return {
      level: 'warn',
      message: `JWT access tokens (RFC 9068) are on (${detail}), but jwks is managed WITHOUT a store — the signing key changes every boot, so issued JWT ATs stop validating after a restart. Set jwks.store.`,
    };
  }
  return {
    level: 'ok',
    message: `JWT access tokens (RFC 9068) are on (${detail}) — signed with the JWKS key, validable via jwks_uri (typ "at+jwt").`,
  };
}

/**
 * Organizations (multi-tenancy). Informa se a capacidade está disponível
 * (store expõe createOrg) e avisa se `organizations.enabled: true` no config mas
 * a capacidade não está presente no store (organizationModels não foram passados).
 */
export function checkOrganizations(input: DoctorInput): Finding | null {
  const cfg = input.authkitConfig;
  if (!cfg) return null;

  const store = cfg.accountStore;
  const orgsEnabled = cfg.organizations?.enabled;
  const storeSupports = has(store, 'createOrg');

  if (orgsEnabled === true && !storeSupports) {
    return {
      level: 'warn',
      message:
        'organizations.enabled: true, but the accountStore has no OrganizationsCapability — ' +
        'pass `organizationModels: { OrgModel, MemberModel, InvitationModel }` to `lucidAccountStore()`. ' +
        'Expected tables: auth_organizations, auth_organization_members, auth_organization_invitations.',
    };
  }

  if (storeSupports) {
    const roles = cfg.organizations?.roles ?? ['owner', 'admin', 'member'];
    return {
      level: 'ok',
      message: `organizations capability present (roles: ${roles.join(', ')}).`,
    };
  }

  // Auto mode (enabled === undefined) and store doesn't support — silently ok (opt-in).
  return null;
}

/**
 * Runtime settings: informa se a tabela `auth_settings` está presente.
 * Quando ausente, é silencioso (a feature é opt-in). Quando presente mas
 * `botProtection.verify` NÃO está no config, alerta que a setting em banco
 * é órfã e não tem efeito.
 */
export function checkSettings(input: DoctorInput): Finding | null {
  const cfg = input.authkitConfig;
  if (!cfg) return null;

  const tablePresent = input.settingsTablePresent;

  if (tablePresent === undefined) {
    // Doctor did not check — silently skip.
    return null;
  }

  if (!tablePresent) {
    // Table absent — opt-in feature, silently ok.
    return null;
  }

  // Informa a conexão usada quando nomeada (ajuda a diagnosticar bugs de searchPath).
  const connectionName: string | undefined = (cfg.accountStore as any)?.connectionName;
  const connectionHint = connectionName ? ` (connection: '${connectionName}')` : '';

  // Table present — check if botProtection.verify is configured.
  const hasBotVerify = typeof cfg.botProtection?.verify === 'function';
  if (!hasBotVerify) {
    return {
      level: 'warn',
      message: `The \`auth_settings\` table is present${connectionHint}, but \`botProtection.verify\` is not configured in config — any \`bot_protection\` setting stored in \`auth_settings\` is an orphan and has no effect. Add \`botProtection.verify\` to config/authkit.ts or drop the row.`,
    };
  }

  return {
    level: 'ok',
    message: `auth_settings table present${connectionHint} — runtime settings (including bot-protection toggle) are active.`,
  };
}

/**
 * auth_methods setting: verifica se o valor persistido tem forma válida.
 * O input `authMethodsSetting` é injetado pelo doctor command quando a tabela
 * está presente — similar ao padrão do checkSettings mas focado na setting específica.
 *
 * Warns quando:
 *   - Todos os métodos estão desligados (fail-safe será acionado em runtime).
 *   - A lista `social` referencia um provider não presente em `config.social.providers`.
 */
export function checkAuthMethodsSetting(input: DoctorInput): Finding | null {
  const cfg = input.authkitConfig;
  if (!cfg) return null;

  // Só verificamos quando a tabela existe e o setting foi injetado no input.
  const raw = (input as any).authMethodsSetting;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      level: 'warn',
      message:
        'auth_methods setting has an invalid shape — expected an object. The setting will be ignored (config defaults apply).',
    };
  }

  const s = raw as {
    password?: boolean;
    magicLink?: boolean;
    passkey?: boolean;
    social?: string[];
    forgotPassword?: boolean;
  };

  // Check all-off scenario.
  const allOff =
    s.password === false &&
    s.magicLink === false &&
    s.passkey === false &&
    Array.isArray(s.social) &&
    s.social.length === 0;
  if (allOff) {
    return {
      level: 'warn',
      message:
        'auth_methods setting disables all login methods — a fail-safe will revert to config defaults at runtime. ' +
        'Enable at least one method in the admin console (/admin/settings) to avoid the fallback.',
    };
  }

  // Check social references unknown providers.
  if (Array.isArray(s.social) && s.social.length > 0) {
    const configuredProviders: string[] = cfg.social?.providers ?? [];
    const unknown = s.social.filter((p: string) => !configuredProviders.includes(p));
    if (unknown.length > 0) {
      return {
        level: 'warn',
        message: `auth_methods setting references social provider(s) not in config.social.providers: [${unknown.join(', ')}]. These providers will be silently filtered out (intersection rule). Remove them from the setting or add them to config.social.providers.`,
      };
    }
  }

  return {
    level: 'ok',
    message: 'auth_methods setting is valid.',
  };
}

/**
 * Verifica se o fluxo de troca de e-mail verificada está disponível.
 * Reporta se o store suporta a capability de security (requestEmailChange/confirmEmailChange).
 */
export function checkEmailChange(input: DoctorInput): Finding | null {
  const cfg = input.authkitConfig;
  if (!cfg) return null;
  const store = cfg.accountStore;
  // A capability de security é identificada pelo método changePassword no store.
  if (!has(store, 'changePassword')) {
    return {
      level: 'warn',
      message:
        'accountStore does not implement AccountSecurityCapability (changePassword/requestEmailChange/confirmEmailChange) — verified email-change flow is unavailable. The /account/security email-change form will be hidden.',
    };
  }
  return {
    level: 'ok',
    message:
      'accountStore supports AccountSecurityCapability — verified email-change flow available.',
  };
}

/**
 * Verifica a capability de notificações de segurança:
 * - mail configurado (para envio dos alertas)
 * - store com suporte a AccountSecurityCapability
 */
export function checkSecurityNotifications(input: DoctorInput): Finding | null {
  const cfg = input.authkitConfig;
  if (!cfg) return null;
  // Notificações de segurança são best-effort; reportamos apenas informativo.
  const hasMail = !!(cfg.mail || cfg.mailer);
  const hasStore = has(cfg.accountStore, 'changePassword');
  if (!hasMail) {
    return {
      level: 'warn',
      message:
        'No mail hook (mail.onSecurityNotice) or @adonisjs/mail configured — security notifications will fall back to dev-mode logging. Configure mail or provide mail.onSecurityNotice in config/authkit.ts.',
    };
  }
  if (!hasStore) {
    return {
      level: 'warn',
      message:
        'accountStore does not implement AccountSecurityCapability — security notification triggers in the account console are unavailable.',
    };
  }
  return null; // Silencioso quando tudo está ok (não-obrigatório).
}

/**
 * Verifica o pepper de senha (`accountStore.password.pepper`).
 * - Silencioso quando não há pepper configurado.
 * - Reporta o pepper como string e sugere a forma `[novo, antigo]`, que permite
 *   rotação sem downtime (lazy re-hash no verify).
 * - Reporta quantos peppers a rotação tem quando já é array.
 */
export function checkPasswordPepper(input: DoctorInput): Finding | null {
  const store = input.authkitConfig?.accountStore;
  const pepper = store?.__pepper;
  if (!pepper) return null;

  if (typeof pepper === 'string') {
    return {
      level: 'ok',
      message:
        'password.pepper is configured (HMAC-SHA256 before hashing). ' +
        'Consider using an array `[newPepper, oldPepper]` for rotation without downtime.',
    };
  }
  if (Array.isArray(pepper)) {
    return {
      level: 'ok',
      message: `password.pepper rotation configured (${pepper.length} pepper(s)). First pepper is current; subsequent peppers are tried on verify (lazy re-hash).`,
    };
  }
  return null;
}

/**
 * Verifica a capability de histórico de senhas (disallow_password_reuse).
 * Informa se a tabela `auth_password_history` está presente e a capability está disponível.
 * Avisa quando a setting está ligada mas a capability não está presente.
 */
export function checkPasswordHistory(input: DoctorInput): Finding | null {
  const cfg = input.authkitConfig;
  if (!cfg) return null;
  const store = cfg.accountStore;
  // Capability presente quando o store tem isPasswordReused.
  const hasCapability = has(store, 'isPasswordReused');

  // Verifica se a setting está ativa (injetada no input pelo doctor command).
  const histSetting = (input as any).passwordHistorySetting;
  if (histSetting?.enabled && !hasCapability) {
    return {
      level: 'warn',
      message:
        'password_history setting is enabled but the accountStore lacks PasswordHistoryCapability — ' +
        'the `auth_password_history` table may be missing. Create it: ' +
        '`id UUID/SERIAL PK, account_id TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMP NOT NULL`.',
    };
  }

  if (hasCapability) {
    return {
      level: 'ok',
      message: 'password history capability present (auth_password_history table detected).',
    };
  }
  return null; // Silencioso quando opt-in não configurado.
}

/**
 * Verifica a capability de expiração de senha.
 * Informa se a coluna `password_changed_at` está presente. Avisa quando a setting
 * está ligada mas a coluna não existe.
 */
export function checkPasswordExpiration(input: DoctorInput): Finding | null {
  const cfg = input.authkitConfig;
  if (!cfg) return null;
  const store = cfg.accountStore;
  // Capability presente quando o store tem getPasswordChangedAt.
  const hasCapability = has(store, 'getPasswordChangedAt');

  // Verifica se a setting está ativa (injetada no input pelo doctor command).
  const expSetting = (input as any).passwordExpirationSetting;
  if (expSetting?.enabled && !hasCapability) {
    return {
      level: 'warn',
      message:
        'password_expiration setting is enabled but the accountStore lacks PasswordExpirationCapability — ' +
        'the `password_changed_at` column may be missing from the auth users table. ' +
        'Add it: `password_changed_at TIMESTAMP NULL`.',
    };
  }

  if (hasCapability) {
    const maxAge = expSetting?.maxAgeDays ?? 90;
    return {
      level: 'ok',
      message: expSetting?.enabled
        ? `password expiration is on (max ${maxAge} days).`
        : 'password_changed_at column detected — password expiration capability available (currently off in settings).',
    };
  }
  return null; // Silencioso quando opt-in não configurado.
}

/**
 * Verifica a setting `session_policy` para valores absurdos ou inconsistentes.
 *
 * Checks:
 *   - idleTimeoutMinutes > defaultSessionHours*60: idle timeout nunca irá disparar.
 *   - rememberDays > 365: incomumente longo (warn).
 *   - idleTimeoutMinutes > 0 mas defaultSessionHours = 0: impossível (error).
 */
export function checkSessionPolicy(input: DoctorInput): Finding | null {
  const policy = (input as any).sessionPolicySetting;
  if (!policy || typeof policy !== 'object') return null;

  const idleMin: number =
    typeof policy.idleTimeoutMinutes === 'number' ? policy.idleTimeoutMinutes : 0;
  const defaultHours: number =
    typeof policy.defaultSessionHours === 'number' ? policy.defaultSessionHours : 168;
  const rememberDays: number = typeof policy.rememberDays === 'number' ? policy.rememberDays : 30;

  if (idleMin > 0 && defaultHours > 0 && idleMin > defaultHours * 60) {
    return {
      level: 'warn',
      message: `session_policy: idleTimeoutMinutes (${idleMin}) exceeds defaultSessionHours*60 (${defaultHours * 60}). The idle timeout will never trigger — increase defaultSessionHours or reduce idleTimeoutMinutes.`,
    };
  }

  if (rememberDays > 365) {
    return {
      level: 'warn',
      message: `session_policy: rememberDays (${rememberDays}) exceeds 365. This is an unusually long session duration.`,
    };
  }

  return {
    level: 'ok',
    message:
      `session_policy: rememberEnabled=${policy.rememberEnabled ?? true}, ` +
      `rememberDays=${rememberDays}, defaultSessionHours=${defaultHours}, ` +
      `singleSession=${policy.singleSession ?? false}, idleTimeoutMinutes=${idleMin}.`,
  };
}

/**
 * Verifica o catálogo de roles globais (informativo).
 *
 * Checks:
 *   - Informa o número de roles no catálogo quando a setting está presente.
 *   - Avisa se `cfg.admin.roles` contém role(s) fora do catálogo (o gate do console
 *     pode não funcionar como esperado se a role não existir no catálogo).
 */
export function checkRolesCatalog(input: DoctorInput): Finding | null {
  const cfg = input.authkitConfig;
  if (!cfg) return null;

  const raw = (input as any).rolesCatalogSetting;
  if (raw === undefined || raw === null) return null; // setting não presente — silencioso

  if (typeof raw !== 'object' || !Array.isArray((raw as any).roles)) {
    return {
      level: 'warn',
      message:
        'roles_catalog setting has an invalid shape — expected { roles: [...] }. The setting will be ignored (default catalog applies).',
    };
  }

  const catalogRoles: string[] = ((raw as any).roles as any[])
    .filter((r) => typeof r === 'object' && typeof r.name === 'string')
    .map((r) => r.name);

  // Verifica se admin.roles referencia roles fora do catálogo.
  const adminRoles: string[] = Array.isArray(cfg.admin?.roles) ? cfg.admin.roles : ['ADMIN'];
  const outOfCatalog = adminRoles.filter((r: string) => !catalogRoles.includes(r));

  if (outOfCatalog.length > 0) {
    return {
      level: 'warn',
      message: `roles_catalog: ${catalogRoles.length} role(s) in catalog, but cfg.admin.roles references [${outOfCatalog.join(', ')}] which are not in the catalog. Admin access depends on these roles — add them to the catalog at /admin/roles.`,
    };
  }

  return {
    level: 'ok',
    message: `roles_catalog: ${catalogRoles.length} role(s) in catalog (${catalogRoles.join(', ')}).`,
  };
}

/**
 * Verifica a feature de expiração de conta por inatividade.
 *
 * - Capability-probed: sem audit com `list` → a feature fica indisponível; explica o motivo.
 * - Quando a setting `account_expiration` está presente, valida a coerência dos campos.
 */
export function checkAccountExpiration(input: DoctorInput): Finding | null {
  const cfg = input.authkitConfig;
  if (!cfg) return null;

  // Sem audit configurado → feature completamente indisponível.
  if (!cfg.audit) return null;

  // Verifica se o audit implementa `list` (capability-probed).
  const auditHasList = typeof cfg.audit.list === 'function';
  if (!auditHasList) {
    return {
      level: 'warn',
      message:
        'account_expiration: the configured audit sink does not implement the `list` method. ' +
        'Account inactivity expiration requires a queryable audit sink (e.g. lucidAuditSink). ' +
        'The feature is unavailable until you configure a queryable audit sink.',
    };
  }

  return {
    level: 'ok',
    message:
      'account_expiration: audit sink supports list() — feature is available when enabled via auth_settings.',
  };
}

/**
 * Verifica a disponibilidade do WebAuthn passkey autofill (conditional mediation).
 *
 * Informativo: se webauthn não estiver configurado, o autofill nunca será exibido.
 */
export function checkPasskeyAutofill(input: DoctorInput): Finding | null {
  const cfg = input.authkitConfig;
  if (!cfg) return null;

  if (!cfg.webauthn) {
    // WebAuthn não configurado → autofill nunca ativo. Só info quando webauthn ausente.
    return null;
  }

  return {
    level: 'ok',
    message:
      'passkey_autofill: WebAuthn is configured — conditional mediation (passkey autofill) is supported. ' +
      'Control via auth_methods.passkeyAutofill setting (default on when passkey is on). ' +
      'Requires browsers with PublicKeyCredential.isConditionalMediationAvailable() support.',
  };
}

/**
 * Allowlist de clients first-party — quem recebe as claims de autorização
 * (`<globalRolesClaim>`, `org_id`, `org_slug`, `org_role`).
 *
 * Informativa quando declarada. `warn` quando NÃO declarada, porque aí todo
 * client registrado recebe as claims ao pedir `scope=roles` — o que é o default
 * certo (o oposto apagava as roles de todo RP), mas um host que registra clients
 * de TERCEIROS precisa saber que existe uma lista para fechar.
 */
export function checkFirstPartyClients(input: DoctorInput): Finding | null {
  const cfg = input.authkitConfig;
  if (!cfg) return null;

  const allowlist = cfg.firstPartyClients as string[] | undefined;
  if (allowlist === undefined) {
    return {
      level: 'warn',
      message:
        'firstPartyClients is not declared: every registered client that requests `scope=roles` ' +
        'receives the roles and organization claims. That is the default on purpose — the claims ' +
        'are already gated by client registration and by the requested scope. Declare ' +
        '`firstPartyClients: [...]` in config/authkit.ts to restrict them to your own apps.',
    };
  }
  if (allowlist.length === 0) {
    return {
      level: 'ok',
      message:
        'firstPartyClients is an empty list: NO client receives the roles/organization claims. ' +
        'Remove the key entirely if you meant "no restriction".',
    };
  }
  return {
    level: 'ok',
    message: `firstPartyClients: ${allowlist.length} client(s) receive the roles/organization claims (${allowlist.join(', ')}).`,
  };
}

/**
 * Finding da idade da chave de assinatura managed. `ageDays === null` (sem
 * keystore em arquivo/cofre) → no-op `ok`. Acima de `maxAgeDays` → `warn`.
 */
export function signingKeyAgeFinding(ageDays: number | null, maxAgeDays: number): Finding {
  if (ageDays === null)
    return {
      level: 'ok',
      message: 'jwks: idade da chave não aplicável (sem keystore persistido).',
    };
  if (ageDays > maxAgeDays) {
    return {
      level: 'warn',
      message: `jwks: chave de assinatura tem ~${ageDays}d (> ${maxAgeDays}d) — considere rotacionar (authkit:keys:rotate).`,
    };
  }
  return { level: 'ok', message: `jwks: chave de assinatura tem ~${ageDays}d.` };
}

/** Roda todos os checks e devolve a lista plana de findings. */
export function runAllChecks(input: DoctorInput): Finding[] {
  const findings: Finding[] = [];
  findings.push(checkConfigResolves(input));
  findings.push(...checkIssuer(input));
  findings.push(checkClients(input));
  const volatility = checkAdapterVolatility(input);
  if (volatility) findings.push(volatility);
  findings.push(...checkAccountStore(input));
  findings.push(...checkAccountStoreColumns(input));
  findings.push(...checkSession(input));
  findings.push(checkShield(input));
  findings.push(checkAlly(input));
  findings.push(checkRateLimit(input));
  const admin = checkAdmin(input);
  if (admin) findings.push(admin);
  const requireVerified = checkRequireVerifiedEmail(input);
  if (requireVerified) findings.push(requireVerified);
  const botProtection = checkBotProtection(input);
  if (botProtection) findings.push(botProtection);
  const webauthn = checkWebauthn(input);
  if (webauthn) findings.push(webauthn);
  const passwordPolicy = checkPasswordPolicy(input);
  if (passwordPolicy) findings.push(passwordPolicy);
  const jwks = checkJwks(input);
  if (jwks) findings.push(jwks);
  const accessTokens = checkAccessTokens(input);
  if (accessTokens) findings.push(accessTokens);
  const orgs = checkOrganizations(input);
  if (orgs) findings.push(orgs);
  const settings = checkSettings(input);
  if (settings) findings.push(settings);
  const authMethods = checkAuthMethodsSetting(input);
  if (authMethods) findings.push(authMethods);
  const emailChange = checkEmailChange(input);
  if (emailChange) findings.push(emailChange);
  const securityNotifications = checkSecurityNotifications(input);
  if (securityNotifications) findings.push(securityNotifications);
  const pepper = checkPasswordPepper(input);
  if (pepper) findings.push(pepper);
  const passwordHistory = checkPasswordHistory(input);
  if (passwordHistory) findings.push(passwordHistory);
  const passwordExpiration = checkPasswordExpiration(input);
  if (passwordExpiration) findings.push(passwordExpiration);
  const sessionPolicy = checkSessionPolicy(input);
  if (sessionPolicy) findings.push(sessionPolicy);
  const rolesCatalog = checkRolesCatalog(input);
  if (rolesCatalog) findings.push(rolesCatalog);
  const otpLockout = checkOtpLockout(input);
  if (otpLockout) findings.push(otpLockout);
  const sudoMode = checkSudoMode(input);
  if (sudoMode) findings.push(sudoMode);
  const accountExpiration = checkAccountExpiration(input);
  if (accountExpiration) findings.push(accountExpiration);
  const passkeyAutofill = checkPasskeyAutofill(input);
  if (passkeyAutofill) findings.push(passkeyAutofill);
  const firstPartyClients = checkFirstPartyClients(input);
  if (firstPartyClients) findings.push(firstPartyClients);
  return findings;
}

/** Há algum finding de nível 'error'? (define o exit code). */
export function hasErrors(findings: Finding[]): boolean {
  return findings.some((f) => f.level === 'error');
}
