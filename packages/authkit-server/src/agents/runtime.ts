import type { HttpContext } from '@adonisjs/core/http';
import { supportsAccountStatus } from '../accounts/account_store.js';
import type { OidcService } from '../provider/oidc_service.js';
import { PersonalAgentVerifier } from './agent_identity.js';
import type { ResolvedPersonalAgentsConfig } from './config.js';
import { PersonalAgentDelegation } from './delegation_service.js';
import { DelegationStore } from './delegation_store.js';
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
  verifier: PersonalAgentVerifier;
  /** `null` quando o app não configurou `personalAgents.delegation`. */
  delegation: PersonalAgentDelegation | null;
}

const runtimes = new WeakMap<OidcService, Promise<PersonalAgentsRuntime | null>>();

/**
 * Monta (uma vez por `OidcService`) o runtime de personal agents. `null` quando
 * `personalAgents` não está no config — as rotas respondem 404.
 */
export function buildPersonalAgentsRuntime(
  service: OidcService,
  makeDb: () => Promise<any>,
): Promise<PersonalAgentsRuntime | null> {
  let runtime = runtimes.get(service);
  if (!runtime) {
    runtime = (async () => {
      const config = service.config.personalAgents;
      if (!config) return null;
      const urls = personalAgentUrls(service.config.issuer, config.prefix);
      let delegation: PersonalAgentDelegation | null = null;
      if (config.delegation) {
        const db = await makeDb();
        const connection = service.config.schema.connection;
        delegation = new PersonalAgentDelegation({
          cfg: config.delegation,
          store: new DelegationStore(() =>
            connection ? db.connection(connection) : db.connection(),
          ),
          signer: keystoreSigner(service),
          urls: { issuer: urls.issuer, consent: urls.consent },
          // Conta apagada ou suspensa corta a delegação na hora.
          isAccountActive: async (accountId) => {
            const store = service.config.accountStore;
            if (!(await store.findById(accountId))) return false;
            return !(supportsAccountStatus(store) && (await store.isDisabled(accountId)));
          },
        });
      }
      return { config, urls, verifier: new PersonalAgentVerifier(config), delegation };
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
  return buildPersonalAgentsRuntime(service, () => ctx.containerResolver.make('lucid.db'));
}
