import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { adapters, defineConfig } from '../src/define_config.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { fakeAccountStore } from './bootstrap.js';

const PORT = 9788;
const ISSUER = `http://localhost:${PORT}`;

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

test.group('OIDC capabilities (e2e)', (group) => {
  let server: Server;
  let service: OidcService;

  group.setup(async () => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      defineConfig({
        issuer: ISSUER,
        adapter: adapters.redis({ connection: 'main' }),
        jwks: { source: 'managed', algorithm: 'RS256' },
        clients: [
          {
            clientId: 'app1',
            clientSecret: 's',
            redirectUris: [`${ISSUER}/cb`],
            grants: ['authorization_code', 'refresh_token'],
          },
        ],
        accountStore: fakeAccountStore(),
      }),
    );
    service = new OidcService(cfg!, 'a'.repeat(32));
    server = createServer(service.callback);
    await new Promise<void>((r) => server.listen(PORT, r));
    return async () => new Promise<void>((r) => server.close(() => r()));
  });

  test('jwks_uri serve chaves PÚBLICAS (sem parte privada d)', async ({ assert }) => {
    const disco = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json();
    const jwks = await (await fetch(disco.jwks_uri)).json();
    assert.isAbove(jwks.keys.length, 0);
    assert.isString(jwks.keys[0].kid);
    assert.isUndefined(jwks.keys[0].d); // chave pública: NUNCA expõe 'd'
    assert.equal(jwks.keys[0].kty, 'RSA');
  });

  test('authorize com PKCE redireciona para a tela de interaction', async ({ assert }) => {
    const { challenge } = pkce();
    const params = new URLSearchParams({
      client_id: 'app1',
      response_type: 'code',
      scope: 'openid profile email offline_access',
      redirect_uri: `${ISSUER}/cb`,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
    });
    const res = await fetch(`${ISSUER}/auth?${params.toString()}`, { redirect: 'manual' });
    assert.oneOf(res.status, [302, 303]);
    const location = res.headers.get('location') ?? '';
    assert.include(location, '/interaction/');
  });

  test('authorize SEM PKCE é rejeitado (PKCE obrigatório)', async ({ assert }) => {
    const params = new URLSearchParams({
      client_id: 'app1',
      response_type: 'code',
      scope: 'openid',
      redirect_uri: `${ISSUER}/cb`,
      state: 'xyz',
    });
    const res = await fetch(`${ISSUER}/auth?${params.toString()}`, { redirect: 'manual' });
    // sem code_challenge: oidc-provider redireciona de volta ao client com error=invalid_request
    // OU responde 400. Aceitamos qualquer sinal de rejeição (não vai para /interaction/).
    const location = res.headers.get('location') ?? '';
    const rejected =
      res.status === 400 || location.includes('error=') || !location.includes('/interaction/');
    assert.isTrue(rejected);
  });
});
