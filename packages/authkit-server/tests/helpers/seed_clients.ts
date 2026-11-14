/**
 * Test-only client seeding. Clients live in the OIDC adapter (admin console, Admin API,
 * `authkit:client create`); specs that need a client up front write it into the configured
 * adapter with {@link withClients} (wrapping `defineConfig`) or {@link seedClients}.
 */
import { configProvider } from '@adonisjs/core';
import type { ConfigProvider } from '@adonisjs/core/types';
import type { ResolvedServerConfig } from '../../src/define_config.js';
import { assertClientMetadata } from '../../src/host/client_metadata.js';

/** A client to seed, in the camelCase shape specs write. */
export interface TestClient {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
  grants?: string[];
  tokenEndpointAuthMethod?: 'client_secret_basic' | 'client_secret_post' | 'none';
  applicationType?: 'web' | 'native';
  backchannelLogoutUri?: string;
  backchannelLogoutSessionRequired?: boolean;
}

/** The oidc-provider client metadata for a {@link TestClient} (validated like the admin path). */
export function clientMetadata(c: TestClient): Record<string, unknown> {
  const grants = c.grants ?? ['authorization_code', 'refresh_token'];
  const tokenEndpointAuthMethod =
    c.tokenEndpointAuthMethod ?? (c.clientSecret ? 'client_secret_basic' : 'none');
  assertClientMetadata({
    applicationType: c.applicationType ?? 'web',
    tokenEndpointAuthMethod,
    grantTypes: grants,
    redirectUris: c.redirectUris,
    postLogoutRedirectUris: c.postLogoutRedirectUris ?? [],
  });
  return {
    client_id: c.clientId,
    ...(c.clientSecret ? { client_secret: c.clientSecret } : {}),
    redirect_uris: c.redirectUris,
    post_logout_redirect_uris: c.postLogoutRedirectUris ?? [],
    grant_types: grants,
    response_types: (c.grants ?? ['authorization_code']).includes('authorization_code')
      ? ['code']
      : [],
    token_endpoint_auth_method: tokenEndpointAuthMethod,
    ...(c.applicationType === 'native' ? { application_type: 'native' } : {}),
    ...(c.backchannelLogoutUri ? { backchannel_logout_uri: c.backchannelLogoutUri } : {}),
    ...(c.backchannelLogoutSessionRequired !== undefined
      ? { backchannel_logout_session_required: c.backchannelLogoutSessionRequired }
      : {}),
  };
}

/** Writes `clients` into the resolved config's OIDC adapter (`Client` model, no TTL). */
export async function seedClients(
  cfg: Pick<ResolvedServerConfig, 'AdapterClass'>,
  clients: readonly TestClient[],
): Promise<void> {
  const adapter = new cfg.AdapterClass('Client');
  for (const c of clients) await adapter.upsert(c.clientId, clientMetadata(c), 0);
}

/**
 * Wraps a `defineConfig(...)` provider so resolving it also seeds `clients` into the
 * configured adapter — the drop-in for specs that used to declare clients in the config.
 */
export function withClients(
  clients: readonly TestClient[],
  provider: ConfigProvider<ResolvedServerConfig>,
): ConfigProvider<ResolvedServerConfig> {
  return configProvider.create(async (app): Promise<ResolvedServerConfig> => {
    const cfg = (await configProvider.resolve<ResolvedServerConfig>(
      app,
      provider,
    )) as ResolvedServerConfig;
    await seedClients(cfg, clients);
    return cfg;
  });
}
