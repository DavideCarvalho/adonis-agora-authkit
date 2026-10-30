import { test } from '@japa/runner';
import { resolvePersonalAgentsConfig } from '../../src/agents/config.js';
import { redirectUriAllowed } from '../../src/agents/poppy/client_registry.js';
import { PoppyError } from '../../src/agents/poppy/errors.js';
import {
  DEVICE_CODE_GRANT,
  MEDIATED_SIGN_IN_GRANT,
  type PoppyVerifyResult,
} from '../../src/agents/poppy/service.js';
import {
  ACCOUNT_ID,
  b64,
  CLIENT_ID,
  clientMetadata,
  dpopKey,
  dpopProof,
  type Env,
  JWKS_URI,
  MCP_URL,
  ORDERS_API,
  OTHER_ACCOUNT_ID,
  POPPY_ISSUER,
  pkce,
  REDIRECT_URI,
  type RequestOptions,
  setupPoppy,
  TOKEN_URL,
} from './poppy_helpers.js';

async function rejects(fn: () => Promise<unknown>): Promise<PoppyError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof PoppyError) return error;
    throw error;
  }
  throw new Error('expected a PoppyError');
}

/** Direct Sign-In completo; devolve a resposta do token endpoint. */
async function directSignIn(env: Env, scope = 'orders:read orders:write', proof?: string) {
  const { verifier, challenge } = pkce();
  const start = await env.poppy.startAuthorization(
    {
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope,
      state: 'st4te',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    },
    ACCOUNT_ID,
  );
  if (start.kind !== 'consent') throw new Error(`unexpected ${start.kind}`);
  const decided = await env.poppy.decideAuthorization({
    requestId: start.request.id,
    accountId: ACCOUNT_ID,
    allow: true,
    scopes: scope.split(' '),
  });
  const url = new URL(decided!.url);
  return {
    url,
    response: await env.poppy.token(
      await env.form({
        grant_type: 'authorization_code',
        code: url.searchParams.get('code'),
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
      proof,
    ),
  };
}

function failure(result: PoppyVerifyResult) {
  if (result.ok) throw new Error('expected a failure');
  return result;
}

test.group('poppy — discovery', () => {
  test('poppy.json 0.3: domínio exato, auth com scopes/hints, sem resource nem direct/device', async ({
    assert,
  }) => {
    const env = await setupPoppy({
      scopeHints: { 'orders:read': { changes: 'none', personal_data: true } },
      feedback: { endpoint: 'https://shop.example/poppy/feedback' },
      excludedTasks: { url: 'https://shop.example/poppy/excluded.json' },
      agent: {
        protocols: [
          {
            type: 'poppy',
            endpoint: 'https://shop.example/poppy/conversations',
            access: 'signed_in',
            resource: 'https://shop.example/poppy/conversations',
          },
        ],
      },
    });
    const doc = env.poppy.discoveryDocument('SHOP.example') as any;
    assert.equal(doc.protocol_version, '0.3');
    assert.deepEqual(doc.organization, { name: 'Shop', domain: 'shop.example' });
    assert.equal(doc.auth.issuer, POPPY_ISSUER);
    assert.equal(doc.auth.scopes['orders:read'], 'See your orders');
    assert.deepEqual(doc.auth.scope_hints, {
      'orders:read': { changes: 'none', personal_data: true },
    });
    assert.notProperty(doc.auth, 'direct');
    assert.notProperty(doc.auth, 'device');
    assert.notProperty(doc.auth, 'custom_scopes');
    assert.deepEqual(doc.agent.protocols, [
      {
        type: 'poppy',
        endpoint: 'https://shop.example/poppy/conversations',
        access: 'signed_in',
      },
    ]);
    assert.deepEqual(doc.feedback, { endpoint: 'https://shop.example/poppy/feedback' });
    assert.deepEqual(doc.excluded_tasks, { url: 'https://shop.example/poppy/excluded.json' });
    assert.equal(doc.web.browser_session_endpoint, `${POPPY_ISSUER}/browser-session`);
    assert.equal(
      (env.poppy.discoveryDocument('shop.example.co.uk') as any).organization.domain,
      'shop.example.co.uk',
    );
    assert.isNull(env.poppy.discoveryDocument('www.shop.example'));
    assert.isNull(env.poppy.discoveryDocument('evil.example'));
    await env.close();
  });

  test('issuer com porta (dev): endpoint e resource mantêm a porta', async ({ assert }) => {
    const env = await setupPoppy(
      { organization: { name: 'Shop', domain: 'localhost' } },
      { issuer: 'http://localhost:3333/oidc' },
    );
    const doc = env.poppy.discoveryDocument('localhost:3333') as any;
    assert.equal(doc.organization.domain, 'localhost');
    assert.equal(doc.web.browser_session_endpoint, 'http://localhost:3333/poppy/browser-session');
    assert.equal(
      (env.poppy.protectedResourceMetadata('localhost:3333') as any).resource,
      'http://localhost:3333',
    );
    await env.close();
  });

  test('metadata: protected_resources, grants obrigatórios, PS384 nas client assertions', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const meta = env.poppy.authorizationServerMetadata() as any;
    assert.equal(meta.issuer, POPPY_ISSUER);
    assert.notProperty(meta, 'poppy_domains');
    assert.deepEqual(meta.protected_resources, [
      'https://shop.example',
      'https://shop.example.co.uk',
      MCP_URL,
    ]);
    assert.deepEqual(meta.grant_types_supported, [
      'refresh_token',
      'authorization_code',
      DEVICE_CODE_GRANT,
    ]);
    assert.includeMembers(meta.scopes_supported, ['orders:read', 'orders:write', 'addresses']);
    assert.includeMembers(meta.token_endpoint_auth_signing_alg_values_supported, [
      'ES256',
      'PS384',
    ]);
    await env.close();
  });

  test('sem direct/device: endpoints e grants somem; refresh_token fica', async ({ assert }) => {
    const env = await setupPoppy({ signIn: { direct: false, device: false } });
    const meta = env.poppy.authorizationServerMetadata() as any;
    assert.notProperty(meta, 'authorization_endpoint');
    assert.notProperty(meta, 'device_authorization_endpoint');
    assert.deepEqual(meta.grant_types_supported, ['refresh_token']);
    await env.close();
  });
});

test.group('poppy — identidade do agente', () => {
  test('metadata inválida → invalid_client', async ({ assert }) => {
    for (const bad of [
      clientMetadata({ client_id: 'https://agent.example/other.json' }),
      clientMetadata({ jwks_uri: 'https://keys.other.example/jwks.json' }),
      clientMetadata({ redirect_uris: ['http://agent.example/cb'] }),
      clientMetadata({ redirect_uris: ['https://evil.example/cb'] }),
      clientMetadata({ redirect_uris: ['http://localhost/cb'] }),
      clientMetadata({ token_endpoint_auth_method: 'none' }),
    ]) {
      const env = await setupPoppy();
      env.docs.set(CLIENT_ID, bad);
      const err = await rejects(async () => env.poppy.authenticateClient(await env.form({})));
      assert.equal(err.code, 'invalid_client');
      assert.equal(err.status, 401);
      await env.close();
    }
    const env = await setupPoppy();
    env.docs.set(JWKS_URI, { keys: [{ ...env.keys.jwk, d: 'secret' }] });
    const err = await rejects(async () => env.poppy.authenticateClient(await env.form({})));
    assert.equal(err.code, 'invalid_client');
    await env.close();
  });

  test('loopback redirect URI: aceita em redirect_uris, a porta não conta (RFC 8252 §7.3)', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    env.docs.set(
      CLIENT_ID,
      clientMetadata({ redirect_uris: [REDIRECT_URI, 'http://127.0.0.1/callback'] }),
    );
    const { challenge } = pkce();
    const start = await env.poppy.startAuthorization(
      {
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: 'http://127.0.0.1:51004/callback',
        scope: 'orders:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
      ACCOUNT_ID,
    );
    assert.equal(start.kind, 'consent');
    const registered = ['http://127.0.0.1/callback', REDIRECT_URI];
    assert.isFalse(redirectUriAllowed(registered, 'http://127.0.0.1:1/other'));
    assert.isFalse(redirectUriAllowed(registered, 'http://[::1]:1/callback'));
    assert.isFalse(redirectUriAllowed(registered, 'https://agent.example:8443/oauth/callback'));
    await env.close();
  });

  test('metadata em cache: uma busca para várias requests', async ({ assert }) => {
    const env = await setupPoppy();
    await env.poppy.verifyAccess(await env.request());
    await env.poppy.verifyAccess(await env.request());
    assert.equal(env.fetched.filter((u) => u === CLIENT_ID).length, 1);
    await env.close();
  });

  test('registro exigido e blocklist', async ({ assert }) => {
    let env = await setupPoppy({ clients: { requireRegistration: true, registered: [] } });
    let err = await rejects(async () => env.poppy.authenticateClient(await env.form({})));
    assert.match(err.description, /not registered/);
    assert.equal(
      failure(await env.poppy.verifyAccess(await env.request())).error,
      'invalid_session',
    );
    await env.close();

    env = await setupPoppy({ clients: { requireRegistration: true, registered: [CLIENT_ID] } });
    assert.isTrue((await env.poppy.verifyAccess(await env.request())).ok);
    await env.close();

    env = await setupPoppy({ clients: { blocked: async (id) => id === CLIENT_ID } });
    err = await rejects(async () => env.poppy.authenticateClient(await env.form({})));
    assert.match(err.description, /blocked/);
    await env.close();
  });

  test('private_key_jwt: aud só o issuer, como string; sub, jti e vida', async ({ assert }) => {
    const env = await setupPoppy();
    const auth = (extra: Record<string, unknown>) => env.poppy.authenticateClient(extra);
    const base = {
      client_id: CLIENT_ID,
      client_assertion_type: (await env.form({})).client_assertion_type,
    };

    assert.equal((await rejects(() => auth({ client_id: CLIENT_ID }))).code, 'invalid_client');
    for (const opts of [
      { aud: TOKEN_URL },
      { aud: [POPPY_ISSUER] },
      { sub: 'https://other.example/a.json' },
      { exp: Math.floor(Date.now() / 1000) + 3600 },
    ]) {
      const err = await rejects(async () =>
        auth({ ...base, client_assertion: await env.clientAssertion(opts) }),
      );
      assert.equal(err.code, 'invalid_client', JSON.stringify(opts));
    }
    const once = await env.clientAssertion({ jti: b64() });
    await auth({ ...base, client_assertion: once });
    assert.match(
      (await rejects(() => auth({ ...base, client_assertion: once }))).description,
      /jti/,
    );
    await env.close();
  });
});

test.group('poppy — header Poppy-Session', () => {
  test('sid novo começa Session deslogada; o mesmo sid continua', async ({ assert }) => {
    const env = await setupPoppy();
    const first = await env.poppy.verifyAccess(await env.request({ agentId: 'agt_1' }));
    assert.isTrue(first.ok);
    if (!first.ok) return;
    assert.isFalse(first.principal.signedIn);
    assert.isNull(first.principal.accountId);
    assert.isNull(first.principal.tokenType);
    assert.equal(first.principal.userId, 'usr_Q7c1vK');
    assert.equal(first.principal.agentId, 'agt_1');
    const second = await env.poppy.verifyAccess(await env.request({ agentId: 'agt_1' }));
    assert.isTrue(second.ok && second.principal.sessionId === first.principal.sessionId);
    await env.close();
  });

  test('toda checagem do JWT e da delegação → invalid_session (400, sem challenge)', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const now = Math.floor(Date.now() / 1000);
    const cases: Record<string, RequestOptions> = {
      typ: { typ: 'JWT' },
      'sem delegação': { noDelegation: true },
      aud: { aud: TOKEN_URL },
      'aud em lista': { aud: [POPPY_ISSUER] },
      htm: { htm: 'POST' },
      htu: { htu: `${ORDERS_API}/outra` },
      'iat antigo': { iat: now - 600 },
      'iat futuro': { iat: now + 600 },
      'sid inválido': { sid: 'não/vale' },
      kid: { kid: 'outro' },
      'ath sem token': { ath: 'abc' },
      'typ da delegação': { delegation: { typ: 'JWT' } },
      'iss da delegação': { delegation: { iss: 'https://other.example/a.json' } },
      'delegação expirada': { delegation: { iat: now - 7200, exp: now - 3600 } },
      'delegação longa': { delegation: { iat: now - 60, exp: now + 25 * 3600 } },
      'cnf privado': {
        delegation: { cnf: { jwk: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b', d: 'c' } } },
      },
      'cnf outra curva': { delegation: { cnf: { jwk: { kty: 'OKP', crv: 'Ed25519', x: 'a' } } } },
    };
    for (const [name, opts] of Object.entries(cases)) {
      const f = failure(await env.poppy.verifyAccess(await env.request(opts)));
      assert.equal(f.status, 400, name);
      assert.equal(f.error, 'invalid_session', name);
      assert.isNull(f.wwwAuthenticate, name);
    }
    const none = failure(
      await env.poppy.verifyAccess({ method: 'GET', url: `${ORDERS_API}/1`, headers: {} }),
    );
    assert.equal(none.error, 'invalid_session');
    await env.close();
  });

  test('sub ou agent_id diferente da Session; jti repetido; Session encerrada', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    assert.isTrue((await env.poppy.verifyAccess(await env.request({ sid: 's1' }))).ok);
    for (const opts of [{ sub: 'outro' }, { agentId: 'agt_2' }]) {
      const f = failure(await env.poppy.verifyAccess(await env.request({ sid: 's1', ...opts })));
      assert.equal(f.error, 'invalid_session');
    }
    const req = await env.request({ sid: 's1' });
    assert.isTrue((await env.poppy.verifyAccess(req)).ok);
    assert.match(failure(await env.poppy.verifyAccess(req)).description, /jti/);

    await env.poppy.disconnectClient(CLIENT_ID);
    assert.match(
      failure(await env.poppy.verifyAccess(await env.request({ sid: 's1' }))).description,
      /ended/,
    );
    // Um sid novo começa outra Session.
    assert.isTrue((await env.poppy.verifyAccess(await env.request({ sid: 's2' }))).ok);
    await env.close();
  });

  test('o mesmo sid em dois agentes não é a mesma Session', async ({ assert }) => {
    const env = await setupPoppy();
    const OTHER = 'https://agent2.example/agent.json';
    const JWKS2 = 'https://agent2.example/jwks.json';
    env.docs.set(OTHER, clientMetadata({ client_id: OTHER, jwks_uri: JWKS2, redirect_uris: [] }));
    env.docs.set(JWKS2, { keys: [env.keys.jwk] });
    const a = await env.poppy.verifyAccess(await env.request({ sid: 'shared' }));
    const b = await env.poppy.verifyAccess(
      await env.request({ sid: 'shared', iss: OTHER, delegation: { iss: OTHER } }),
    );
    assert.isTrue(a.ok && b.ok);
    if (a.ok && b.ok) assert.notEqual(a.principal.sessionId, b.principal.sessionId);
    await env.close();
  });

  test('limite de Sessions novas: 429 com Retry-After, sem corpo de erro', async ({ assert }) => {
    const env = await setupPoppy({ rateLimit: async () => 30 });
    const f = failure(await env.poppy.verifyAccess(await env.request()));
    assert.equal(f.status, 429);
    assert.isNull(f.error);
    assert.equal(f.headers['Retry-After'], '30');
    await env.close();
  });
});

test.group('poppy — DPoP no token endpoint (opcional)', () => {
  test('sem prova sai Bearer; com prova, DPoP; dpop.required exige', async ({ assert }) => {
    let env = await setupPoppy();
    assert.equal((await env.signIn()).token_type, 'Bearer');
    assert.equal((await env.signIn({ dkey: await dpopKey() })).token_type, 'DPoP');
    await env.close();

    env = await setupPoppy({ dpop: { required: true } });
    const device: any = await env.poppy.deviceAuthorization(await env.form({ scope: 'addresses' }));
    const err = await rejects(async () =>
      env.poppy.token(
        await env.form({ grant_type: DEVICE_CODE_GRANT, device_code: device.device_code }),
        undefined,
      ),
    );
    assert.equal(err.code, 'invalid_dpop_proof');
    await env.close();
  });

  test('prova inválida e replay → invalid_dpop_proof; nonce → use_dpop_nonce', async ({
    assert,
  }) => {
    let env = await setupPoppy();
    const dkey = await dpopKey();
    const form = () => env.form({ grant_type: 'refresh_token', refresh_token: 'x' });
    for (const proof of [
      'not-a-jwt',
      await dpopProof(dkey, { htu: 'https://evil.example/token' }),
      await dpopProof(dkey, { htm: 'GET' }),
      await dpopProof(dkey, { typ: 'JWT' }),
    ]) {
      assert.equal(
        (await rejects(async () => env.poppy.token(await form(), proof))).code,
        'invalid_dpop_proof',
      );
    }
    await env.close();

    env = await setupPoppy({ dpop: { requireNonce: true } });
    const err = await rejects(async () => env.poppy.token(await form(), await dpopProof(dkey)));
    assert.equal(err.code, 'use_dpop_nonce');
    assert.isOk(err.headers['DPoP-Nonce']);
    await env.close();
  });
});

test.group('poppy — Direct Sign-In', () => {
  test('consentimento → code + state + iss → tokens no formato RFC 6749', async ({ assert }) => {
    const env = await setupPoppy();
    const { url, response } = await directSignIn(env);
    assert.equal(url.searchParams.get('state'), 'st4te');
    assert.equal(url.searchParams.get('iss'), POPPY_ISSUER);
    assert.equal(response.scope, 'orders:read orders:write');
    assert.isOk(response.refresh_token);
    assert.equal(response.expires_in, 3600);
    assert.notProperty(response, 'session_id');
    assert.notProperty(response, 'signed_in');
    assert.notProperty(response, 'refresh_token_expires_in');

    const ok = await env.poppy.verifyAccess(await env.request({ token: response.access_token }));
    assert.isTrue(ok.ok && ok.principal.signedIn);
    if (ok.ok) {
      assert.equal(ok.principal.accountId, ACCOUNT_ID);
      assert.equal(ok.principal.tokenType, 'Bearer');
      assert.deepEqual(ok.principal.scopes, ['orders:read', 'orders:write']);
    }
    await env.close();
  });

  test('negar ou aprovar nenhum scope → access_denied + iss; redirect_uri errado não redireciona', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const { challenge } = pkce();
    const params = {
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: 'orders:read',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    };
    const start = await env.poppy.startAuthorization(params, ACCOUNT_ID);
    if (start.kind !== 'consent') throw new Error('consent');
    const none = await env.poppy.decideAuthorization({
      requestId: start.request.id,
      accountId: ACCOUNT_ID,
      allow: true,
      scopes: [],
    });
    const url = new URL(none!.url);
    assert.equal(url.searchParams.get('error'), 'access_denied');
    assert.equal(url.searchParams.get('iss'), POPPY_ISSUER);

    const bad = await env.poppy.startAuthorization(
      { ...params, redirect_uri: 'https://evil.example/cb' },
      ACCOUNT_ID,
    );
    assert.equal(bad.kind, 'error');
    const scope = await env.poppy.startAuthorization({ ...params, scope: 'nope' }, ACCOUNT_ID);
    assert.equal(scope.kind, 'redirect');
    if (scope.kind === 'redirect') assert.match(scope.url, /error=invalid_scope/);
    await env.close();
  });

  test('código reusado revoga o que entregou; PKCE errado → invalid_grant', async ({ assert }) => {
    const env = await setupPoppy();
    const { verifier, challenge } = pkce();
    const start = await env.poppy.startAuthorization(
      {
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: 'orders:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
      ACCOUNT_ID,
    );
    if (start.kind !== 'consent') throw new Error('consent');
    const d = await env.poppy.decideAuthorization({
      requestId: start.request.id,
      accountId: ACCOUNT_ID,
      allow: true,
      scopes: ['orders:read'],
    });
    const code = new URL(d!.url).searchParams.get('code');
    const form = (code_verifier: string) =>
      env.form({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier,
      });
    const wrong = await rejects(async () => env.poppy.token(await form(b64(32)), undefined));
    assert.match(wrong.description, /PKCE/);
    await env.poppy.token(await form(verifier), undefined);
    assert.lengthOf(await env.poppy.listGrants(ACCOUNT_ID), 1);
    const again = await rejects(async () => env.poppy.token(await form(verifier), undefined));
    assert.equal(again.code, 'invalid_grant');
    assert.lengthOf(await env.poppy.listGrants(ACCOUNT_ID), 0);
    await env.close();
  });
});

test.group('poppy — Device Sign-In', () => {
  test('pending → slow_down → aprovado → tokens; consumido não volta', async ({ assert }) => {
    const env = await setupPoppy();
    const device: any = await env.poppy.deviceAuthorization(
      await env.form({ scope: 'orders:read' }),
    );
    assert.match(device.verification_uri, /\/poppy\/device$/);
    const poll = async () =>
      env.poppy.token(
        await env.form({ grant_type: DEVICE_CODE_GRANT, device_code: device.device_code }),
        undefined,
      );
    assert.equal((await rejects(poll)).code, 'authorization_pending');
    assert.equal((await rejects(poll)).code, 'slow_down');
    await env.poppy.decideDevice({
      userCode: device.user_code,
      accountId: ACCOUNT_ID,
      allow: true,
      scopes: ['orders:read'],
    });
    const res = await poll();
    assert.isOk(res.refresh_token);
    assert.equal((await rejects(poll)).code, 'invalid_grant');
    await env.close();
  });

  test('negado → access_denied; expirado → expired_token; scope ausente → invalid_scope', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const device: any = await env.poppy.deviceAuthorization(
      await env.form({ scope: 'orders:read' }),
    );
    await env.poppy.decideDevice({
      userCode: device.user_code,
      accountId: ACCOUNT_ID,
      allow: false,
      scopes: [],
    });
    const poll = async (code: string) =>
      env.poppy.token(
        await env.form({ grant_type: DEVICE_CODE_GRANT, device_code: code }),
        undefined,
      );
    assert.equal((await rejects(() => poll(device.device_code))).code, 'access_denied');

    const late: any = await env.poppy.deviceAuthorization(await env.form({ scope: 'addresses' }));
    env.setNow(Date.now() + 601_000);
    assert.equal((await rejects(() => poll(late.device_code))).code, 'expired_token');
    env.setNow(null);

    const err = await rejects(async () => env.poppy.deviceAuthorization(await env.form({})));
    assert.equal(err.code, 'invalid_scope');
    await env.close();
  });
});

test.group('poppy — refresh, revogação e contas', () => {
  test('refresh: narrowing, invalid_scope, outro client', async ({ assert }) => {
    const env = await setupPoppy();
    const signed = await env.signIn();
    const refresh = async (extra: Record<string, unknown> = {}) =>
      env.poppy.token(
        await env.form({
          grant_type: 'refresh_token',
          refresh_token: signed.refresh_token,
          ...extra,
        }),
        undefined,
      );
    const res = await refresh({ scope: 'orders:read' });
    assert.equal(res.scope, 'orders:read');
    assert.notProperty(res, 'refresh_token');
    assert.equal((await rejects(() => refresh({ scope: 'addresses' }))).code, 'invalid_scope');
    const unknown = await rejects(async () =>
      env.poppy.token(
        await env.form({ grant_type: 'refresh_token', refresh_token: 'poa_x' }),
        undefined,
      ),
    );
    assert.equal(unknown.code, 'invalid_grant');
    await env.close();
  });

  test('um sign-in serve várias Sessions; o token precisa ser do mesmo client_id', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const OTHER = 'https://agent2.example/agent.json';
    const JWKS2 = 'https://agent2.example/jwks.json';
    env.docs.set(OTHER, clientMetadata({ client_id: OTHER, jwks_uri: JWKS2, redirect_uris: [] }));
    env.docs.set(JWKS2, { keys: [env.keys.jwk] });
    const { access_token: token } = await env.signIn();
    for (const sid of ['a', 'b']) {
      const ok = await env.poppy.verifyAccess(await env.request({ sid, token }));
      assert.isTrue(ok.ok && ok.principal.signedIn);
    }
    const f = failure(
      await env.poppy.verifyAccess(
        await env.request({ sid: 'c', token, iss: OTHER, delegation: { iss: OTHER } }),
      ),
    );
    assert.equal(f.error, 'invalid_session');
    await env.close();
  });

  test('Session com outra conta → invalid_session; deslogada continua', async ({ assert }) => {
    const env = await setupPoppy();
    const jane = await env.signIn();
    const john = await env.signIn({ accountId: OTHER_ACCOUNT_ID });
    assert.isTrue(
      (await env.poppy.verifyAccess(await env.request({ token: jane.access_token }))).ok,
    );
    const f = failure(
      await env.poppy.verifyAccess(await env.request({ token: john.access_token })),
    );
    assert.equal(f.status, 400);
    assert.equal(f.error, 'invalid_session');
    const out = await env.poppy.verifyAccess(await env.request());
    assert.isTrue(out.ok && !out.principal.signedIn);
    await env.close();
  });

  test('revogação (RFC 7009): access token morre, Session continua deslogada, refresh falha', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const signed = await env.signIn();
    await env.poppy.revoke(await env.form({ token: signed.refresh_token }));
    const f = failure(
      await env.poppy.verifyAccess(await env.request({ token: signed.access_token })),
    );
    assert.equal(f.status, 401);
    assert.equal(f.error, 'invalid_token');
    assert.isTrue((await env.poppy.verifyAccess(await env.request())).ok);
    const err = await rejects(async () =>
      env.poppy.token(
        await env.form({ grant_type: 'refresh_token', refresh_token: signed.refresh_token }),
        undefined,
      ),
    );
    assert.equal(err.code, 'invalid_grant');
    // Desconhecido: sem erro.
    await env.poppy.revoke(await env.form({ token: 'poa_desconhecido' }));
    await env.close();
  });

  test('desconectar pela conta e "sair de tudo" revogam os refresh tokens', async ({ assert }) => {
    const env = await setupPoppy();
    await env.signIn();
    const [grant] = await env.poppy.listGrants(ACCOUNT_ID);
    assert.isFalse(await env.poppy.revokeAccountGrant(OTHER_ACCOUNT_ID, grant.id));
    assert.isTrue(await env.poppy.revokeAccountGrant(ACCOUNT_ID, grant.id));
    await env.signIn();
    assert.equal(await env.poppy.revokeAllAccountGrants(ACCOUNT_ID), 1);
    assert.lengthOf(await env.poppy.listGrants(ACCOUNT_ID), 0);
    await env.close();
  });
});

test.group('poppy — access token no resource server', () => {
  test('challenge sem código (401), insufficient_scope (403), token desconhecido', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const needs = failure(
      await env.poppy.verifyAccess(await env.request(), { scopes: ['orders:read'] }),
    );
    assert.equal(needs.status, 401);
    assert.isNull(needs.error);
    assert.equal(
      needs.wwwAuthenticate,
      'Bearer scope="orders:read", DPoP algs="ES256", scope="orders:read"',
    );

    const signed = await env.signIn({ scope: 'orders:read' });
    const scope = failure(
      await env.poppy.verifyAccess(await env.request({ token: signed.access_token }), {
        scopes: ['orders:write'],
      }),
    );
    assert.equal(scope.status, 403);
    assert.equal(scope.error, 'insufficient_scope');
    assert.match(scope.wwwAuthenticate!, /^Bearer .*scope="orders:write"/);

    const unknown = failure(await env.poppy.verifyAccess(await env.request({ token: 'pat_x' })));
    assert.equal(unknown.status, 401);
    assert.equal(unknown.error, 'invalid_token');

    env.setNow(Date.now() + 3601_000);
    const expired = failure(
      await env.poppy.verifyAccess(
        await env.request({
          sid: b64(),
          token: signed.access_token,
          iat: Math.floor(Date.now() / 1000) + 3601,
        }),
      ),
    );
    assert.equal(expired.error, 'invalid_token');
    await env.close();
  });

  test('ath precisa cobrir o token', async ({ assert }) => {
    const env = await setupPoppy();
    const a = await env.signIn();
    const b = await env.signIn();
    const req = await env.request({ token: a.access_token });
    req.headers.authorization = `Bearer ${b.access_token}`;
    assert.equal(failure(await env.poppy.verifyAccess(req)).error, 'invalid_session');
    await env.close();
  });

  test('token DPoP: exige a prova e o esquema; Session JWT e prova com chaves próprias', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const dkey = await dpopKey();
    const signed = await env.signIn({ dkey });
    const token = signed.access_token;
    const ok = await env.poppy.verifyAccess(await env.request({ token, dkey }));
    assert.isTrue(ok.ok && ok.principal.tokenType === 'DPoP');

    const asBearer = failure(await env.poppy.verifyAccess(await env.request({ token })));
    assert.equal(asBearer.error, 'invalid_token');
    assert.match(asBearer.wwwAuthenticate!, /^DPoP /);

    const noProof = failure(
      await env.poppy.verifyAccess(await env.request({ token, scheme: 'DPoP' })),
    );
    assert.equal(noProof.error, 'invalid_dpop_proof');

    const otherKey = failure(
      await env.poppy.verifyAccess(await env.request({ token, dkey: await dpopKey() })),
    );
    assert.equal(otherKey.error, 'invalid_dpop_proof');
    await env.close();
  });

  test('resource (RFC 8707): só vale nele, e o erro aponta a metadata; desconhecido → invalid_target', async ({
    assert,
  }) => {
    const resource = 'https://api.shop.example/orders';
    const env = await setupPoppy({
      apis: [{ type: 'openapi', url: resource, description: 'Orders', resource }],
    });
    assert.notProperty((env.poppy.discoveryDocument('shop.example') as any).apis[0], 'resource');
    const signed = await env.signIn();
    const narrow = await env.poppy.token(
      await env.form({
        grant_type: 'refresh_token',
        refresh_token: signed.refresh_token,
        resource,
      }),
      undefined,
    );
    const ok = await env.poppy.verifyAccess(
      await env.request({ url: `${resource}/1`, token: narrow.access_token }),
    );
    assert.isTrue(ok.ok && ok.principal.resource === resource);

    const outside = failure(
      await env.poppy.verifyAccess(
        await env.request({ url: 'https://shop.example/x', token: narrow.access_token }),
      ),
    );
    assert.equal(outside.error, 'invalid_token');

    const defaultToken = failure(
      await env.poppy.verifyAccess(
        await env.request({ url: `${resource}/1`, token: signed.access_token }),
      ),
    );
    assert.equal(defaultToken.error, 'invalid_token');
    assert.include(
      defaultToken.wwwAuthenticate!,
      'resource_metadata="https://api.shop.example/.well-known/oauth-protected-resource/orders"',
    );

    const err = await rejects(async () =>
      env.poppy.token(
        await env.form({
          grant_type: 'refresh_token',
          refresh_token: signed.refresh_token,
          resource: 'https://other.example/',
        }),
        undefined,
      ),
    );
    assert.equal(err.code, 'invalid_target');
    await env.close();
  });
});

test.group('poppy — MCP', () => {
  test('token do MCP é Bearer, vira AccessToken do oidc-provider e só vale nele', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const dkey = await dpopKey();
    const signed = await env.signIn({ dkey, scope: 'orders:read' });

    // Com prova ou sem: o MCP daqui não anuncia DPoP.
    const bearer = await env.poppy.token(
      await env.form({
        grant_type: 'refresh_token',
        refresh_token: signed.refresh_token,
        resource: MCP_URL,
      }),
      await dpopProof(dkey),
    );
    assert.equal(bearer.token_type, 'Bearer');

    const provider = env.service.provider as any;
    const at = await provider.AccessToken.find(bearer.access_token);
    assert.equal(at.accountId, ACCOUNT_ID);
    assert.equal(at.clientId, CLIENT_ID);
    assert.equal(at.aud, MCP_URL);
    assert.equal(at.scope, 'orders:read');

    const ok = await env.poppy.verifyAccess(
      await env.request({ method: 'POST', url: MCP_URL, token: bearer.access_token }),
    );
    assert.isTrue(ok.ok && ok.principal.tokenType === 'Bearer');

    const elsewhere = failure(
      await env.poppy.verifyAccess(await env.request({ token: bearer.access_token })),
    );
    assert.equal(elsewhere.error, 'invalid_token');

    const dpopAtMcp = failure(
      await env.poppy.verifyAccess(
        await env.request({ method: 'POST', url: MCP_URL, token: signed.access_token, dkey }),
      ),
    );
    assert.equal(dpopAtMcp.error, 'invalid_token');
    assert.include(
      dpopAtMcp.wwwAuthenticate!,
      'resource_metadata="https://shop.example/.well-known/oauth-protected-resource/mcp"',
    );

    // Sign-out derruba o AccessToken do oidc-provider.
    await env.poppy.revoke(await env.form({ token: signed.refresh_token }));
    assert.isUndefined(await provider.AccessToken.find(bearer.access_token));
    assert.isUndefined(await provider.Grant.find(at.grantId));
    await env.close();
  });

  test('deslogado no MCP: só o header da Session', async ({ assert }) => {
    const env = await setupPoppy();
    const ok = await env.poppy.verifyAccess(await env.request({ method: 'POST', url: MCP_URL }));
    assert.isTrue(ok.ok && !ok.principal.signedIn);
    const needs = failure(
      await env.poppy.verifyAccess(await env.request({ method: 'POST', url: MCP_URL }), {
        signedIn: true,
      }),
    );
    assert.match(needs.wwwAuthenticate!, /^Bearer resource_metadata=/);
    await env.close();
  });

  test('MCP registrado no slot global de resources também vale', async ({ assert }) => {
    const slot = globalThis as Record<symbol, unknown>;
    const key = Symbol.for('@adonis-agora/oauth:resources');
    const before = slot[key];
    slot[key] = [{ url: 'https://shop.example/agent/mcp' }];
    try {
      const env = await setupPoppy({ apis: [] });
      const signed = await env.signIn();
      const res = await env.poppy.token(
        await env.form({
          grant_type: 'refresh_token',
          refresh_token: signed.refresh_token,
          resource: 'https://shop.example/agent/mcp',
        }),
        undefined,
      );
      assert.equal(res.token_type, 'Bearer');
      await env.close();
    } finally {
      slot[key] = before;
    }
  });
});

test.group('poppy — extensão Mediated Sign-In', () => {
  const ctx = {} as any;
  const fields = [
    { name: 'email', label: 'Email', secret: false },
    { name: 'password', label: 'Password', secret: true },
  ];
  const start = (env: Env, extra: Record<string, unknown> = {}) =>
    env.form({
      grant_type: MEDIATED_SIGN_IN_GRANT,
      scope: 'orders:read',
      email: 'jane@example.com',
      password: 'pw',
      ...extra,
    });

  test('anunciado em extensions e no grant; complete devolve tokens; erros OAuth', async ({
    assert,
  }) => {
    const seen: any[] = [];
    const env = await setupPoppy({
      signIn: {
        mediated: {
          fields,
          scopes: ['orders:read'],
          verify: async (input) => {
            seen.push(input);
            if (input.credentials.password === 'denied') return { status: 'denied' };
            return input.credentials.password === 'pw'
              ? { status: 'complete', accountId: ACCOUNT_ID }
              : { status: 'failed' };
          },
        },
      },
    });
    const doc = env.poppy.discoveryDocument('shop.example') as any;
    assert.deepEqual(doc.extensions['mediated-sign-in'], {
      version: '1',
      fields,
      scopes: ['orders:read'],
    });
    assert.notProperty(doc.auth, 'mediated');
    assert.include(
      (env.poppy.authorizationServerMetadata() as any).grant_types_supported,
      MEDIATED_SIGN_IN_GRANT,
    );

    const res = await env.poppy.token(await start(env), undefined, ctx);
    assert.isOk(res.refresh_token);
    assert.equal(res.scope, 'orders:read');
    assert.deepEqual(seen[0].credentials, { email: 'jane@example.com', password: 'pw' });

    const code = async (extra: Record<string, unknown>) =>
      (await rejects(async () => env.poppy.token(await start(env, extra), undefined, ctx))).code;
    assert.equal(await code({ password: 'wrong' }), 'invalid_grant');
    assert.equal(await code({ password: 'denied' }), 'access_denied');
    assert.equal(await code({ scope: 'orders:write' }), 'invalid_scope');
    assert.equal(await code({ scope: '' }), 'invalid_scope');
    assert.equal(await code({ password: '' }), 'invalid_request');
    await env.close();
  });

  test('desligado: grant não suportado; campo reservado recusado no boot', async ({ assert }) => {
    const env = await setupPoppy();
    const err = await rejects(async () => env.poppy.token(await start(env), undefined, ctx));
    assert.equal(err.code, 'unsupported_grant_type');
    await env.close();
    for (const name of ['grant_type', 'scope', 'client_id', 'sign_in_id', 'one_time_code']) {
      assert.throws(
        () =>
          resolvePersonalAgentsConfig({
            poppy: {
              organization: { name: 'S', domain: 's.example' },
              scopes: { a: 'A' },
              signIn: {
                mediated: {
                  fields: [{ name, label: 'x', secret: false }],
                  scopes: ['a'],
                  verify: async () => ({ status: 'failed' }),
                },
              },
            },
          }),
        /reservado/,
      );
    }
  });

  test('code_required → errado → certo; só o client que começou; limite → invalid_grant', async ({
    assert,
  }) => {
    const env = await setupPoppy({
      signIn: {
        mediated: {
          fields,
          scopes: ['orders:read'],
          maxCodeAttempts: 2,
          verify: async () => ({
            status: 'code_required',
            accountId: ACCOUNT_ID,
            sentTo: 'Text to …71',
            code: '123456',
          }),
        },
      },
    });
    const send = async (signInId: string, oneTimeCode: string) =>
      env.poppy.token(
        await env.form({
          grant_type: MEDIATED_SIGN_IN_GRANT,
          sign_in_id: signInId,
          one_time_code: oneTimeCode,
        }),
        undefined,
        ctx,
      );

    const first = await rejects(async () => env.poppy.token(await start(env), undefined, ctx));
    assert.equal(first.code, 'code_required');
    assert.equal(first.status, 400);
    assert.equal(first.extra.sent_to, 'Text to …71');
    assert.equal(first.extra.expires_in, 600);
    const id = first.extra.sign_in_id as string;

    const wrong = await rejects(() => send(id, '000000'));
    assert.equal(wrong.code, 'code_required');
    const done = await send(id, '123456');
    assert.equal(done.scope, 'orders:read');
    assert.equal((await rejects(() => send(id, '123456'))).code, 'invalid_grant');
    assert.equal((await rejects(() => send('sgn_nope', '1'))).code, 'invalid_grant');

    const second = await rejects(async () => env.poppy.token(await start(env), undefined, ctx));
    const secondId = second.extra.sign_in_id as string;
    await rejects(() => send(secondId, 'x'));
    assert.equal((await rejects(() => send(secondId, 'y'))).code, 'invalid_grant');
    assert.equal((await rejects(() => send(secondId, '123456'))).code, 'invalid_grant');

    const third = await rejects(async () => env.poppy.token(await start(env), undefined, ctx));
    env.setNow(Date.now() + 601_000);
    const expired = await rejects(() => send(third.extra.sign_in_id as string, '123456'));
    assert.equal(expired.code, 'expired_token');
    await env.close();
  });

  test('sem conta (accountId: null): mesma resposta, todo código é errado; verifyCode do app', async ({
    assert,
  }) => {
    const env = await setupPoppy({
      signIn: {
        mediated: {
          fields,
          scopes: ['orders:read'],
          verify: async ({ credentials }) =>
            credentials.email === 'nobody@example.com'
              ? { status: 'code_required', accountId: null, sentTo: 'x' }
              : { status: 'code_required', accountId: ACCOUNT_ID, sentTo: 'x', state: { n: 1 } },
          verifyCode: async ({ code, state }) => code === 'ok' && (state as any).n === 1,
        },
      },
    });
    const send = async (id: unknown, oneTimeCode: string) =>
      env.poppy.token(
        await env.form({
          grant_type: MEDIATED_SIGN_IN_GRANT,
          sign_in_id: id,
          one_time_code: oneTimeCode,
        }),
        undefined,
        ctx,
      );
    const decoy = await rejects(async () =>
      env.poppy.token(await start(env, { email: 'nobody@example.com' }), undefined, ctx),
    );
    const real = await rejects(async () => env.poppy.token(await start(env), undefined, ctx));
    assert.deepEqual(Object.keys(decoy.extra), Object.keys(real.extra));
    assert.equal((await rejects(() => send(decoy.extra.sign_in_id, 'ok'))).code, 'code_required');
    assert.isOk((await send(real.extra.sign_in_id, 'ok')).access_token);
    await env.close();
  });

  test('limite por (agente, identificador): 429 com Retry-After', async ({ assert }) => {
    const env = await setupPoppy({
      rateLimit: { mediatedPerHour: 1 },
      signIn: {
        mediated: { fields, scopes: ['orders:read'], verify: async () => ({ status: 'failed' }) },
      },
    });
    assert.equal(
      (await rejects(async () => env.poppy.token(await start(env), undefined, ctx))).code,
      'invalid_grant',
    );
    const over = await rejects(async () => env.poppy.token(await start(env), undefined, ctx));
    assert.equal(over.status, 429);
    assert.isOk(over.headers['Retry-After']);
    await env.close();
  });
});

test.group('poppy — slot de endpoints do agente', () => {
  test('sem agent.protocols no config, usa o endpoint registrado no slot global', async ({
    assert,
  }) => {
    const slot = globalThis as Record<symbol, unknown>;
    const key = Symbol.for('@adonis-agora/poppy:endpoints');
    const before = slot[key];
    try {
      const env = await setupPoppy({ agent: undefined });
      assert.notProperty(env.poppy.discoveryDocument('shop.example') as any, 'agent');
      slot[key] = { conversations: 'https://shop.example/poppy/conversations' };
      const doc = env.poppy.discoveryDocument('shop.example') as any;
      assert.deepEqual(doc.agent.protocols, [
        { type: 'poppy', endpoint: 'https://shop.example/poppy/conversations' },
      ]);
      await env.close();
    } finally {
      slot[key] = before;
    }
  });
});

test.group('poppy — config', () => {
  test('app só-Poppy (sem audience), PACT desligado; validações', ({ assert }) => {
    const org = { name: 'Shop', domain: 'Shop.example' };
    const scopes = { 'orders:read': 'Orders' };
    const only = resolvePersonalAgentsConfig({ poppy: { organization: org, scopes } })!;
    assert.isFalse(only.pact);
    assert.equal(only.poppy!.organization.domain, 'shop.example');
    assert.equal(only.poppy!.prefix, '/poppy');
    assert.isNull(only.poppy!.signIn.mediated);
    assert.deepEqual(only.poppy!.signIn.direct!.scopes, ['orders:read']);
    assert.isFalse(only.poppy!.dpop.required);
    assert.equal(only.poppy!.sessionJwt.maxAge, 60);

    // `www.` não é normalizado: o domínio é exatamente o que serve o documento (§3.1).
    const www = resolvePersonalAgentsConfig({
      poppy: { organization: { name: 'S', domain: 'www.shop.example' }, scopes },
    })!;
    assert.equal(www.poppy!.organization.domain, 'www.shop.example');

    // O protocolo não reserva nomes (§4.7).
    const named = resolvePersonalAgentsConfig({
      poppy: { organization: org, scopes: { 'poppy:admin': 'x' } },
    })!;
    assert.deepEqual(named.poppy!.scopes, { 'poppy:admin': 'x' });

    // Os scopes da delegação PACT viram os scopes do Poppy por default.
    const both = resolvePersonalAgentsConfig({
      audience: 'aud',
      delegation: { interfaceUrl: 'https://shop.example/a2a', scopes },
      poppy: { organization: org },
    })!;
    assert.isTrue(both.pact);
    assert.deepEqual(both.poppy!.scopes, scopes);

    const signedOutOnly = resolvePersonalAgentsConfig({
      poppy: { organization: org, signIn: { direct: false, device: false } },
    })!;
    assert.deepEqual(signedOutOnly.poppy!.scopes, {});

    const bad = (poppy: Record<string, unknown>) => () =>
      resolvePersonalAgentsConfig({ poppy: { organization: org, scopes, ...poppy } as any });
    assert.throws(() => resolvePersonalAgentsConfig({} as any), /audience/);
    assert.throws(() => resolvePersonalAgentsConfig({ poppy: { organization: org } }), /scope/);
    assert.throws(bad({ organization: { name: 'x', domain: 'https://x.example' } }), /domínio/);
    assert.throws(bad({ signIn: { direct: { scopes: ['nope'] } } }), /desconhecido/);
    assert.throws(bad({ scopeHints: { a: { changes: 'maybe', personal_data: true } } }), /changes/);
    assert.throws(bad({ scopeHints: { a: { changes: 'none' } } }), /personal_data/);
    assert.throws(bad({ web: { redirectTo: 'https://evil.example' } }), /redirectTo/);
    assert.throws(
      bad({ agent: { protocols: [{ type: 'poppy', endpoint: 'https://a.b', access: 'x' }] } }),
      /access/,
    );
    assert.throws(
      bad({
        signIn: { mediated: { fields: [{ name: 'a', label: 'a', secret: false }], verify() {} } },
      }),
      /mediated.scopes/,
    );
    assert.throws(
      () =>
        resolvePersonalAgentsConfig({
          audience: 'a',
          protocol: 'poppy' as any,
          poppy: { organization: org, scopes },
        }),
      /personalAgents.poppy/,
    );
    assert.throws(
      () =>
        resolvePersonalAgentsConfig({
          audience: 'a',
          prefix: '/agents',
          poppy: { organization: org, scopes, prefix: '/agents/poppy' },
        }),
      /debaixo/,
    );
  });
});
