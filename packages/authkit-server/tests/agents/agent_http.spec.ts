import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { setBootedApp } from '../../services/booted_app.js';
import {
  personalAgentAuth,
  personalAgentOf,
  personalAgentReceipt,
  personalAgentSecurity,
  personalAgentStepUp,
} from '../../src/agents/middleware.js';
import { buildPersonalAgentsRuntime } from '../../src/agents/runtime.js';
import type { AuditEvent } from '../../src/audit/audit_sink.js';
import { adapters, defineConfig, type ResolvedServerConfig } from '../../src/define_config.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/account_session_key.js';
import { AdminSessionsService } from '../../src/host/admin_sessions_service.js';
import AccountAppsController from '../../src/host/controllers/account_apps_controller.js';
import AgentConsentController from '../../src/host/controllers/agent_consent_controller.js';
import AgentOAuthController from '../../src/host/controllers/agent_oauth_controller.js';
import { OidcService } from '../../src/provider/oidc_service.js';
import { ensureAuthkitSchema } from '../../src/schema/ensure.js';
import { createTestDatabase } from '../bootstrap.js';

// ---------------------------------------------------------------------------
// Fluxo PACT de ponta a ponta pelos controllers e pelo middleware REAIS:
// agente pede delegação → usuário logado aprova na tela → agente troca o
// device_code por token → chama a rota protegida com os dois tokens → recebe
// recibo → usuário revoga → o token para de valer. O JWKS do agente é servido
// por um servidor HTTP local (o verificador usa o fetch remoto de verdade).
// ---------------------------------------------------------------------------

const ISSUER = 'http://localhost:9871/oidc';
const PA_ISSUER = 'https://pa.example.com';
const AUDIENCE = 'brand-audience';
const INTERFACE_URL = 'https://brand.example/a2a';
const ACCOUNT_ID = 'user-1';

interface Rendered {
  view: string;
  props: Record<string, any>;
}

function makeCtx(opts: {
  service: OidcService;
  db: any;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  session?: Record<string, unknown>;
}) {
  const res = { status: 200, headers: {} as Record<string, string>, body: undefined as unknown };
  const response: any = {
    header(k: string, v: string) {
      res.headers[k.toLowerCase()] = v;
      return response;
    },
    status(n: number) {
      res.status = n;
      return response;
    },
    send(b: unknown) {
      res.body = b;
      return response;
    },
    json(b: unknown) {
      res.body = b;
      return response;
    },
    notFound() {
      res.status = 404;
      return response;
    },
    redirect(url: string) {
      res.status = 302;
      res.headers.location = url;
    },
  };
  const headers = Object.fromEntries(
    Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const session = new Map(Object.entries(opts.session ?? { [ACCOUNT_SESSION_KEY]: ACCOUNT_ID }));
  const ctx: any = {
    request: {
      header: (name: string) => headers[name.toLowerCase()],
      input: (key: string) => opts.body?.[key],
      param: (key: string) => opts.params?.[key],
      ip: () => '127.0.0.1',
      csrfToken: 'csrf',
    },
    response,
    session: {
      get: (k: string) => session.get(k),
      put: (k: string, v: unknown) => session.set(k, v),
      forget: (k: string) => session.delete(k),
      flash: () => {},
      flashMessages: { get: () => undefined },
    },
    containerResolver: {
      make: async (token: string) => (token === 'lucid.db' ? opts.db : opts.service),
    },
  };
  return { ctx, res };
}

async function setup() {
  // Chave do agente + JWKS servido por HTTP.
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'pa-1', alg: 'ES256', use: 'sig' };
  const jwksServer: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const port = (jwksServer.address() as AddressInfo).port;

  const rendered: Rendered[] = [];
  const audit: AuditEvent[] = [];
  const fakeApp = {
    container: { make: async () => ({ connection: () => new RedisMock() }) },
  } as any;
  const cfg = await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer: ISSUER,
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed', algorithm: 'ES256' },
      clients: [],
      accountStore: {
        findById: async (id: string) =>
          id === ACCOUNT_ID ? { id, email: 'jane@example.com', globalRoles: [] } : null,
      } as any,
      render: (async (_ctx: any, view: string, props: Record<string, any>) => {
        rendered.push({ view, props });
      }) as any,
      audit: { record: async (event: AuditEvent) => void audit.push(event) } as any,
      trustedDevices: { enabled: false },
      personalAgents: {
        audience: AUDIENCE,
        agents: [
          { issuer: PA_ISSUER, jwksUri: `http://127.0.0.1:${port}/jwks`, name: 'Example PA' },
        ],
        delegation: {
          interfaceUrl: INTERFACE_URL,
          scopes: { 'orders:read': 'Look up your orders', 'orders:cancel': 'Cancel an order' },
        },
      },
    }),
  );
  const service = new OidcService(cfg as ResolvedServerConfig, 'a'.repeat(32));
  const db = createTestDatabase();
  await ensureAuthkitSchema(db);

  const paJwt = (sub = 'pa-user-1') => {
    const iat = Math.floor(Date.now() / 1000);
    return new SignJWT({ iss: PA_ISSUER, aud: AUDIENCE, sub, iat, exp: iat + 120 })
      .setProtectedHeader({ alg: 'ES256', kid: 'pa-1' })
      .sign(privateKey);
  };

  return {
    service,
    db,
    rendered,
    audit,
    paJwt,
    close: async () => {
      await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
      await db.manager.closeAll();
    },
  };
}

/** Roda o middleware; devolve se o `next` foi chamado. */
async function runMiddleware(mw: ReturnType<typeof personalAgentAuth>, ctx: any) {
  let called = false;
  await mw(ctx, async () => {
    called = true;
  });
  return called;
}

test.group('personal agents — boot', () => {
  test('delegação com keystore sem chave ES256/RS256 falha no boot', async ({ assert }) => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    await assert.rejects(
      () =>
        configProvider.resolve(
          fakeApp,
          defineConfig({
            issuer: ISSUER,
            adapter: adapters.redis({ connection: 'main' }),
            jwks: { source: 'managed', algorithm: 'EdDSA' },
            clients: [],
            accountStore: { findById: async () => null } as any,
            personalAgents: {
              audience: AUDIENCE,
              delegation: { interfaceUrl: INTERFACE_URL, scopes: { a: 'A' } },
            },
          }),
        ),
      /ES256 ou RS256/,
    );
  });
});

test.group('personal agents — prefixo', () => {
  test('prefixo debaixo do mountPath do OIDC falha no boot', async ({ assert }) => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    await assert.rejects(
      () =>
        configProvider.resolve(
          fakeApp,
          defineConfig({
            issuer: ISSUER,
            adapter: adapters.redis({ connection: 'main' }),
            jwks: { source: 'managed', algorithm: 'RS256' },
            clients: [],
            accountStore: { findById: async () => null } as any,
            personalAgents: { audience: AUDIENCE, prefix: '/oidc/agents' },
          }),
        ),
      /debaixo do mountPath/,
    );
  });
});

test.group('personal agents — fluxo HTTP (PACT)', (group) => {
  let env: Awaited<ReturnType<typeof setup>>;
  group.setup(async () => {
    env = await setup();
    return () => env.close();
  });

  test('metadata RFC 8414 e JWKS', async ({ assert }) => {
    const oauth = new AgentOAuthController();
    const { ctx } = makeCtx(env);
    const meta: any = await oauth.metadata(ctx);
    assert.deepInclude(meta, {
      issuer: 'http://localhost:9871/agents/oauth',
      device_authorization_endpoint: 'http://localhost:9871/agents/oauth/device_authorization',
      token_endpoint: 'http://localhost:9871/agents/oauth/token',
      jwks_uri: 'http://localhost:9871/agents/oauth/jwks.json',
    });
    assert.deepEqual(meta.scopes_supported, ['orders:read', 'orders:cancel']);

    const jwks: any = await oauth.jwks(makeCtx(env).ctx);
    assert.isAbove(jwks.keys.length, 0);
    assert.notProperty(jwks.keys[0], 'd');
  });

  test('device_authorization sem JWT do agente: 401 com challenge e sem corpo', async ({
    assert,
  }) => {
    const { ctx, res } = makeCtx({ ...env, body: { client_id: PA_ISSUER, scope: 'orders:read' } });
    await new AgentOAuthController().deviceAuthorization(ctx);
    assert.equal(res.status, 401);
    assert.equal(res.headers['www-authenticate'], 'Bearer realm="a2a"');
    assert.equal(res.body, '');
  });

  test('client_id diferente do iss: invalid_client', async ({ assert }) => {
    const { ctx, res } = makeCtx({
      ...env,
      headers: { authorization: `Bearer ${await env.paJwt()}` },
      body: { client_id: 'https://other.example', scope: 'orders:read' },
    });
    await new AgentOAuthController().deviceAuthorization(ctx);
    assert.equal(res.status, 401);
    assert.equal((res.body as any).error, 'invalid_client');
  });

  test('fluxo completo: pedir → consentir → token → rota protegida → recibo → revogar', async ({
    assert,
  }) => {
    const oauth = new AgentOAuthController();
    const consent = new AgentConsentController();
    const authHeader = { authorization: `Bearer ${await env.paJwt()}` };

    // 1. O agente pede os dois scopes.
    const device = makeCtx({
      ...env,
      headers: authHeader,
      body: { client_id: PA_ISSUER, scope: 'orders:read orders:cancel' },
    });
    await oauth.deviceAuthorization(device.ctx);
    assert.equal(device.res.status, 200);
    assert.equal(device.res.headers['cache-control'], 'no-store');
    const { device_code, user_code, verification_uri_complete } = device.res.body as any;
    assert.equal(
      verification_uri_complete,
      `http://localhost:9871/agents/consent?user_code=${user_code}`,
    );

    // 2. Polling antes da aprovação.
    const early = makeCtx({
      ...env,
      headers: authHeader,
      body: {
        client_id: PA_ISSUER,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code,
      },
    });
    await oauth.token(early.ctx);
    assert.equal(early.res.status, 400);
    assert.equal((early.res.body as any).error, 'authorization_pending');

    // 3. O usuário (logado) abre o link e vê o pedido.
    await consent.show(makeCtx({ ...env, body: { user_code } }).ctx);
    const page = env.rendered.at(-1)!;
    assert.equal(page.view, 'agents/consent');
    assert.deepInclude(page.props.request, {
      userCode: user_code,
      agentName: 'Example PA',
      agentOrigin: 'pa.example.com',
    });
    assert.equal(page.props.account.email, 'jane@example.com');

    // 4. Aprova só a leitura (desmarcou o cancelamento).
    await consent.decide(
      makeCtx({ ...env, body: { user_code, decision: 'allow', scope: ['orders:read'] } }).ctx,
    );
    const done = env.rendered.at(-1)!;
    assert.equal(done.view, 'agents/done');
    assert.equal(done.props.status, 'approved');
    assert.deepEqual(done.props.scopes, [
      { id: 'orders:read', description: 'Look up your orders' },
    ]);
    assert.deepInclude(env.audit.at(-1)!, {
      type: 'agent.delegation_approved',
      accountId: ACCOUNT_ID,
      clientId: PA_ISSUER,
    });

    // 5. O agente troca o device_code pelo token.
    const tokenCtx = makeCtx({
      ...env,
      headers: authHeader,
      body: {
        client_id: PA_ISSUER,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code,
      },
    });
    await oauth.token(tokenCtx.ctx);
    assert.equal(tokenCtx.res.status, 200);
    const token = tokenCtx.res.body as any;
    assert.equal(token.scope, 'orders:read');

    // 6. Rota protegida com os dois tokens.
    const call = makeCtx({
      ...env,
      headers: { ...authHeader, 'X-A2A-User-Delegation': `Bearer ${token.access_token}` },
    });
    assert.isTrue(await runMiddleware(personalAgentAuth(), call.ctx));
    assert.deepInclude(personalAgentOf(call.ctx)!, { issuer: PA_ISSUER, sub: 'pa-user-1' });
    assert.deepInclude(personalAgentOf(call.ctx)!.delegation, {
      accountId: ACCOUNT_ID,
      scopes: ['orders:read'],
    });

    // Recibo e step-up no formato PACT.
    const receipt: any = await personalAgentReceipt(call.ctx, {
      scopesUsed: ['orders:read'],
      actions: [{ tool: 'lookup_orders' }],
    });
    assert.equal(receipt['pact.receipt'].claims.user, ACCOUNT_ID);
    assert.isString(receipt['pact.receipt'].jws);
    const stepUp: any = await personalAgentStepUp(call.ctx, ['orders:cancel']);
    assert.deepEqual(stepUp['pact.missingScopes'], ['orders:cancel']);
    assert.match(stepUp['pact.verificationUriComplete'], /\/agents\/consent\?user_code=/);

    // O mesmo token na conversa de OUTRO usuário do agente não vale.
    const otherUser = makeCtx({
      ...env,
      headers: {
        authorization: `Bearer ${await env.paJwt('pa-user-2')}`,
        'x-a2a-user-delegation': `Bearer ${token.access_token}`,
      },
    });
    assert.isFalse(await runMiddleware(personalAgentAuth(), otherUser.ctx));
    assert.equal(
      otherUser.res.headers['www-authenticate'],
      'Bearer realm="a2a", error="invalid_token"',
    );

    // 7. O usuário revoga no console; o token morre na próxima request.
    await new AccountAppsController().index(makeCtx(env).ctx);
    const apps = env.rendered.at(-1)!;
    assert.equal(apps.view, 'account/apps');
    assert.lengthOf(apps.props.agents, 1);
    assert.equal(apps.props.agents[0].name, 'Example PA');

    await new AccountAppsController().revokeAgent(
      makeCtx({ ...env, params: { grantId: apps.props.agents[0].id } }).ctx,
    );
    assert.equal(env.audit.at(-1)!.type, 'agent.grant_revoked');

    const after = makeCtx({
      ...env,
      headers: { ...authHeader, 'x-a2a-user-delegation': `Bearer ${token.access_token}` },
    });
    assert.isFalse(await runMiddleware(personalAgentAuth(), after.ctx));
    assert.equal(after.res.status, 401);
  });

  test('"sair de todas as sessões" (revokeAll) também corta o agente', async ({ assert }) => {
    const runtime = (await buildPersonalAgentsRuntime(env.service, async () => env.db))!;
    const d = runtime.delegation!;
    const agent = { issuer: PA_ISSUER, sub: 'pa-user-9', name: 'x', claims: {} };
    const device = await d.requestDevice(agent, 'orders:read');
    await d.approve({ userCode: device.user_code, accountId: ACCOUNT_ID, scopes: ['orders:read'] });
    const token = await d.exchangeDeviceCode(agent, device.device_code);

    setBootedApp({ container: { make: async () => env.db } } as any);
    let result: Awaited<ReturnType<AdminSessionsService['revokeAll']>>;
    try {
      result = await new AdminSessionsService(env.service).revokeAll(ACCOUNT_ID);
    } finally {
      // O resto da suíte assume que getBootedApp lança.
      setBootedApp(undefined as any);
    }
    assert.isAtLeast(result.agentGrants ?? 0, 1);
    assert.isNull(await d.verify(agent, `Bearer ${token.access_token}`));
  });

  test('middleware: só identidade passa; `required` exige delegação', async ({ assert }) => {
    const headers = { authorization: `Bearer ${await env.paJwt()}` };
    const optional = makeCtx({ ...env, headers });
    assert.isTrue(await runMiddleware(personalAgentAuth(), optional.ctx));
    assert.isNull(personalAgentOf(optional.ctx)!.delegation);

    const required = makeCtx({ ...env, headers });
    assert.isFalse(
      await runMiddleware(personalAgentAuth({ delegation: 'required' }), required.ctx),
    );
    assert.equal(required.res.status, 401);

    const anonymous = makeCtx(env);
    assert.isFalse(await runMiddleware(personalAgentAuth(), anonymous.ctx));
    assert.equal(anonymous.res.headers['www-authenticate'], 'Bearer realm="a2a"');
  });

  test('consentimento recusa durante impersonation', async ({ assert }) => {
    await new AgentConsentController().show(
      makeCtx({
        ...env,
        body: { user_code: 'BCDF-GHJK' },
        session: { [ACCOUNT_SESSION_KEY]: ACCOUNT_ID, impersonator_user_id: 'admin-1' },
      }).ctx,
    );
    const page = env.rendered.at(-1)!;
    assert.equal(page.props.error, 'agents.consent.impersonating');
    assert.isNull(page.props.request);
  });

  test('a tela de consentimento não pode ser emoldurada (clickjacking)', async ({ assert }) => {
    const { ctx, res } = makeCtx({ ...env, body: { user_code: 'BCDF-GHJK' } });
    await new AgentConsentController().show(ctx);
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['content-security-policy'], "frame-ancestors 'none'");
  });

  test('metadata não anuncia private_key_jwt (o agente usa Bearer)', async ({ assert }) => {
    const meta: any = await new AgentOAuthController().metadata(makeCtx(env).ctx);
    assert.notProperty(meta, 'token_endpoint_auth_methods_supported');
  });

  test('código inválido mostra erro e o formulário', async ({ assert }) => {
    await new AgentConsentController().show(makeCtx({ ...env, body: { user_code: 'nope' } }).ctx);
    assert.equal(env.rendered.at(-1)!.props.error, 'agents.consent.invalid_code');
  });

  test('bloco de segurança do Agent Card (PACT §2.1/§5.1)', async ({ assert }) => {
    const security: any = await personalAgentSecurity(makeCtx(env).ctx);
    assert.deepEqual(security.securitySchemes.paJwt, {
      httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'JWT' },
    });
    assert.deepEqual(
      security.securitySchemes.userDelegation.oauth2SecurityScheme.flows.deviceCode,
      {
        deviceAuthorizationUrl: 'http://localhost:9871/agents/oauth/device_authorization',
        tokenUrl: 'http://localhost:9871/agents/oauth/token',
        scopes: { 'orders:read': 'Look up your orders', 'orders:cancel': 'Cancel an order' },
      },
    );
    assert.lengthOf(security.securityRequirements, 2);
    assert.deepEqual(security.securityRequirements[0], { schemes: { paJwt: { list: [] } } });
  });
});
