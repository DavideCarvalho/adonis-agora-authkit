import { createServer, type Server } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { adapters, defineConfig } from '../src/define_config.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { fakeAccountStore } from './bootstrap.js';

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

const ACCOUNTS: Record<string, { id: string; email: string; globalRoles: string[]; name: string }> =
  {
    'admin-1': { id: 'admin-1', email: 'a1@x.com', globalRoles: ['ADMIN'], name: 'Admin 1' },
    'admin-2': { id: 'admin-2', email: 'a2@x.com', globalRoles: ['ADMIN'], name: 'Admin 2' },
    'target-1': { id: 'target-1', email: 't@x.com', globalRoles: ['USER'], name: 'Target' },
  };

/**
 * Sobe um issuer com token-exchange e devolve os helpers. `impersonateAdmins`
 * vira `admin.impersonateAdmins` (ausente = default).
 */
async function startIssuer(port: number, impersonateAdmins?: boolean) {
  const issuer = `http://localhost:${port}`;
  const fakeApp = {
    container: { make: async () => ({ connection: () => new RedisMock() }) },
  } as any;
  const cfg = await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer,
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed', algorithm: 'RS256' },
      ...(impersonateAdmins === undefined ? {} : { admin: { enabled: false, impersonateAdmins } }),
      clients: [
        {
          clientId: 'app1',
          clientSecret: 's',
          redirectUris: [`${issuer}/cb`],
          grants: ['authorization_code', 'refresh_token', TOKEN_EXCHANGE],
        },
      ],
      accountStore: fakeAccountStore({ findById: async (sub) => ACCOUNTS[sub] ?? null }),
    }),
  );
  const service = new OidcService(cfg as any, 'a'.repeat(32));
  const server: Server = createServer(service.callback);
  await new Promise<void>((r) => server.listen(port, r));

  const provider = (service as any).provider;
  async function mint(accountId: string): Promise<string> {
    const client = await provider.Client.find('app1');
    return new provider.AccessToken({ accountId, client, scope: 'openid profile email' }).save();
  }
  async function exchange(subjectToken: string, requestedSubject: string) {
    const res = await fetch(`${issuer}/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from('app1:s').toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE,
        subject_token: subjectToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        requested_subject: requestedSubject,
      }).toString(),
    });
    return { status: res.status, json: (await res.json()) as any };
  }
  const close = () => new Promise<void>((r) => server.close(() => r()));
  return { provider, mint, exchange, close };
}

test.group('token-exchange — o access token carrega o ator (act)', (group) => {
  let issuer: Awaited<ReturnType<typeof startIssuer>>;
  group.setup(async () => {
    issuer = await startIssuer(9796);
    return () => issuer.close();
  });

  test('AT trocado tem extra.act = admin, e a resposta traz act', async ({ assert }) => {
    const { status, json } = await issuer.exchange(await issuer.mint('admin-1'), 'target-1');
    assert.equal(status, 200, JSON.stringify(json));
    assert.deepEqual(json.act, { sub: 'admin-1' });

    const at = await issuer.provider.AccessToken.find(json.access_token);
    assert.equal(at.accountId, 'target-1');
    assert.deepEqual(at.extra?.act, { sub: 'admin-1' });
  });

  test('sem impersonation encadeada: token trocado não vira subject de outra troca', async ({
    assert,
  }) => {
    const first = await issuer.exchange(await issuer.mint('admin-1'), 'admin-2');
    assert.equal(first.status, 200, 'default permite alvo admin (back-compat)');
    const chained = await issuer.exchange(first.json.access_token, 'target-1');
    assert.equal(chained.status, 400);
    assert.equal(chained.json.error, 'invalid_grant');
  });

  test('impersonar a si mesmo → invalid_grant', async ({ assert }) => {
    const { status, json } = await issuer.exchange(await issuer.mint('admin-1'), 'admin-1');
    assert.equal(status, 400);
    assert.equal(json.error, 'invalid_grant');
  });
});

test.group('token-exchange — admin.impersonateAdmins: false', (group) => {
  let issuer: Awaited<ReturnType<typeof startIssuer>>;
  group.setup(async () => {
    issuer = await startIssuer(9797, false);
    return () => issuer.close();
  });

  test('alvo admin → invalid_grant; alvo comum segue', async ({ assert }) => {
    const admin = await issuer.exchange(await issuer.mint('admin-1'), 'admin-2');
    assert.equal(admin.status, 400);
    assert.equal(admin.json.error, 'invalid_grant');

    const common = await issuer.exchange(await issuer.mint('admin-1'), 'target-1');
    assert.equal(common.status, 200, JSON.stringify(common.json));
  });
});
