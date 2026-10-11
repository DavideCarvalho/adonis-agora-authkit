import type { HttpContext } from '@adonisjs/core/http';
import { supportsAccountStatus } from '../accounts/account_store.js';
import { findMcpResource } from '../mcp/mcp_oauth.js';
import type { OidcService } from '../provider/oidc_service.js';
import { PersonalAgentVerifier } from './agent_identity.js';
import type { ResolvedPersonalAgentsConfig } from './config.js';
import { PersonalAgentDelegation } from './delegation_service.js';
import { DelegationStore } from './delegation_store.js';
import { PoppyClientRegistry } from './poppy/client_registry.js';
import type { PoppyLimiter, PoppyReplayStore } from './poppy/config.js';
import { hmacNonceSource } from './poppy/dpop.js';
import {
  databaseReplayStore,
  memoryLimiter,
  memoryReplayStore,
  redisReplayStore,
} from './poppy/replay.js';
import type { JsonFetcher } from './poppy/safe_fetch.js';
import { type PoppyMcpBridge, PoppyService, poppyUrls } from './poppy/service.js';
import { PoppyStore } from './poppy/store.js';
import { keystoreSigner } from './signer.js';

/** URLs públicas do authorization server de delegação. */
export interface PersonalAgentUrls {
  /** `issuer` (RFC 8414) — também o `iss` dos tokens de delegação. */
  issuer: string;
  metadata: string;
  jwks: string;
  deviceAuthorization: string;
  token: string;
  /** Tela de consentimento — o `verification_uri` do device flow. */
  consent: string;
}

/**
 * Deriva as URLs da ORIGEM do issuer configurado — nunca do Host da request
 * (mesma regra dos links de e-mail: um Host forjado não pode virar o `iss`).
 */
export function personalAgentUrls(oidcIssuer: string, prefix: string): PersonalAgentUrls {
  const origin = new URL(oidcIssuer).origin;
  const issuer = `${origin}${prefix}/oauth`;
  return {
    issuer,
    metadata: `${issuer}/.well-known/oauth-authorization-server`,
    jwks: `${issuer}/jwks.json`,
    deviceAuthorization: `${issuer}/device_authorization`,
    token: `${issuer}/token`,
    consent: `${origin}${prefix}/consent`,
  };
}

/** Tudo que as rotas e o middleware de personal agents usam, já montado. */
export interface PersonalAgentsRuntime {
  config: ResolvedPersonalAgentsConfig;
  urls: PersonalAgentUrls;
  /** Verificador do JWT do agente PACT (inerte quando o PACT está desligado — veja `config.pact`). */
  verifier: PersonalAgentVerifier;
  /** `null` quando o app não configurou `personalAgents.delegation`. */
  delegation: PersonalAgentDelegation | null;
  /** `null` quando o app não configurou `personalAgents.poppy`. */
  poppy: PoppyService | null;
  /** Revoga um grant de personal agent DA CONTA (PACT ou Poppy). */
  revokeAgentGrant(accountId: string, grantId: string): Promise<boolean>;
  /** Revoga todos os grants de personal agents da conta. Devolve quantos estavam vivos. */
  revokeAllAgentGrants(accountId: string): Promise<number>;
}

const runtimes = new WeakMap<OidcService, Promise<PersonalAgentsRuntime | null>>();

export interface BuildPersonalAgentsOptions {
  /** Resolve serviços do container (redis do replay store). */
  make?: (binding: string) => Promise<any>;
  /** Busca de JSON (metadata/JWKS dos agentes Poppy) — injetável nos testes. */
  fetchJson?: JsonFetcher;
  now?: () => Date;
}

/** Ponte Poppy → oidc-provider: Bearer de MCP de Sessions logadas viram access tokens dele. */
function mcpBridge(
  service: OidcService,
  poppyApis: { type: string; url: string }[],
): PoppyMcpBridge {
  return {
    isMcpResource(url) {
      try {
        return findMcpResource(url, service.config.issuer, service.config.mcp) !== null;
      } catch {
        return false;
      }
    },
    async mint(input) {
      const provider = service.provider as any;
      if (!provider?.AccessToken || !provider?.Grant) return null;
      // Só faz sentido quando a integração MCP do authkit está ligada, ou o MCP é de `apis`.
      if (
        !service.config.mcp?.enabled &&
        !poppyApis.some(
          (a) =>
            a.type === 'mcp' && a.url.replace(/\/+$/, '') === input.resource.replace(/\/+$/, ''),
        )
      ) {
        return null;
      }
      const remaining = Math.max(
        60,
        Math.floor((input.grantExpiresAt.getTime() - Date.now()) / 1000),
      );
      let grant = await provider.Grant.find(input.grantId);
      if (!grant) {
        grant = new provider.Grant({
          jti: input.grantId,
          accountId: input.accountId,
          clientId: input.clientId,
          expiresIn: remaining,
        });
        await grant.save();
      }
      const at = new provider.AccessToken({
        accountId: input.accountId,
        clientId: input.clientId,
        grantId: input.grantId,
        scope: input.scope,
        gty: 'poppy',
        expiresIn: input.expiresIn,
      });
      at.aud = input.resource;
      return at.save();
    },
    async revoke(grantId) {
      const provider = service.provider as any;
      if (!provider?.Grant) return;
      await provider.AccessToken?.revokeByGrantId?.(grantId);
      const grant = await provider.Grant.find(grantId);
      if (grant) await grant.destroy();
    },
  };
}

async function resolveReplay(
  replay: NonNullable<ResolvedPersonalAgentsConfig['poppy']>['replay'],
  conn: () => any,
  make?: (binding: string) => Promise<any>,
): Promise<PoppyReplayStore> {
  if (replay === 'memory') return memoryReplayStore();
  if (replay === 'database') return databaseReplayStore(conn);
  if (typeof (replay as PoppyReplayStore).claim === 'function') return replay as PoppyReplayStore;
  const name = (replay as { redis: string }).redis;
  if (!make) throw new Error('authkit: personalAgents.poppy.replay { redis } exige o container.');
  const redis = await make('redis');
  return redisReplayStore(redis.connection(name));
}

/**
 * Monta (uma vez por `OidcService`) o runtime de personal agents. `null` quando
 * `personalAgents` não está no config — as rotas respondem 404.
 */
export function buildPersonalAgentsRuntime(
  service: OidcService,
  makeDb: () => Promise<any>,
  options: BuildPersonalAgentsOptions = {},
): Promise<PersonalAgentsRuntime | null> {
  let runtime = runtimes.get(service);
  if (!runtime) {
    runtime = (async () => {
      const config = service.config.personalAgents;
      if (!config) return null;
      const urls = personalAgentUrls(service.config.issuer, config.prefix);
      // Conta apagada ou suspensa corta a delegação na hora.
      const isAccountActive = async (accountId: string) => {
        const store = service.config.accountStore;
        if (!(await store.findById(accountId))) return false;
        return !(supportsAccountStatus(store) && (await store.isDisabled(accountId)));
      };

      let conn: (() => any) | null = null;
      if (config.delegation || config.poppy) {
        const db = await makeDb();
        const connection = service.config.schema.connection;
        conn = () => (connection ? db.connection(connection) : db.connection());
      }
      const store = conn ? new DelegationStore(conn) : null;

      let delegation: PersonalAgentDelegation | null = null;
      if (config.delegation && store) {
        delegation = new PersonalAgentDelegation({
          cfg: config.delegation,
          store,
          signer: keystoreSigner(service),
          urls: { issuer: urls.issuer, consent: urls.consent },
          isAccountActive,
        });
      }

      let poppy: PoppyService | null = null;
      if (config.poppy && store && conn) {
        const cfg = config.poppy;
        const limiter: PoppyLimiter | null =
          cfg.rateLimit === false
            ? null
            : typeof cfg.rateLimit === 'function'
              ? cfg.rateLimit
              : memoryLimiter(cfg.rateLimit);
        const secret = service.deriveSecret('poppy-dpop-nonce');
        poppy = new PoppyService({
          cfg,
          urls: poppyUrls(service.config.issuer, cfg.prefix),
          store: new PoppyStore(conn),
          grants: store,
          registry: new PoppyClientRegistry(cfg, { fetchJson: options.fetchJson }),
          replay: await resolveReplay(cfg.replay, conn, options.make),
          limiter,
          nonces: hmacNonceSource(secret),
          isAccountActive,
          mcp: mcpBridge(service, cfg.apis),
          now: options.now,
        });
      }

      const revokeAgentGrant = async (accountId: string, grantId: string) => {
        if (grantId.startsWith('pgrant_')) {
          return poppy ? poppy.revokeAccountGrant(accountId, grantId) : false;
        }
        return delegation ? delegation.revokeGrant(accountId, grantId) : false;
      };
      const revokeAllAgentGrants = async (accountId: string) => {
        let count = 0;
        if (poppy) count += await poppy.revokeAllAccountGrants(accountId);
        if (delegation) count += await delegation.revokeAllGrants(accountId);
        return count;
      };

      return {
        config,
        urls,
        verifier: new PersonalAgentVerifier(config),
        delegation,
        poppy,
        revokeAgentGrant,
        revokeAllAgentGrants,
      };
    })();
    // Falha (DB indisponível) não fica em cache — a próxima request tenta de novo.
    runtime.catch(() => runtimes.delete(service));
    runtimes.set(service, runtime);
  }
  return runtime;
}

/** Runtime a partir de uma request. */
export async function personalAgentsFor(ctx: HttpContext): Promise<PersonalAgentsRuntime | null> {
  const service = await ctx.containerResolver.make('authkit.server');
  return buildPersonalAgentsRuntime(service, () => ctx.containerResolver.make('lucid.db'), {
    make: (binding) => ctx.containerResolver.make(binding as any),
  });
}
