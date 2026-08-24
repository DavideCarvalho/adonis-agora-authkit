import { supportsMagicLink } from '../accounts/account_store.js';
import { supportsPasskeys } from '../accounts/account_store.js';
import { supportsLoginMethodsPreference } from '../accounts/account_store.js';
import type { ResolvedServerConfig } from '../define_config.js';
import type { SettingsCapability } from './runtime_settings.js';
import { resolveEffectiveAuthMethods } from './runtime_toggles.js';
import { configLockedAuthMethods } from './runtime_toggles.js';
import {
  type UserLoginMethods,
  normalizeUserLoginMethods,
  resolveEffectiveUserLoginMethods,
} from './user_login_methods.js';

/** Resultado compartilhado de "estado de tipos de login" entregue à UI. */
export interface LoginMethodsState {
  supported: boolean;
  /** Preferência crua do usuário; {} = sem preferência (herda globais). */
  methods: UserLoginMethods | Record<string, never>;
  /** Estado final por método (global ∩ preferência) — o que a tela de login mostra. */
  available: {
    password: boolean;
    magicLink: boolean;
    passkey: boolean;
    social: string[];
    forgotPassword: boolean;
  } | null;
  /** Métodos fora do controle do usuário (globalmente off ou pin de config). */
  locked: {
    password: boolean;
    magicLink: boolean;
    passkey: boolean;
    social: boolean;
  } | null;
}

/**
 * Métodos globais efetivos + pins de config — resolução compartilhada entre o
 * console (account API) e a API headless. Fail-safe: erro → defaults.
 */
export async function resolveGlobalAuthMethods(
  settings: SettingsCapability,
  cfg: ResolvedServerConfig,
) {
  const resolved = await resolveEffectiveAuthMethods(settings, {
    configuredSocialProviders: cfg.social?.providers ?? [],
    magicLinkCapable: cfg.passwordless?.magicLink && supportsMagicLink(cfg.accountStore),
    passkeyCapable: supportsPasskeys(cfg.accountStore),
    configOverrides: cfg.authMethods,
  });
  return { resolved, locked: configLockedAuthMethods(cfg.authMethods) };
}

/**
 * Monta o estado final de tipos de login para uma conta, intersectando a
 * preferência do usuário com os métodos globais efetivos. Reusado pelo console
 * de conta (`/account/api/login-methods`) e pela API headless
 * (`{baseUrl}/login-methods`) — sem duplicar regra.
 */
export async function loginMethodsStateForAccount(
  accountId: string,
  store: ResolvedServerConfig['accountStore'],
  settings: SettingsCapability,
  cfg: ResolvedServerConfig,
): Promise<LoginMethodsState> {
  if (!supportsLoginMethodsPreference(store)) {
    return { supported: false, methods: {}, available: null, locked: null };
  }

  const pref = normalizeUserLoginMethods(await store.getLoginMethods(accountId));
  const { resolved: global, locked: cfgLocked } = await resolveGlobalAuthMethods(settings, cfg);
  const effective = resolveEffectiveUserLoginMethods(global, pref);

  return {
    supported: true,
    // Preferência crua do usuário; {} = sem preferência (herda globais).
    methods: pref ?? {},
    available: {
      password: effective.password,
      magicLink: effective.magicLink,
      passkey: effective.passkey,
      social: effective.social,
      forgotPassword: effective.forgotPassword,
    },
    // Métodos que o usuário NÃO pode controlar (globalmente off ou pin de config).
    locked: {
      password: !global.password || cfgLocked.includes('password'),
      magicLink: !global.magicLink || cfgLocked.includes('magicLink'),
      passkey: !global.passkey || cfgLocked.includes('passkey'),
      social: global.social.length === 0,
    },
  };
}
