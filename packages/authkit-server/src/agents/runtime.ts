import type { HttpContext } from '@adonisjs/core/http';
import { getBootedApp } from '../../services/booted_app.js';
import { supportsAccountStatus } from '../accounts/account_store.js';
import { mcpClientsState, mcpClientsStateSync } from '../mcp/mcp_clients.js';
import { findMcpResource } from '../mcp/mcp_oauth.js';
import type { OidcService } from '../provider/oidc_service.js';
import { authkitTable } from '../schema/tables_location.js';
import { PersonalAgentVerifier } from './agent_identity.js';
import type { PersonalAgentRegistration, ResolvedPersonalAgentsConfig } from './config.js';
import { PersonalAgentDelegation } from './delegation_service.js';
import { DelegationStore, type GrantRow } from './delegation_store.js';
import type {
  PersonalAgentAccessTokens,
  PersonalAgentGrantLedger,
  PersonalAgentProtocolRuntime,
  ResolvedPersonalAgentExtension,
} from './extension.js';
import { type AgentProtocolId, AgentRegistryStore } from './registry_store.js';
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
  /**
   * Runtimes de `personalAgents.extensions`, por id do protocolo. Vazio sem extensions ou sem
   * banco.
   */
  extensions: Map<
    string,
    { extension: ResolvedPersonalAgentExtension; runtime: PersonalAgentProtocolRuntime }
  >;
  /** Revoga um grant de personal agent DA CONTA (PACT ou de uma extension). */
  revokeAgentGrant(accountId: string, grantId: string): Promise<boolean>;
  /** Revoga todos os grants de personal agents da conta. Devolve quantos estavam vivos. */
  revokeAllAgentGrants(accountId: string): Promise<number>;
  /**
   * Registro do console admin (agentes liberados/bloqueados além do config).
   * `null` sem banco (PACT só de identidade sem `lucid.db`).
   */
  registry: AgentRegistryStore | null;
  /** Grants de todas as contas (console admin). `null` sem banco. */
  grants: DelegationStore | null;
  /** Revoga um grant de QUALQUER conta (console admin). Devolve o grant, ou `null` se já não valia. */
  revokeGrantById(grantId: string): Promise<GrantRow | null>;
  /** Desconecta um agente de todas as contas (bloqueio). Devolve quantos grants estavam vivos. */
  disconnectAgent(protocol: AgentProtocolId, identifier: string): Promise<number>;
}

const runtimes = new WeakMap<OidcService, Promise<PersonalAgentsRuntime | null>>();

export interface BuildPersonalAgentsOptions {
  /** Resolve serviços do container (redis do replay store). */
  make?: (binding: string) => Promise<any>;
  now?: () => Date;
}

/** Access tokens do oidc-provider para resources MCP (ver {@link PersonalAgentAccessTokens}). */
function accessTokens(service: OidcService): PersonalAgentAccessTokens {
  return {
    // Síncrono: a última leitura da setting `mcp_clients` (cada leitura relê em background).
    get mcpEnabled() {
      void mcpClientsState(service.config.mcpClients).catch(() => {});
      return mcpClientsStateSync(service.config.mcpClients).enabled;
    },
    isMcpResource(url) {
      try {
        const state = mcpClientsStateSync(service.config.mcpClients);
        return (
          findMcpResource(url, service.config.issuer, {
            enabled: state.enabled,
            resources: service.config.mcpClients.resources,
          }) !== null
        );
      } catch {
        return false;
      }
    },
    async mint(input) {
      const provider = service.provider as any;
      if (!provider?.AccessToken || !provider?.Grant) return null;
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
        gty: input.grantType,
        expiresIn: input.expiresIn,
      });
      at.aud = input.resource;
      return at.save();
    },
    async revokeGrant(grantId) {
      const provider = service.provider as any;
      if (!provider?.Grant) return;
      await provider.AccessToken?.revokeByGrantId?.(grantId);
      const grant = await provider.Grant.find(grantId);
      if (grant) await grant.destroy();
    },
  };
}

/** O ledger de grants visto por uma extension: só os ids com o prefixo dela. */
function scopedLedger(store: DelegationStore, prefix: string): PersonalAgentGrantLedger {
  const mine = (id: string) => typeof id === 'string' && id.startsWith(prefix);
  return {
    async insertGrant(grant) {
      if (!mine(grant.id)) {
        throw new Error(`authkit: grant "${grant.id}" fora do prefixo "${prefix}" da extension.`);
      }
      await store.insertGrant(grant);
    },
    async findGrant(id) {
      return mine(id) ? store.findGrant(id) : null;
    },
    async listGrants(accountId) {
      return (await store.listGrants(accountId)).filter((g) => mine(g.id));
    },
    async unrevokedGrantIdsOfClient(clientId) {
      return (await store.unrevokedGrantIdsOfClient(clientId)).filter(mine);
    },
    async revokeGrantById(id, at) {
      if (mine(id)) await store.revokeGrantById(id, at);
    },
    insertRefreshToken: (token) => store.insertRefreshToken(token),
    findRefreshToken: (tokenHash) => store.findRefreshToken(tokenHash),
  };
}

/**
 * Config com o registro do console por cima: um agente BLOQUEADO no console é
 * recusado mesmo que o config o liste; um LIBERADO entra mesmo fora da lista.
 * O que o config bloqueia continua bloqueado.
 */
function withRegistry(
  config: ResolvedPersonalAgentsConfig,
  registry: AgentRegistryStore,
): ResolvedPersonalAgentsConfig {
  const resolveAgent = async (issuer: string): Promise<PersonalAgentRegistration | null> => {
    const row = await registry.find('pact', issuer);
    if (row?.status === 'blocked') {
      return { issuer, jwksUri: row.jwksUri ?? '', name: row.name ?? undefined, enabled: false };
    }
    const configured = await config.resolveAgent(issuer);
    if (configured) return configured;
    if (row?.status === 'allowed' && row.jwksUri) {
      return { issuer, jwksUri: row.jwksUri, name: row.name ?? undefined };
    }
    return null;
  };
  return { ...config, resolveAgent };
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
      const connection = service.config.schema.connection;
      if (config.delegation || (config.extensions ?? []).length > 0) {
        const db = await makeDb();
        conn = () => (connection ? db.connection(connection) : db.connection());
      } else {
        // PACT só de identidade não precisa de banco; com ele, o console pode bloquear.
        try {
          const db = await makeDb();
          if (db) conn = () => (connection ? db.connection(connection) : db.connection());
        } catch {
          conn = null;
        }
      }
      // Com `schema.name`, cada statement escreve `schema.tabela`.
      const tableName = (name: string) =>
        authkitTable({ schema: service.config.schema.name }, name);
      const store = conn ? new DelegationStore(conn, tableName) : null;
      const registry = conn ? new AgentRegistryStore(conn, { table: tableName }) : null;
      const effective = registry ? withRegistry(config, registry) : config;

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

      const extensions: PersonalAgentsRuntime['extensions'] = new Map();
      const now = () => options.now?.() ?? new Date();
      if (store && conn && registry) {
        const db = conn;
        const tokens = accessTokens(service);
        for (const extension of config.extensions ?? []) {
          const runtime = await extension.setup({
            protocol: extension.id,
            issuer: service.config.issuer,
            db: () => db(),
            table: tableName,
            grants: scopedLedger(store, extension.grantIdPrefix),
            registryStatus: async (identifier) =>
              (await registry.find(extension.id, identifier))?.status ?? null,
            deriveSecret: (label) => service.deriveSecret(label),
            isAccountActive,
            make: async (binding) => {
              if (!options.make) {
                throw new Error(`authkit: o binding "${binding}" exige o container do app.`);
              }
              return options.make(binding);
            },
            accessTokens: tokens,
            now,
          });
          extensions.set(extension.id, { extension, runtime });
        }
      }
      /** A extension dona de um grant, pelo prefixo do id. */
      const ownerOf = (grantId: string) => {
        for (const entry of extensions.values()) {
          if (grantId.startsWith(entry.extension.grantIdPrefix)) return entry;
        }
        return null;
      };
      const isExtensionGrant = (grantId: string) =>
        (config.extensions ?? []).some((e) => grantId.startsWith(e.grantIdPrefix));

      const revokeAgentGrant = async (accountId: string, grantId: string) => {
        if (isExtensionGrant(grantId)) {
          const owner = ownerOf(grantId);
          return owner ? owner.runtime.revokeAccountGrant(accountId, grantId) : false;
        }
        return delegation ? delegation.revokeGrant(accountId, grantId) : false;
      };
      const revokeAllAgentGrants = async (accountId: string) => {
        let count = 0;
        for (const { runtime } of extensions.values()) {
          count += await runtime.revokeAllAccountGrants(accountId);
        }
        if (delegation) count += await delegation.revokeAllGrants(accountId);
        return count;
      };

      const revokeGrantById = async (grantId: string) => {
        if (!store) return null;
        const grant = await store.findGrant(grantId);
        const now = options.now?.() ?? new Date();
        // Expirado já não vale: revogar não muda nada (e não vira evento de auditoria).
        if (!grant || grant.revokedAt || grant.expiresAt <= now) return null;
        if (isExtensionGrant(grantId)) {
          const owner = ownerOf(grantId);
          if (!owner) return null;
          await owner.runtime.revokeGrant(grantId);
        } else {
          await store.revokeGrantById(grantId, now);
        }
        return grant;
      };
      const disconnectAgent = async (protocol: AgentProtocolId, identifier: string) => {
        if (!store) return 0;
        if (protocol !== 'pact') {
          const entry = extensions.get(protocol);
          return entry ? entry.runtime.disconnectAgent(identifier) : 0;
        }
        const ids = (await store.unrevokedGrantIdsOfClient(identifier)).filter(
          (id) => !isExtensionGrant(id),
        );
        const at = options.now?.() ?? new Date();
        for (const id of ids) await store.revokeGrantById(id, at);
        return ids.length;
      };

      return {
        config: effective,
        urls,
        verifier: new PersonalAgentVerifier(effective),
        delegation,
        extensions,
        revokeAgentGrant,
        revokeAllAgentGrants,
        registry,
        grants: store,
        revokeGrantById,
        disconnectAgent,
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

/** Where {@link personalAgentExtensionRuntime} builds the runtime from, outside a request. */
export interface PersonalAgentRuntimeSource {
  service: OidcService;
  /** The Lucid `Database` (the `lucid.db` binding). */
  db(): Promise<unknown>;
  make?(binding: string): Promise<unknown>;
  now?(): Date;
}

/**
 * The runtime an extension's `setup` built (`personalAgents.extensions`), by protocol id. `null`
 * when the extension is not configured (or there is no database). Takes the request, an explicit
 * source (tests, scripts) or nothing (the booted app).
 *
 * Stable for 1.x — see `extension.ts`.
 */
export async function personalAgentExtensionRuntime<
  R extends PersonalAgentProtocolRuntime = PersonalAgentProtocolRuntime,
>(id: string, from?: HttpContext | PersonalAgentRuntimeSource): Promise<R | null> {
  let runtime: PersonalAgentsRuntime | null;
  if (from && 'containerResolver' in from) {
    runtime = await personalAgentsFor(from);
  } else if (from) {
    const source = from as PersonalAgentRuntimeSource;
    runtime = await buildPersonalAgentsRuntime(source.service, () => source.db() as Promise<any>, {
      make: source.make ? (binding) => source.make!(binding) : undefined,
      now: source.now ? () => source.now!() : undefined,
    });
  } else {
    const app = getBootedApp();
    const service = (await app.container.make('authkit.server' as any)) as OidcService;
    runtime = await buildPersonalAgentsRuntime(
      service,
      () => app.container.make('lucid.db' as any),
      { make: (binding) => app.container.make(binding as any) },
    );
  }
  return (runtime?.extensions.get(id)?.runtime as R | undefined) ?? null;
}
