import type { ResolvedServerConfig } from '@adonis-agora/authkit-server';

/** Writes a confidential authorization-code client into the IdP's OIDC adapter. */
export async function seedClient(
  cfg: Pick<ResolvedServerConfig, 'AdapterClass'>,
  client: { clientId: string; clientSecret: string; redirectUris: string[] },
): Promise<void> {
  const adapter = new cfg.AdapterClass('Client');
  await adapter.upsert(
    client.clientId,
    {
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uris: client.redirectUris,
      post_logout_redirect_uris: [],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
    },
    0,
  );
}
