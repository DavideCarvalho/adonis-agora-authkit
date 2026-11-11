/**
 * `poppy()` — o Personal Agent Protocol como uma `personalAgents.extensions` do authkit-server:
 *
 * ```ts
 * // config/authkit.ts
 * import { poppy } from '@adonis-agora/authkit-poppy'
 *
 * export default defineConfig({
 *   // ...
 *   personalAgents: {
 *     extensions: [poppy({ organization: { name: 'Shop', domain: 'shop.example' }, scopes: { … } })],
 *   },
 * })
 * ```
 *
 * Mesmas rotas, tabelas, tokens e slots globais de quando o Poppy morava dentro do authkit-server.
 */
import type {
  PersonalAgentExtension,
  PersonalAgentHost,
  PersonalAgentRouteKit,
} from '@adonis-agora/authkit-server';
import { PoppyClientRegistry } from './client_registry.js';
import {
  type PoppyConfigInput,
  type PoppyLimiter,
  type PoppyReplayStore,
  type ResolvedPoppyConfig,
  resolvePoppyConfig,
} from './config.js';
import { hmacNonceSource } from './dpop.js';
import { POPPY_MESSAGES } from './messages.js';
import {
  databaseReplayStore,
  memoryLimiter,
  memoryReplayStore,
  redisReplayStore,
} from './replay.js';
import { installPoppySlots } from './resource.js';
import { POPPY_PROTOCOL_ID } from './runtime.js';
import type { JsonFetcher } from './safe_fetch.js';
import { type PoppyMcpBridge, PoppyService, poppyUrls } from './service.js';
import { PoppyStore } from './store.js';
import { POPPY_TABLES } from './tables.js';
import { isPoppyBrowser } from './web_session.js';

/** Prefixo dos ids dos grants (refresh tokens) do Poppy no ledger do authkit. */
export const POPPY_GRANT_PREFIX = 'pgrant_';

/** Opções da extension além do config do protocolo. */
export interface PoppyExtensionOptions {
  /**
   * SÓ TESTES: busca de JSON (metadata/JWKS dos agentes) no lugar da busca com guarda de SSRF.
   */
  fetchJson?: JsonFetcher;
}

const PoppyController = () => import('./controllers/poppy_controller.js');
const PoppyConsentController = () => import('./controllers/poppy_consent_controller.js');

/**
 * Discovery, authorization server (token, revogação, device authorization), Mediated Sign-In e
 * sessão de navegador — server-to-server ou POST cross-site do navegador do agente (sem CSRF, ver
 * `csrfExemptPaths`). As telas do usuário (authorize/device) exigem a sessão de conta e mantêm o
 * CSRF.
 */
function registerRoutes(router: any, prefix: string, kit: PersonalAgentRouteKit): void {
  // Nomes explícitos: o Router nomeia pela dupla controller.método, e as duas URLs da metadata
  // (RFC 8414 na raiz e debaixo do issuer) usam o mesmo — "poppy.metadata already exists" no boot.
  router
    .get('/.well-known/poppy.json', [PoppyController, 'discovery'])
    .as('authkit.poppy.discovery');
  router
    .get('/.well-known/oauth-protected-resource', [PoppyController, 'protectedResource'])
    .as('authkit.poppy.protected_resource');
  router
    .get(`/.well-known/oauth-authorization-server${prefix}`, [PoppyController, 'metadata'])
    .as('authkit.poppy.metadata');
  router
    .get(`${prefix}/.well-known/oauth-authorization-server`, [PoppyController, 'metadata'])
    .as('authkit.poppy.metadata_under_issuer');
  router.post(`${prefix}/oauth/token`, [PoppyController, 'token']).as('authkit.poppy.token');
  router.post(`${prefix}/oauth/revoke`, [PoppyController, 'revoke']).as('authkit.poppy.revoke');
  router
    .post(`${prefix}/oauth/device`, [PoppyController, 'deviceAuthorization'])
    .as('authkit.poppy.device_authorization');
  // A página grava um pedido sem autenticação: throttle por IP.
  kit.throttle.login(
    router
      .get(`${prefix}/browser-session`, [PoppyController, 'browserSessionPage'])
      .as('authkit.poppy.browser_session_page'),
  );
  router
    .post(`${prefix}/browser-session`, [PoppyController, 'browserSession'])
    .as('authkit.poppy.browser_session');
  router
    .post(`${prefix}/browser-session/authorize`, [PoppyController, 'browserSessionAuthorize'])
    .as('authkit.poppy.browser_session_authorize');
  router
    .group(() => {
      router
        .get(`${prefix}/oauth/authorize`, [PoppyConsentController, 'authorize'])
        .as('authkit.poppy.authorize');
      router
        .post(`${prefix}/oauth/authorize`, [PoppyConsentController, 'decideAuthorization'])
        .as('authkit.poppy.authorize_decide');
      kit.throttle.otp(
        router
          .get(`${prefix}/device`, [PoppyConsentController, 'device'])
          .as('authkit.poppy.device'),
      );
      kit.throttle.otp(
        router
          .post(`${prefix}/device`, [PoppyConsentController, 'decideDevice'])
          .as('authkit.poppy.device_decide'),
      );
    })
    .use([kit.accountGuard]);
}

/**
 * O registro do console admin por cima do config: um agente BLOQUEADO no console é recusado mesmo
 * que o config o registre; um LIBERADO entra mesmo fora da lista. O que o config bloqueia continua
 * bloqueado.
 */
function withRegistry(cfg: ResolvedPoppyConfig, host: PersonalAgentHost): ResolvedPoppyConfig {
  return {
    ...cfg,
    clients: {
      ...cfg.clients,
      isBlocked: async (id) =>
        (await cfg.clients.isBlocked(id)) || (await host.registryStatus(id)) === 'blocked',
      isRegistered: async (id) =>
        (await cfg.clients.isRegistered(id)) || (await host.registryStatus(id)) === 'allowed',
    },
  };
}

async function resolveReplay(
  replay: ResolvedPoppyConfig['replay'],
  host: PersonalAgentHost,
): Promise<PoppyReplayStore> {
  if (replay === 'memory') return memoryReplayStore();
  if (replay === 'database') return databaseReplayStore(() => host.db());
  if (typeof (replay as PoppyReplayStore).claim === 'function') return replay as PoppyReplayStore;
  const redis = await host.make('redis');
  return redisReplayStore(redis.connection((replay as { redis: string }).redis));
}

/** Bearer de MCP de Sessions logadas viram access tokens do oidc-provider (§7). */
function mcpBridge(cfg: ResolvedPoppyConfig, host: PersonalAgentHost): PoppyMcpBridge {
  const tokens = host.accessTokens;
  const trim = (url: string) => url.replace(/\/+$/, '');
  return {
    isMcpResource: (url) => tokens.isMcpResource(url),
    async mint(input) {
      // Só com a integração MCP do authkit ligada, ou um MCP declarado em `apis`.
      if (
        !tokens.mcpEnabled &&
        !cfg.apis.some((a) => a.type === 'mcp' && trim(a.url) === trim(input.resource))
      ) {
        return null;
      }
      return tokens.mint({ ...input, grantType: POPPY_PROTOCOL_ID });
    },
    revoke: (grantId) => tokens.revokeGrant(grantId),
  };
}

/**
 * O Personal Agent Protocol ("Poppy", Draft 0.3) para `personalAgents.extensions`.
 *
 * @experimental Acompanha uma spec em draft: este pacote fica no 0.x e pode quebrar em qualquer
 *   minor.
 */
export function poppy(
  config: PoppyConfigInput,
  options: PoppyExtensionOptions = {},
): PersonalAgentExtension<PoppyService> {
  return {
    id: POPPY_PROTOCOL_ID,
    resolve(context) {
      const resolved = resolvePoppyConfig(config, context.delegationScopes ?? undefined)!;
      const csrfExemptPaths = [
        `${resolved.prefix}/oauth/token`,
        `${resolved.prefix}/oauth/revoke`,
        `${resolved.prefix}/oauth/device`,
        `${resolved.prefix}/browser-session`,
        `${resolved.prefix}/browser-session/authorize`,
      ];
      return {
        label: 'Poppy',
        grantIdPrefix: POPPY_GRANT_PREFIX,
        prefix: resolved.prefix,
        csrfExemptPaths,
        tables: POPPY_TABLES,
        messages: POPPY_MESSAGES,
        isAgentBrowser: (ctx) => isPoppyBrowser(ctx),
        boot() {
          // O slot global que o `@adonis-agora/agent` usa para autenticar o endpoint de conversas
          // (e o MCP) sem importar este pacote — o contrato é o símbolo.
          installPoppySlots(poppyUrls(context.issuer, resolved.prefix).issuer);
        },
        routes: (router, kit) => registerRoutes(router, resolved.prefix, kit),
        async setup(host) {
          const cfg = withRegistry(resolved, host);
          const limiter: PoppyLimiter | null =
            cfg.rateLimit === false
              ? null
              : typeof cfg.rateLimit === 'function'
                ? cfg.rateLimit
                : memoryLimiter(cfg.rateLimit);
          return new PoppyService({
            cfg,
            urls: poppyUrls(host.issuer, cfg.prefix),
            store: new PoppyStore(() => host.db()),
            grants: host.grants,
            registry: new PoppyClientRegistry(cfg, { fetchJson: options.fetchJson }),
            replay: await resolveReplay(cfg.replay, host),
            limiter,
            nonces: hmacNonceSource(host.deriveSecret('poppy-dpop-nonce')),
            isAccountActive: (accountId) => host.isAccountActive(accountId),
            mcp: mcpBridge(cfg, host),
            now: () => host.now(),
          });
        },
      };
    },
  };
}
