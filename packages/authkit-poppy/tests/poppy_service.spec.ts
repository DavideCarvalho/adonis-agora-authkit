import { test } from '@japa/runner';
import { redirectUriAllowed } from '../src/client_registry.js';
import { resolvePoppyConfig } from '../src/config.js';
import { PoppyError } from '../src/errors.js';
import { poppy as poppyExtension } from '../src/extension.js';
import {
  DEVICE_CODE_GRANT,
  MEDIATED_SIGN_IN_GRANT,
  type PoppyVerifyResult,
} from '../src/service.js';
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
  test('poppy.json 1.0: domínio exato, auth com scopes/hints, descrição do agente, tasks, web', async ({
    assert,
  }) => {
    const env = await setupPoppy({
      scopeHints: { 'orders:read': { changes: 'none', personal_data: true } },
      tasks: { feedback: { endpoint: 'https://shop.example/poppy/feedback' } },
      agent: {
        protocols: [
          {
            type: 'poppy',
            endpoint: 'https://shop.example/poppy/conversations',
            description: 'Anything about your orders',
            access: 'signed_in',
            resource: 'https://shop.example/poppy/conversations',
          },
        ],
      },
    });
    const doc = env.poppy.discoveryDocument('SHOP.example') as any;
    assert.equal(doc.protocol_version, '1.0');
    assert.notProperty(doc, 'supported_versions');
    assert.deepEqual(doc.organization, { name: 'Shop', domain: 'shop.example' });
    assert.equal(doc.auth.issuer, POPPY_ISSUER);
    assert.notProperty(doc.auth, 'disabled');
    assert.equal(doc.auth.scopes['orders:read'], 'See your orders');
    assert.equal(
      doc.auth.scopes['poppy:browser-sign-in'],
      'Browse the website, and see and do anything your account can do there',
    );
    assert.deepEqual(doc.auth.scope_hints, {
      'orders:read': { changes: 'none', personal_data: true },
      'poppy:browser-sign-in': { changes: 'irreversible', personal_data: true },
    });
    assert.deepEqual(doc.agent.protocols, [
      {
        type: 'poppy',
        endpoint: 'https://shop.example/poppy/conversations',
        description: 'Anything about your orders',
        access: 'signed_in',
      },
    ]);
    assert.deepEqual(doc.tasks, { endpoint: `${POPPY_ISSUER}/tasks` });
    assert.notProperty(doc, 'feedback');
    assert.notProperty(doc, 'excluded_tasks');
    assert.deepEqual(doc.web, {
      browser_session_endpoint: `${POPPY_ISSUER}/browser-session`,
      unscoped: true,
    });
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
    // `organization.domain` leva a porta quando não é a 443 (§3.1).
    assert.equal(doc.organization.domain, 'localhost:3333');
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
    assert.notProperty(meta, 'pushed_authorization_request_endpoint');
    // Sem nenhum sign-in: `auth.disabled`, e o scope do navegador não é oferecido.
    const doc = env.poppy.discoveryDocument('shop.example') as any;
    assert.isTrue(doc.auth.disabled);
    assert.notProperty(doc.auth.scopes, 'poppy:browser-sign-in');
    await env.close();
  });

  test('web.disabled e web.unscoped: false; o scope do navegador muda de descrição', async ({
    assert,
  }) => {
    const disabled = await setupPoppy({ web: { disabled: true } });
    const doc = disabled.poppy.discoveryDocument('shop.example') as any;
    assert.deepEqual(doc.web, { disabled: true });
    assert.notProperty(doc.auth.scopes, 'poppy:browser-sign-in');
    await disabled.close();

    const scoped = await setupPoppy({ web: { unscoped: false } });
    const scopedDoc = scoped.poppy.discoveryDocument('shop.example') as any;
    assert.deepEqual(scopedDoc.web, {
      browser_session_endpoint: `${POPPY_ISSUER}/browser-session`,
    });
    assert.equal(
      scopedDoc.auth.scopes['poppy:browser-sign-in'],
      'Use the website signed in, with the other access you approve',
    );
    assert.notProperty(scopedDoc.auth.scope_hints ?? {}, 'poppy:browser-sign-in');
    // Oferecido nos dois sign-ins, mesmo com lista explícita.
    assert.include(scoped.poppy.cfg.signIn.direct!.scopes, 'poppy:browser-sign-in');
    await scoped.close();

    const explicit = await setupPoppy({ signIn: { direct: { scopes: ['orders:read'] } } });
    assert.deepEqual(explicit.poppy.cfg.signIn.direct!.scopes, [
      'orders:read',
      'poppy:browser-sign-in',
    ]);
    await explicit.close();
  });

  test('extensões: uma entrada por versão; Mediated Sign-In publicada como lista', async ({
    assert,
  }) => {
    const env = await setupPoppy({
      extensions: {
        'example.com/gift-wrap': [
          { version: '2', endpoint: 'https://shop.example/gift-wrap/v2' },
          { version: '1', endpoint: 'https://shop.example/gift-wrap' },
        ],
      },
    });
    const doc = env.poppy.discoveryDocument('shop.example') as any;
    assert.lengthOf(doc.extensions['example.com/gift-wrap'], 2);
    await env.close();
    assert.throws(
      () =>
        resolvePoppyConfig(
          {
            organization: { name: 'S', domain: 's.example' },
            scopes: { a: 'A' },
            extensions: { x: { version: '1' } as any },
          },
          undefined,
        ),
      /uma entrada por versão/,
    );
  });

  test('protected resource metadata lista os scopes; PAR na metadata do issuer', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const prm = env.poppy.protectedResourceMetadata('shop.example') as any;
    assert.deepEqual(prm.resource, 'https://shop.example');
    assert.includeMembers(prm.scopes_supported, ['orders:read', 'poppy:browser-sign-in']);
    const meta = env.poppy.authorizationServerMetadata() as any;
    assert.equal(meta.pushed_authorization_request_endpoint, `${POPPY_ISSUER}/oauth/par`);
    assert.isFalse(meta.require_pushed_authorization_requests);
    await env.close();
    const off = await setupPoppy({ par: false });
    assert.notProperty(
      off.poppy.authorizationServerMetadata(),
      'pushed_authorization_request_endpoint',
    );
    await off.close();
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

  test('Session por client_id + sid + User ID; jti repetido; Session encerrada → session_ended', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const first = await env.poppy.verifyAccess(await env.request({ sid: 's1', agentId: 'agt_1' }));
    assert.isTrue(first.ok);
    // O mesmo sid com outro User ID é outra Session (§5.3); o Agent ID não é conferido.
    const other = await env.poppy.verifyAccess(await env.request({ sid: 's1', sub: 'outro' }));
    assert.isTrue(other.ok);
    if (first.ok && other.ok) assert.notEqual(other.principal.sessionId, first.principal.sessionId);
    const agent2 = await env.poppy.verifyAccess(await env.request({ sid: 's1', agentId: 'agt_2' }));
    assert.isTrue(agent2.ok);
    if (first.ok && agent2.ok) {
      assert.equal(agent2.principal.sessionId, first.principal.sessionId);
      assert.equal(agent2.principal.agentId, 'agt_1');
    }
    const req = await env.request({ sid: 's1' });
    assert.isTrue((await env.poppy.verifyAccess(req)).ok);
    assert.match(failure(await env.poppy.verifyAccess(req)).description, /jti/);

    await env.poppy.disconnectClient(CLIENT_ID);
    const ended = failure(await env.poppy.verifyAccess(await env.request({ sid: 's1' })));
    assert.equal(ended.status, 400);
    assert.equal(ended.error, 'session_ended');
    assert.deepInclude(ended.body!, { error: 'session_ended' });
    assert.isNull(ended.wwwAuthenticate);
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

  test('Poppy-Version: obrigatório e compatível (mesmo major); antes da Session', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    for (const version of [null, '0.3', '2.0', 'x', '1']) {
      const f = failure(await env.poppy.verifyAccess(await env.request({ version, sid: 'v1' })));
      assert.equal(f.status, 400, String(version));
      assert.equal(f.error, 'version_unsupported', String(version));
      assert.equal(f.body!.error, 'version_unsupported');
    }
    const later = await env.poppy.verifyAccess(await env.request({ version: '1.3', sid: 'v1' }));
    assert.isTrue(later.ok);
    if (later.ok) assert.equal(later.principal.protocolVersion, '1.3');
    const ok = await env.poppy.verifyAccess(await env.request({ sid: 'v2' }));
    assert.isTrue(ok.ok);
    if (ok.ok) {
      assert.equal(ok.principal.protocolVersion, '1.0');
      assert.equal(ok.principal.documentVersion, '1.0');
    }
    await env.close();
  });

  test('Poppy-Extensions: só as listadas, na versão listada; extension_required', async ({
    assert,
  }) => {
    const env = await setupPoppy({
      extensions: { operations: [{ version: '3', endpoint: 'https://shop.example/ops' }] },
    });
    const declared = async (extensionsHeader: string) => {
      const r = await env.poppy.verifyAccess(await env.request({ extensionsHeader }));
      if (!r.ok) throw new Error(r.description);
      return r.principal.extensions;
    };
    assert.deepEqual(await declared('"operations";v="3", "links";v="1"'), { operations: '3' });
    assert.deepEqual(await declared('"operations";v="2"'), {});
    assert.deepEqual(await declared('operations;v="3"'), {});
    assert.deepEqual(await declared('"operations";v="3", ,'), {});
    assert.deepEqual(await declared('"operations";v=3'), {});
    const missing = failure(
      await env.poppy.verifyAccess(await env.request(), { extension: 'operations' }),
    );
    assert.equal(missing.status, 403);
    assert.deepInclude(missing.body!, { error: 'extension_required', extension: 'operations' });
    assert.isTrue(
      (
        await env.poppy.verifyAccess(
          await env.request({ extensionsHeader: '"operations";v="3"' }),
          {
            extension: 'operations',
          },
        )
      ).ok,
    );
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

  test('Session com outra conta → session_ended; deslogada continua', async ({ assert }) => {
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
    assert.equal(f.error, 'session_ended');
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
    assert.deepEqual(doc.extensions['mediated-sign-in'], [
      { version: '1', fields, scopes: ['orders:read'] },
    ]);
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
          resolvePoppyConfig(
            {
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
            undefined,
          ),
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
      // Sem `description` (obrigatória na 1.0): a entrada não sai.
      slot[key] = { conversations: 'https://shop.example/poppy/conversations' };
      assert.notProperty(env.poppy.discoveryDocument('shop.example') as any, 'agent');
      slot[key] = {
        conversations: 'https://shop.example/poppy/conversations',
        description: 'Anything about your orders',
      };
      const doc = env.poppy.discoveryDocument('shop.example') as any;
      assert.deepEqual(doc.agent.protocols, [
        {
          type: 'poppy',
          endpoint: 'https://shop.example/poppy/conversations',
          description: 'Anything about your orders',
        },
      ]);
      await env.close();
    } finally {
      slot[key] = before;
    }
  });
});

test.group('poppy — config', () => {
  test('resolve sem PACT; scopes da delegação PACT por default; validações', ({ assert }) => {
    const org = { name: 'Shop', domain: 'Shop.example' };
    const scopes = { 'orders:read': 'Orders' };
    const only = resolvePoppyConfig({ organization: org, scopes }, undefined)!;
    assert.equal(only.organization.domain, 'shop.example');
    assert.equal(only.prefix, '/poppy');
    assert.isNull(only.signIn.mediated);
    assert.deepEqual(only.signIn.direct!.scopes, ['orders:read', 'poppy:browser-sign-in']);
    assert.isTrue(only.web!.unscoped);
    assert.deepEqual(only.par, { required: false });
    assert.isFalse(only.dpop.required);
    assert.equal(only.sessionJwt.maxAge, 60);

    // `www.` não é normalizado: o domínio é exatamente o que serve o documento (§3.1).
    const www = resolvePoppyConfig(
      { organization: { name: 'S', domain: 'www.shop.example' }, scopes },
      undefined,
    )!;
    assert.equal(www.organization.domain, 'www.shop.example');

    // O protocolo não reserva nomes (§4.7).
    const named = resolvePoppyConfig(
      { organization: org, scopes: { 'poppy:admin': 'x' } },
      undefined,
    )!;
    assert.equal(named.scopes['poppy:admin'], 'x');

    // Os scopes da delegação PACT viram os scopes do Poppy por default (o authkit passa
    // `delegationScopes` para o `resolve` da extension).
    const definition = poppyExtension({ organization: org }).resolve({
      issuer: 'https://shop.example/oidc',
      delegationScopes: scopes,
    });
    assert.equal(definition.prefix, '/poppy');
    assert.equal(definition.grantIdPrefix, 'pgrant_');
    assert.deepInclude(resolvePoppyConfig({ organization: org }, scopes)!.scopes, scopes);

    const signedOutOnly = resolvePoppyConfig(
      { organization: org, signIn: { direct: false, device: false } },
      undefined,
    )!;
    assert.deepEqual(signedOutOnly.scopes, {});

    const bad = (poppy: Record<string, unknown>) => () =>
      resolvePoppyConfig({ organization: org, scopes, ...poppy } as any, undefined);
    assert.throws(
      () =>
        poppyExtension({ organization: org }).resolve({
          issuer: 'https://shop.example/oidc',
          delegationScopes: null,
        }),
      /scope/,
    );
    assert.throws(bad({ organization: { name: 'x', domain: 'https://x.example' } }), /domínio/);
    assert.throws(bad({ signIn: { direct: { scopes: ['nope'] } } }), /desconhecido/);
    assert.throws(bad({ scopeHints: { a: { changes: 'maybe', personal_data: true } } }), /changes/);
    assert.throws(bad({ scopeHints: { a: { changes: 'none' } } }), /personal_data/);
    assert.throws(bad({ web: { redirectTo: 'https://evil.example' } }), /redirectTo/);
    assert.throws(
      bad({
        agent: {
          protocols: [{ type: 'poppy', endpoint: 'https://a.b', description: 'd', access: 'x' }],
        },
      }),
      /access/,
    );
    assert.throws(
      bad({ agent: { protocols: [{ type: 'poppy', endpoint: 'https://a.b' }] } }),
      /description/,
    );
    assert.throws(
      bad({
        signIn: { direct: false, device: false },
        agent: {
          protocols: [
            { type: 'poppy', endpoint: 'https://a.b', description: 'd', access: 'signed_in' },
          ],
        },
      }),
      /signed_in/,
    );
    assert.throws(bad({ feedback: { endpoint: 'https://a.b/f' } }), /tasks/);
    assert.throws(bad({ assertionMaxLifetime: 120 }), /300/);
    assert.throws(bad({ web: { disabled: true, browserSession: true } }), /disabled/);
    assert.throws(bad({ web: { browserSession: false, unscoped: true } }), /unscoped/);
    assert.throws(bad({ tasks: { excludedTasks: [{ task: '' }] } }), /task/);
    assert.throws(
      bad({ tasks: { excludedTasks: [{ task: 'Wire', alternative: {} }] } }),
      /instructions ou references/,
    );
    assert.throws(
      bad({
        tasks: {
          excludedTasks: [
            {
              task: 'Wire',
              alternative: {
                references: [{ type: 'mcp', url: 'https://other.example/mcp', tool: 't' }],
              },
            },
          ],
        },
      }),
      /apis/,
    );
    assert.throws(
      bad({
        tasks: {
          skillIndex: {
            $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
            skills: [{ name: 'a', description: 'b', type: 'skill-md', url: 'x', digest: 'md5:1' }],
          },
        },
      }),
      /digest/,
    );
    assert.throws(
      bad({ tasks: { endpoint: 'https://a.b/tasks', feedback: { endpoint: 'https://a.b/f' } } }),
      /tasks.endpoint/,
    );
    assert.throws(
      bad({
        signIn: { mediated: { fields: [{ name: 'a', label: 'a', secret: false }], verify() {} } },
      }),
      /mediated.scopes/,
    );
  });

  test('definição da extension: CSRF, tabelas, mensagens, navegador do agente', ({ assert }) => {
    const definition = poppyExtension({
      organization: { name: 'Shop', domain: 'shop.example' },
      scopes: { a: 'A' },
      prefix: 'agents-poppy/',
    }).resolve({ issuer: 'https://shop.example/oidc', delegationScopes: null });
    assert.equal(definition.prefix, '/agents-poppy');
    assert.deepEqual(definition.csrfExemptPaths, [
      '/agents-poppy/oauth/token',
      '/agents-poppy/oauth/revoke',
      '/agents-poppy/oauth/par',
      '/agents-poppy/oauth/device',
      '/agents-poppy/browser-session',
      '/agents-poppy/browser-session/authorize',
      '/agents-poppy/feedback',
      '/agents-poppy/operations',
    ]);
    assert.deepEqual(
      definition.tables!.map((t) => t.name),
      [
        'auth_poppy_sessions',
        'auth_poppy_tokens',
        'auth_poppy_requests',
        'auth_poppy_grant_keys',
        'auth_poppy_grant_resources',
        'auth_poppy_delegated_keys',
        'auth_poppy_feedback',
        'auth_poppy_operations',
        'auth_poppy_operation_revisions',
        'auth_poppy_jtis',
      ],
    );
    assert.equal(definition.messages!['pt-BR']['mail.poppy_sign_in.code_label'], 'Seu código:');
    const ctx = (marker: unknown) => ({ session: { get: () => marker } }) as any;
    assert.isTrue(definition.isAgentBrowser!(ctx({ sessionId: 'ses_1' })));
    assert.isFalse(definition.isAgentBrowser!(ctx(undefined)));
  });
});

test.group('poppy — 1.0: PAR, chave DPoP no refresh, resources e tasks', () => {
  const PAR_URL = `${POPPY_ISSUER}/oauth/par`;

  /** Empurra um pedido Direct (RFC 9126) e devolve o `request_uri`. */
  async function push(env: Env, extra: Record<string, unknown> = {}, proof?: string) {
    const { verifier, challenge } = pkce();
    const pushed = await env.poppy.pushAuthorization(
      await env.form({
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        scope: 'orders:read',
        state: 'st4te',
        prompt: 'consent',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...extra,
      }),
      proof,
    );
    return { pushed, verifier };
  }

  /** Abre o `request_uri`, aprova e troca o código. */
  async function finish(env: Env, requestUri: string, verifier: string, proof?: string) {
    const start = await env.poppy.startAuthorization(
      { client_id: CLIENT_ID, request_uri: requestUri },
      ACCOUNT_ID,
    );
    if (start.kind !== 'consent') throw new Error(`unexpected ${start.kind}`);
    const decided = await env.poppy.decideAuthorization({
      requestId: start.request.id,
      accountId: ACCOUNT_ID,
      allow: true,
      scopes: ['orders:read'],
    });
    const url = new URL(decided!.url);
    assert_(url.searchParams.get('state') === 'st4te', 'state');
    return env.poppy.token(
      await env.form({
        grant_type: 'authorization_code',
        code: url.searchParams.get('code'),
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
      proof,
    );
  }

  function assert_(ok: boolean, what: string) {
    if (!ok) throw new Error(what);
  }

  test('PAR: request_uri de uso único, só para o mesmo client; os parâmetros vêm do push', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const { pushed, verifier } = await push(env);
    assert.match(pushed.request_uri, /^urn:ietf:params:oauth:request_uri:/);
    assert.equal(pushed.expires_in, 60);
    const res = await finish(env, pushed.request_uri, verifier);
    assert.equal(res.scope, 'orders:read');
    // Uso único.
    const again = await env.poppy.startAuthorization(
      { client_id: CLIENT_ID, request_uri: pushed.request_uri },
      ACCOUNT_ID,
    );
    assert.equal(again.kind, 'error');

    // Expirado.
    const old = await push(env);
    env.setNow(Date.now() + 61_000);
    const late = await env.poppy.startAuthorization(
      { client_id: CLIENT_ID, request_uri: old.pushed.request_uri },
      ACCOUNT_ID,
    );
    assert.equal(late.kind, 'error');
    env.setNow(null);

    // Erros no push: JSON OAuth, sem redirecionar.
    assert.equal((await rejects(() => push(env, { scope: 'nope' }))).code, 'invalid_scope');
    assert.equal(
      (await rejects(() => push(env, { redirect_uri: 'https://evil.example/cb' }))).code,
      'invalid_request',
    );
    assert.equal(
      (await rejects(() => push(env, { request_uri: 'urn:x' }))).code,
      'invalid_request',
    );
    assert.equal(
      (
        await rejects(async () =>
          env.poppy.pushAuthorization({ client_id: CLIENT_ID, scope: 'orders:read' }, undefined),
        )
      ).code,
      'invalid_client',
    );
    await env.close();
  });

  test('PAR exigido: authorization_endpoint sem request_uri volta com invalid_request', async ({
    assert,
  }) => {
    const env = await setupPoppy({ par: { required: true } });
    assert.isTrue(
      (env.poppy.authorizationServerMetadata() as any).require_pushed_authorization_requests,
    );
    const { challenge } = pkce();
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
    assert.equal(start.kind, 'redirect');
    if (start.kind === 'redirect') {
      assert.equal(new URL(start.url).searchParams.get('error'), 'invalid_request');
    }
    const { pushed, verifier } = await push(env);
    assert.isOk((await finish(env, pushed.request_uri, verifier)).access_token);
    await env.close();
  });

  test('PAR com prova DPoP: o código só sai com a mesma chave', async ({ assert }) => {
    const env = await setupPoppy();
    const key = await dpopKey();
    const other = await dpopKey();
    const a = await push(env, {}, await dpopProof(key, { htu: PAR_URL }));
    const err = await rejects(() => finish(env, a.pushed.request_uri, a.verifier, undefined));
    assert.equal(err.code, 'invalid_grant');
    const b = await push(env, {}, await dpopProof(key, { htu: PAR_URL }));
    const wrong = await rejects(async () =>
      finish(env, b.pushed.request_uri, b.verifier, await dpopProof(other)),
    );
    assert.equal(wrong.code, 'invalid_grant');
    const c = await push(env, {}, await dpopProof(key, { htu: PAR_URL }));
    const ok = await finish(env, c.pushed.request_uri, c.verifier, await dpopProof(key));
    assert.equal(ok.token_type, 'DPoP');
    await env.close();
  });

  test('refresh com a chave DPoP do sign-in; outra chave ou sem prova → invalid_grant', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const key = await dpopKey();
    const signed = await env.signIn({ dkey: key });
    const refresh = async (proof?: string) =>
      env.poppy.token(
        await env.form({ grant_type: 'refresh_token', refresh_token: signed.refresh_token }),
        proof,
      );
    assert.equal((await rejects(() => refresh())).code, 'invalid_grant');
    assert.equal(
      (await rejects(async () => refresh(await dpopProof(await dpopKey())))).code,
      'invalid_grant',
    );
    assert.equal((await refresh(await dpopProof(key))).token_type, 'DPoP');
    // MCP: o token sai Bearer, mas o refresh continua exigindo a chave.
    const mcp = await env.poppy.token(
      await env.form({
        grant_type: 'refresh_token',
        refresh_token: signed.refresh_token,
        resource: MCP_URL,
      }),
      await dpopProof(key),
    );
    assert.equal(mcp.token_type, 'Bearer');
    await env.close();

    // Sign-in sem prova: refresh solto, como antes. Desligado: qualquer chave.
    const loose = await setupPoppy({ dpop: { bindRefreshTokens: false } });
    const s2 = await loose.signIn({ dkey: key });
    const r2 = await loose.poppy.token(
      await loose.form({ grant_type: 'refresh_token', refresh_token: s2.refresh_token }),
      await dpopProof(await dpopKey()),
    );
    assert.equal(r2.token_type, 'DPoP');
    const s3 = await loose.signIn();
    assert.isOk(
      (
        await loose.poppy.token(
          await loose.form({ grant_type: 'refresh_token', refresh_token: s3.refresh_token }),
          undefined,
        )
      ).access_token,
    );
    await loose.close();
  });

  test('resource = https://{organization.domain} dá o token default', async ({ assert }) => {
    const env = await setupPoppy();
    const signed = await env.signIn();
    const res = await env.poppy.token(
      await env.form({
        grant_type: 'refresh_token',
        refresh_token: signed.refresh_token,
        resource: 'https://shop.example',
      }),
      undefined,
    );
    const ok = await env.poppy.verifyAccess(await env.request({ token: res.access_token }));
    assert.isTrue(ok.ok);
    if (ok.ok) assert.isNull(ok.principal.resource);
    await env.close();
  });

  test('client assertion de 5 minutos é aceita', async ({ assert }) => {
    const env = await setupPoppy();
    const iat = Math.floor(Date.now() / 1000);
    const client = await env.poppy.authenticateClient({
      ...(await env.form({})),
      client_assertion: await env.clientAssertion({ exp: iat + 300 }),
    });
    assert.equal(client.clientId, CLIENT_ID);
    await env.close();
  });

  test('tasks: resposta com o header da Session; por Session com resolve', async ({ assert }) => {
    const TASKS_URL = `${POPPY_ISSUER}/tasks`;
    const excluded = [
      {
        task: 'Send a wire transfer',
        alternative: { references: [{ type: 'web' as const, url: 'https://shop.example/wire' }] },
      },
      { task: 'Close an account' },
    ];
    const env = await setupPoppy({
      tasks: {
        excludedTasks: excluded,
        feedback: { endpoint: 'https://shop.example/poppy/feedback' },
      },
    });
    const res = await env.poppy.tasksResponse(await env.request({ url: TASKS_URL }));
    assert.isTrue(res.ok);
    if (res.ok) {
      assert.isFalse(res.perSession);
      assert.deepEqual(res.body, {
        excluded_tasks: excluded,
        feedback: { endpoint: 'https://shop.example/poppy/feedback' },
      });
    }
    const bad = await env.poppy.tasksResponse(
      await env.request({ url: TASKS_URL, version: '0.3' }),
    );
    assert.isTrue(!bad.ok && bad.error === 'version_unsupported');
    await env.close();

    const seen: string[] = [];
    const per = await setupPoppy({
      tasks: {
        resolve: ({ principal, response }) => {
          seen.push(principal.userId);
          return { ...response, excluded_tasks: [{ task: 'Beta' }] };
        },
      },
    });
    const r = await per.poppy.tasksResponse(await per.request({ url: TASKS_URL }));
    assert.isTrue(r.ok && r.perSession);
    if (r.ok) assert.deepEqual(r.body, { excluded_tasks: [{ task: 'Beta' }] });
    assert.deepEqual(seen, ['usr_Q7c1vK']);
    await per.close();

    const external = await setupPoppy({ tasks: { endpoint: 'https://api.shop.example/tasks' } });
    assert.deepEqual((external.poppy.discoveryDocument('shop.example') as any).tasks, {
      endpoint: 'https://api.shop.example/tasks',
    });
    await external.close();
  });
});
