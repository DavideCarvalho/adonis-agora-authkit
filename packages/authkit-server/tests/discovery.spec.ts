import { createServer } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { adapters, defineConfig } from '../src/define_config.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { fakeAccountStore } from './bootstrap.js';
import { withClients } from './helpers/seed_clients.js';

const PORT = 9779;
const ISSUER = `http://localhost:${PORT}`;

test.group('OIDC discovery', () => {
  test('serve /.well-known/openid-configuration', async ({ assert }) => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      withClients(
        [
          {
            clientId: 'app1',
            clientSecret: 's',
            redirectUris: ['https://app1/cb'],
            grants: ['authorization_code', 'refresh_token'],
          },
        ],
        defineConfig({
          issuer: ISSUER,
          adapter: adapters.redis({ connection: 'main' }),
          jwks: { source: 'managed' },
          accountStore: fakeAccountStore(),
        }),
      ),
    );
    const service = new OidcService(cfg!, 'a'.repeat(32));
    const server = createServer(service.callback);
    await new Promise<void>((r) => server.listen(PORT, r));
    try {
      const res = await fetch(`${ISSUER}/.well-known/openid-configuration`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.issuer, ISSUER);
      assert.isString(body.authorization_endpoint);
      assert.isString(body.token_endpoint);
      assert.isString(body.jwks_uri);
      assert.include(body.code_challenge_methods_supported, 'S256');
      assert.include(body.grant_types_supported, 'refresh_token');
      // RP-initiated logout (H3): o end_session_endpoint deve ser anunciado.
      assert.equal(body.end_session_endpoint, `${ISSUER}/session/end`);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test('montado sob /oidc anuncia endpoints com o prefixo correto', async ({ assert }) => {
    const PATH_PORT = 9781;
    const ORIGIN = `http://localhost:${PATH_PORT}`;
    const PATH_ISSUER = `${ORIGIN}/oidc`;
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      withClients(
        [
          {
            clientId: 'app1',
            clientSecret: 's',
            redirectUris: ['https://app1/cb'],
            grants: ['authorization_code'],
          },
        ],
        defineConfig({
          issuer: PATH_ISSUER,
          adapter: adapters.redis({ connection: 'main' }),
          jwks: { source: 'managed' },
          accountStore: fakeAccountStore(),
        }),
      ),
    );
    const service = new OidcService(cfg!, 'a'.repeat(32));
    const server = createServer(service.callback);
    await new Promise<void>((r) => server.listen(PATH_PORT, r));
    try {
      const res = await fetch(`${PATH_ISSUER}/.well-known/openid-configuration`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.issuer, PATH_ISSUER);
      // Endpoints DEVEM carregar o prefixo /oidc (eis a regressão corrigida).
      assert.equal(body.authorization_endpoint, `${PATH_ISSUER}/auth`);
      assert.equal(body.token_endpoint, `${PATH_ISSUER}/token`);
      assert.equal(body.jwks_uri, `${PATH_ISSUER}/jwks`);
      // RP-initiated logout (H3): end_session_endpoint também prefixado com /oidc.
      assert.equal(body.end_session_endpoint, `${PATH_ISSUER}/session/end`);
      // E o endpoint anunciado deve estar REALMENTE acessível.
      const jwks = await fetch(body.jwks_uri);
      assert.equal(jwks.status, 200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
