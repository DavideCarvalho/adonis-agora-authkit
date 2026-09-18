import { createServer, type Server } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import {
  adapters,
  type DynamicRegistrationConfigInput,
  defineConfig,
  type ResolvedServerConfig,
  resolveDynamicRegistration,
} from '../src/define_config.js';
import { OidcService } from '../src/provider/oidc_service.js';
import {
  checkClientRegistration,
  classifyRedirect,
  RegistrationPolicyError,
  registrationOperation,
  resolveRedirectUriPolicy,
} from '../src/provider/registration_policy.js';
import { fakeAccountStore } from './bootstrap.js';

const IAT = 'iat_secret';

/**
 * Sobe o OidcService com o registro dinâmico configurado. `bridge: true` imita o
 * `OidcCallbackController` do host: o corpo já chega parseado em `req.body`
 * (o bodyparser do Adonis consumiu o stream antes).
 */
async function startService(
  port: number,
  dynReg: DynamicRegistrationConfigInput,
  opts: { bridge?: boolean } = {},
) {
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
      clients: [],
      accountStore: fakeAccountStore(),
      dynamicRegistration: dynReg,
    }),
  );
  const service = new OidcService(cfg as ResolvedServerConfig, 'a'.repeat(32));
  const server: Server = createServer((req, res) => {
    if (!opts.bridge) return service.callback(req, res);
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      (req as any).body = raw ? JSON.parse(raw) : {};
      service.callback(req, res);
    });
  });
  await new Promise<void>((r) => server.listen(port, r));
  return { issuer, service, server };
}

async function register(issuer: string, body: Record<string, unknown>, bearer?: string) {
  const res = await fetch(`${issuer}/reg`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const publicClient = (redirects: string[], extra: Record<string, unknown> = {}) => ({
  redirect_uris: redirects,
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  ...extra,
});

test.group('registration policy — funções puras', () => {
  const policy = resolveRedirectUriPolicy({
    exact: ['https://claude.ai/api/mcp/auth_callback'],
    appSchemes: ['cursor'],
  });

  test('classifica loopback (qualquer porta), exato e esquema de app', ({ assert }) => {
    assert.equal(classifyRedirect('http://127.0.0.1:53123/callback', policy), 'loopback');
    assert.equal(classifyRedirect('http://localhost:8080/cb', policy), 'loopback');
    assert.equal(classifyRedirect('http://[::1]:9/cb', policy), 'loopback');
    assert.equal(classifyRedirect('https://claude.ai/api/mcp/auth_callback', policy), 'web');
    assert.equal(classifyRedirect('cursor://anysphere.cursor-mcp/oauth/callback', policy), 'app');
  });

  test('recusa web arbitrário, credencial embutida, fragmento e loopback https-less host', ({
    assert,
  }) => {
    assert.isNull(classifyRedirect('https://evil.example/cb', policy));
    assert.isNull(classifyRedirect('https://claude.ai/api/mcp/auth_callback?x=1', policy));
    assert.isNull(classifyRedirect('http://user:pw@localhost/cb', policy));
    assert.isNull(classifyRedirect('http://localhost/cb#frag', policy));
    assert.isNull(classifyRedirect('http://localhost.evil.example/cb', policy));
    assert.isNull(classifyRedirect('not a url', policy));
  });

  test('só loopback/app vira native; grants fora do fluxo de código são recusados', ({
    assert,
  }) => {
    const out = checkClientRegistration(publicClient(['http://127.0.0.1:1/cb']), policy);
    assert.equal(out.application_type, 'native');
    const web = checkClientRegistration(
      publicClient(['https://claude.ai/api/mcp/auth_callback']),
      policy,
    );
    assert.isUndefined(web.application_type);
    assert.throws(
      () =>
        checkClientRegistration(
          publicClient(['http://127.0.0.1/cb'], { grant_types: ['client_credentials'] }),
          policy,
        ),
      /grant types/,
    );
    assert.throws(
      () =>
        checkClientRegistration(
          publicClient(['http://127.0.0.1/cb'], { response_types: ['code id_token'] }),
          policy,
        ),
      /response_type/,
    );
  });

  test('default: registro aberto ganha a política só-loopback; com IAT, nenhuma', ({ assert }) => {
    const open = resolveDynamicRegistration({ enabled: true });
    assert.deepEqual(open.redirectUriPolicy, {
      loopback: true,
      exact: [],
      appSchemes: [],
      anyHttps: false,
    });
    assert.isNull(
      resolveDynamicRegistration({ enabled: true, initialAccessToken: IAT }).redirectUriPolicy,
    );
    assert.isNull(
      resolveDynamicRegistration({ enabled: true, redirectUriPolicy: false }).redirectUriPolicy,
    );
  });
});

test.group('registration policy — casamento de path igual ao router do provider', () => {
  test('case-insensitive e com barra final, como o router do oidc-provider', ({ assert }) => {
    assert.equal(registrationOperation('POST', '/reg', '/REG'), 'create');
    assert.equal(registrationOperation('POST', '/REG', '/REG'), 'create');
    assert.equal(registrationOperation('POST', '/Reg/', '/REG'), 'create');
    assert.equal(registrationOperation('PUT', '/rEg/abc', '/REG'), 'update');
    assert.isNull(registrationOperation('POST', '/registration', '/REG'));
    assert.isNull(registrationOperation('GET', '/reg', '/REG'));
  });

  test('POST /REG e /reg/ não contornam a política', async ({ assert, cleanup }) => {
    const { issuer, server } = await startService(9908, { enabled: true });
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    for (const path of ['/REG', '/Reg', '/reg/', '/REG/']) {
      const res = await fetch(`${issuer}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(publicClient(['https://evil.example/cb'])),
      });
      assert.equal(res.status, 400, path);
      assert.equal(((await res.json()) as any).error, 'invalid_redirect_uri', path);
    }
  });

  test('PUT /REG/:id (RFC 7592) não contorna a política', async ({ assert, cleanup }) => {
    const { issuer, server } = await startService(9909, { enabled: true, management: true });
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const created = await register(issuer, publicClient(['http://127.0.0.1/cb']));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const res = await fetch(`${issuer}/REG/${created.body.client_id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${created.body.registration_access_token}`,
      },
      body: JSON.stringify({
        ...publicClient(['https://evil.example/cb']),
        client_id: created.body.client_id,
      }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).error, 'invalid_redirect_uri');
  });
});

test.group('registration policy — endpoint /reg', () => {
  test('registro aberto (default): redirect web arbitrário → 400 invalid_redirect_uri', async ({
    assert,
    cleanup,
  }) => {
    const { issuer, server } = await startService(9901, { enabled: true });
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const res = await register(issuer, publicClient(['https://evil.example/cb']));
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_redirect_uri');
  });

  test('registro aberto (default): loopback em qualquer porta → 201, native', async ({
    assert,
    cleanup,
  }) => {
    const { issuer, service, server } = await startService(9902, { enabled: true });
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const res = await register(issuer, publicClient(['http://127.0.0.1:53123/callback']));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.application_type, 'native');
    const found = await (service.provider as any).Client.find(res.body.client_id);
    assert.deepEqual(found.metadata().redirect_uris, ['http://127.0.0.1:53123/callback']);
  });

  test('política declarada: callback exato e esquema de app passam; grant extra não', async ({
    assert,
    cleanup,
  }) => {
    const { issuer, server } = await startService(9903, {
      enabled: true,
      redirectUriPolicy: {
        exact: ['https://claude.ai/api/mcp/auth_callback'],
        appSchemes: ['cursor'],
      },
    });
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const web = await register(issuer, publicClient(['https://claude.ai/api/mcp/auth_callback']));
    assert.equal(web.status, 201, JSON.stringify(web.body));

    const app = await register(
      issuer,
      publicClient(['cursor://anysphere.cursor-mcp/oauth/callback']),
    );
    assert.equal(app.status, 201, JSON.stringify(app.body));
    assert.equal(app.body.application_type, 'native');

    const cc = await register(
      issuer,
      publicClient(['http://127.0.0.1/cb'], { grant_types: ['client_credentials'] }),
    );
    assert.equal(cc.status, 400);
    assert.equal(cc.body.error, 'invalid_client_metadata');
  });

  test('com a ponte do host (corpo já parseado em req.body) a política também vale', async ({
    assert,
    cleanup,
  }) => {
    const { issuer, server } = await startService(9904, { enabled: true }, { bridge: true });
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const bad = await register(issuer, publicClient(['https://evil.example/cb']));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_redirect_uri');

    const ok = await register(issuer, publicClient(['http://localhost:7777/cb']));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.application_type, 'native');
  });

  test('com IAT e sem política declarada: comportamento de antes (https qualquer)', async ({
    assert,
    cleanup,
  }) => {
    const { issuer, server } = await startService(9905, {
      enabled: true,
      initialAccessToken: IAT,
    });
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const res = await register(
      issuer,
      {
        redirect_uris: ['https://partner.example/cb'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'client_secret_basic',
      },
      IAT,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  test('validateRegistration: pode recusar e pode reescrever o metadata', async ({
    assert,
    cleanup,
  }) => {
    const { issuer, server } = await startService(9906, {
      enabled: true,
      validateRegistration: (metadata) => {
        if (metadata.client_name === 'blocked') {
          throw new RegistrationPolicyError('invalid_client_metadata', 'client_name blocked');
        }
        return { ...metadata, client_name: `MCP: ${metadata.client_name}` };
      },
    });
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const blocked = await register(
      issuer,
      publicClient(['http://127.0.0.1/cb'], { client_name: 'blocked' }),
    );
    assert.equal(blocked.status, 400);
    assert.equal(blocked.body.error_description, 'client_name blocked');

    const ok = await register(issuer, publicClient(['http://127.0.0.1/cb'], { client_name: 'X' }));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.client_name, 'MCP: X');
  });

  test('RFC 7592: update (PUT /reg/:id) também passa pela política', async ({
    assert,
    cleanup,
  }) => {
    const { issuer, server } = await startService(9907, { enabled: true, management: true });
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const created = await register(issuer, publicClient(['http://127.0.0.1/cb']));
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const res = await fetch(created.body.registration_client_uri, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${created.body.registration_access_token}`,
      },
      body: JSON.stringify({
        ...publicClient(['https://evil.example/cb']),
        client_id: created.body.client_id,
      }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).error, 'invalid_redirect_uri');
  });
});
