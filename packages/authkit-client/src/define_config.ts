import type { Identity, RunAccountExtensionCallOptions } from '@adonis-agora/authkit-core';
import { configProvider } from '@adonisjs/core';
import { type ResolvedAppCalls, resolveAppCalls, type ServiceInput } from './app_calls/config.js';
import type { SessionIndex } from './backchannel_logout.js';
import type { OidcEndpoints } from './discovery.js';
import type { ResiliencePolicy } from './http/resilient_fetch.js';
import type { ClientTenancyOptions } from './observability/context_bridge.js';
import { type ResolverFactory, resolvers } from './resolvers/factory.js';
import type { RevocationStore } from './revocation/revocation_store.js';

export { resolvers };

/** Callback invocado quando um logout_token válido chega via Back-Channel Logout. */
export type BackchannelLogoutCallback = (event: {
  sid?: string;
  sub?: string;
}) => Promise<void> | void;

/**
 * Back-Channel Logout "pronto" para sessões cookie-based: passe um {@link RevocationStore}
 * e o authkit cuida de tudo —
 *  - deriva o `onBackchannelLogout` (grava a revogação no store);
 *  - expõe o store p/ o `BackchannelRevocationMiddleware` enforçar em cada request.
 *
 * Substitui o trio model+service+middleware que o consumidor escrevia à mão.
 */
export interface BackchannelLogoutInput {
  /** Store que persiste/consulta revogações (ex.: `lucidRevocationStore({ connection: 'auth' })`). */
  store: RevocationStore;
}

/** `accountConsole` in `config/authkit_client.ts`: pages this app serves for the IdP's account console. */
export interface ClientAccountConsoleConfig {
  /**
   * Serve this app's account console extensions to the IdP over
   * `/.well-known/agora-account-extensions` (the IdP lists this app in its own
   * `accountConsole.remote`). Default `false`.
   */
  remote?: boolean;
  /**
   * Maps the IdP account to this app's subject (what billing, media and agents key on). Every
   * extension receives it as `ctx.subject`. Default `{ type: 'User', id: account.id }`.
   */
  subject?: RunAccountExtensionCallOptions['subject'];
  /** Budget of one page's `load()` / `visible()`, in ms. Default 5000. */
  loadTimeoutMs?: number;
  /** Budget of one action's `handle()`, in ms. Default 15000. */
  actionTimeoutMs?: number;
}

export interface ClientConfigInput {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  resolver: ResolverFactory;
  resolveUser?: (identity: Identity, context: { accessToken?: string }) => Promise<unknown>;
  sessionKey?: string;
  scopes?: string[];
  globalRolesClaim?: string;
  /**
   * Invocado após um logout_token VÁLIDO chegar via OIDC Back-Channel Logout. O host
   * usa o sid/sub recebido para destruir as sessões locais correspondentes.
   *
   * Para sessões cookie-based, prefira `backchannelLogout: { store }` — ele deriva
   * este callback automaticamente. Se ambos forem fornecidos, os dois rodam (store primeiro).
   */
  onBackchannelLogout?: BackchannelLogoutCallback;
  /** Índice sid/sub -> sessão local consultado pelo handler de back-channel logout. */
  sessionIndex?: SessionIndex;
  /** Back-Channel Logout "pronto" para sessões cookie-based — ver {@link BackchannelLogoutInput}. */
  backchannelLogout?: BackchannelLogoutInput;
  /**
   * Política de resiliência OPCIONAL aplicada às chamadas HTTP de saída ao IdP
   * (OIDC discovery + token endpoints). Opt-in: sem ela, o comportamento é um
   * `fetch` puro (nenhuma mudança).
   *
   * Passe o resultado de `wrap(...)` de `@adonis-agora/resilience`, ex.:
   * `resilience: wrap(timeout(2000), retry({ attempts: 3 }))`. Tipado
   * estruturalmente — o authkit-client não importa o pacote de resiliência.
   */
  resilience?: ResiliencePolicy;
  /**
   * Resolve the IdP endpoints from `{issuer}/.well-known/openid-configuration`.
   * Default: `true` — works with authkit-server and any third-party IdP
   * (Keycloak, Auth0, Okta, Entra…).
   *
   * Discovery runs lazily, on first use, so the app boots while the IdP is down.
   * A failure throws `OidcDiscoveryError` and is retried on the next request; a
   * previously discovered document keeps being served while refetches fail.
   * Concurrent callers share one fetch per issuer; once `cacheTtlMs` (default
   * 15 min) runs out, the cached document is served while one background refetch
   * replaces it. Each request attempt is aborted after 10 s.
   *
   * `false` skips the network and uses `endpoints` on top of the authkit-server
   * convention (`/auth`, `/token`, `/jwks`, `/session/end`).
   */
  discovery?: boolean | { cacheTtlMs?: number };
  /** Per-field endpoint overrides; always win over discovery. */
  endpoints?: Partial<OidcEndpoints>;
  /**
   * How the session's tenant is published into `@adonis-agora/context` (the active
   * organization by default). See {@link ClientTenancyOptions}: `eager`, `personal`,
   * `resolve`. No effect without `@adonis-agora/context`.
   */
  tenancy?: ClientTenancyOptions;
  /** Account console pages this app serves to the IdP. See {@link ClientAccountConsoleConfig}. */
  accountConsole?: ClientAccountConsoleConfig;
  /**
   * Organization names for every console's org picker (`Context.tenantLabels`): the active
   * org from the `org_name` claim, any other from the authkit server's
   * `GET /api/orgs/labels` (authenticated with `clientId`/`clientSecret`), cached.
   * Installed at boot when `@adonis-agora/context` is present, the client is confidential
   * and authkit-server does not run in this app. `false` turns it off. Default: on.
   */
  orgLabels?: false | ClientOrgLabelsConfig;
  /**
   * This app as a service, for calls between apps: its `name` (requests carrying a token
   * for `urn:agora:app:<name>` get `ctx.agora.caller`) and the `clientId`/`clientSecret` of
   * its service-tenant client (to call other apps: found by the published service
   * discovery, or in `apps`). See {@link ServiceInput}.
   */
  service?: ServiceInput;
  /**
   * Apps by origin, name → origin: `{ billing: 'https://billing.example.com' }`. Overrides
   * the published service discovery (telescope), and is the whole answer without one. A
   * plain `fetch` to exactly a known app's origin carries a token for that app; nothing is
   * added for any other origin. Needs `service` with credentials.
   */
  apps?: Record<string, string>;
}

/** `orgLabels` in `config/authkit_client.ts`. */
export interface ClientOrgLabelsConfig {
  /** The labels endpoint. Default: `/api/orgs/labels` on the issuer's origin. */
  endpoint?: string;
  /** How long a label is reused, in ms. Default: 5 minutes. */
  ttlMs?: number;
}

export interface ResolvedClientConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  resolverFactory: ResolverFactory;
  resolveUser?: (identity: Identity, context: { accessToken?: string }) => Promise<unknown>;
  sessionKey: string;
  scopes: string[];
  globalRolesClaim: string;
  onBackchannelLogout?: BackchannelLogoutCallback;
  sessionIndex?: SessionIndex;
  /** Store de revogação (cookie-based BCL); consumido pelo BackchannelRevocationMiddleware. */
  backchannelStore?: RevocationStore;
  /** Política de resiliência opcional p/ chamadas HTTP de saída ao IdP. Ver {@link ClientConfigInput.resilience}. */
  resilience?: ResiliencePolicy;
  /** `false` when discovery is off; otherwise its options. See {@link ClientConfigInput.discovery}. */
  discovery: false | { cacheTtlMs?: number };
  /** Endpoint overrides. See {@link ClientConfigInput.endpoints}. */
  endpoints?: Partial<OidcEndpoints>;
  /** Tenancy options. See {@link ClientConfigInput.tenancy}. */
  tenancy?: ClientTenancyOptions;
  /** See {@link ClientConfigInput.accountConsole}. */
  accountConsole?: ClientAccountConsoleConfig;
  /** See {@link ClientConfigInput.orgLabels}. Absent means on with the defaults. */
  orgLabels?: false | ClientOrgLabelsConfig;
  /** Calls between apps (`service` + `apps`). Absent when `service` is not configured. */
  appCalls?: ResolvedAppCalls;
}

export function defineConfig(config: ClientConfigInput) {
  return configProvider.create(async (): Promise<ResolvedClientConfig> => {
    const appCalls = resolveAppCalls(config.service, config.apps);
    const store = config.backchannelLogout?.store;

    // Compõe o callback de back-channel: o store grava a revogação; o callback do
    // usuário (se houver) roda depois. Mantém retrocompat com `onBackchannelLogout`.
    const userHook = config.onBackchannelLogout;
    const onBackchannelLogout: BackchannelLogoutCallback | undefined =
      store || userHook
        ? async (event) => {
            if (store) await store.revoke(event);
            if (userHook) await userHook(event);
          }
        : undefined;

    return {
      issuer: config.issuer,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      resolverFactory: config.resolver,
      resolveUser: config.resolveUser,
      sessionKey: config.sessionKey ?? 'authkit',
      scopes: config.scopes ?? ['openid', 'profile', 'email', 'offline_access', 'roles'],
      globalRolesClaim: config.globalRolesClaim ?? 'roles',
      onBackchannelLogout,
      sessionIndex: config.sessionIndex,
      backchannelStore: store,
      resilience: config.resilience,
      discovery:
        config.discovery === false
          ? false
          : typeof config.discovery === 'object'
            ? config.discovery
            : {},
      endpoints: config.endpoints,
      tenancy: config.tenancy ?? {},
      ...(config.accountConsole ? { accountConsole: config.accountConsole } : {}),
      ...(config.orgLabels !== undefined ? { orgLabels: config.orgLabels } : {}),
      ...(appCalls ? { appCalls } : {}),
    };
  });
}
