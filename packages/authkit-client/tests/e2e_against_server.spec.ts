import { type Server, createServer } from 'node:http';
import {
  OidcService,
  type ResolvedServerConfig,
  adapters,
  defineConfig as defineServer,
} from '@adonis-agora/authkit-server';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { buildAuthorizeUrl, generatePkce } from '../src/oidc_login.js';
import { resolvers } from '../src/resolvers/factory.js';

const PORT = 9820;
const ISSUER = `http://localhost:${PORT}`;

test.group('client ↔ server (e2e)', (group) => {
  let server: Server;
  group.setup(async () => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve<ResolvedServerConfig>(
      fakeApp,
      defineServer({
        issuer: ISSUER,
        adapter: adapters.redis({ connection: 'main' }),
        jwks: { source: 'managed' },
        clients: [
          {
            clientId: 'app1',
            clientSecret: 's',
            redirectUris: [`${ISSUER}/cb`],
            grants: ['authorization_code', 'refresh_token'],
          },
        ],
        // `findAccount` NÃO é mais uma chave de input: o contrato primário de
        // identidade é o `accountStore`, e o resolved config deriva
        // `findAccount: (sub) => accountStore.findById(sub)` (define_config.ts).
        // A chave antiga vinha sendo ignorada em silêncio aqui. Os métodos que
        // este spec não exercita estouram, em vez de fingir.
        accountStore: {
          findById: async (id) => ({ id, email: 'a@b.com', globalRoles: ['ADMIN'] }),
          verifyCredentials: async () => null,
          findByEmail: async () => null,
          create: async () => {
            throw new Error('not used');
          },
          listAccounts: async () => {
            throw new Error('not used');
          },
          setGlobalRoles: async () => {
            throw new Error('not used');
          },
          issuePasswordResetToken: async () => null,
          consumePasswordResetToken: async () => false,
          issueEmailVerificationToken: async () => null,
          consumeEmailVerificationToken: async () => false,
        },
      }),
    );
    const service = new OidcService(cfg!, 'a'.repeat(32));
    server = createServer(service.callback);
    await new Promise<void>((r) => server.listen(PORT, r));
    return async () => new Promise<void>((r) => server.close(() => r()));
  });

  test('authorize do client redireciona para interaction no server', async ({ assert }) => {
    const { challenge } = await generatePkce();
    const url = buildAuthorizeUrl({
      issuer: ISSUER,
      clientId: 'app1',
      redirectUri: `${ISSUER}/cb`,
      scopes: ['openid'],
      state: 's',
      codeChallenge: challenge,
    });
    const res = await fetch(url, { redirect: 'manual' });
    assert.oneOf(res.status, [302, 303]);
    assert.include(res.headers.get('location') ?? '', '/interaction/');
  });

  test('resolver do client encontra o jwks_uri do server via discovery', async ({ assert }) => {
    // `Response.json()` é `Promise<unknown>` nos tipos do Node. O cast declara o
    // subset esperado do discovery document; o `assert.isString` logo abaixo é o
    // que verifica em runtime que o cast é verdade.
    const disco = (await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json()) as {
      jwks_uri: string;
    };
    assert.isString(disco.jwks_uri);
    const factory = resolvers.jwt({ jwksUri: disco.jwks_uri });
    const resolver = await factory.resolver({
      issuer: ISSUER,
      clientId: 'app1',
      sessionKey: 'authkit',
      globalRolesClaim: 'roles',
    });
    assert.isOk(resolver);
  });
});
