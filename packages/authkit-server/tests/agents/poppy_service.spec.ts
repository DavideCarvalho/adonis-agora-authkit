import { test } from '@japa/runner';
import { PoppyError } from '../../src/agents/poppy/errors.js';
import { DEVICE_CODE_GRANT, JWT_BEARER_GRANT } from '../../src/agents/poppy/service.js';
import {
  ACCOUNT_ID,
  apiRequest,
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
async function directSignIn(
  env: Env,
  dkey: Awaited<ReturnType<typeof dpopKey>>,
  sessionId: string,
  scope = 'poppy:read poppy:write',
) {
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
  const code = new URL(decided!.url).searchParams.get('code')!;
  return env.poppy.token(
    await env.form({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      session_id: sessionId,
    }),
    await dpopProof(dkey),
  );
}

test.group('poppy — discovery', () => {
  test('poppy.json só no domínio da empresa, com www. e aliases', async ({ assert }) => {
    const env = await setupPoppy();
    const doc = env.poppy.discoveryDocument('shop.example') as any;
    assert.equal(doc.protocol_version, '0.1');
    assert.deepEqual(doc.organization, { name: 'Shop', domain: 'shop.example' });
    assert.equal(doc.auth.issuer, POPPY_ISSUER);
    assert.deepEqual(doc.auth.direct.scopes, ['poppy:read', 'poppy:write', 'addresses']);
    assert.deepEqual(doc.auth.custom_scopes, { addresses: 'Manage saved shipping addresses' });
    assert.notProperty(doc.auth, 'mediated');
    assert.equal(doc.agent.protocols[0].type, 'poppy');
    assert.equal(doc.web.browser_session_endpoint, `${POPPY_ISSUER}/browser-session`);
    assert.equal(doc.apis[1].type, 'mcp');
    assert.equal(
      (env.poppy.discoveryDocument('www.shop.example') as any).organization.domain,
      'shop.example',
    );
    assert.equal(
      (env.poppy.discoveryDocument('shop.example.co.uk') as any).web.browser_session_endpoint,
      'https://shop.example.co.uk/poppy/browser-session',
    );
    assert.isNull(env.poppy.discoveryDocument('evil.example'));
    assert.isNull(env.poppy.discoveryDocument('api.shop.example'));
    await env.close();
  });

  test('metadata RFC 8414 com poppy_domains e os endpoints', async ({ assert }) => {
    const env = await setupPoppy();
    const meta = env.poppy.authorizationServerMetadata() as any;
    assert.equal(meta.issuer, POPPY_ISSUER);
    assert.equal(meta.token_endpoint, TOKEN_URL);
    assert.equal(meta.revocation_endpoint, `${POPPY_ISSUER}/oauth/revoke`);
    assert.equal(meta.authorization_endpoint, `${POPPY_ISSUER}/oauth/authorize`);
    assert.equal(meta.device_authorization_endpoint, `${POPPY_ISSUER}/oauth/device`);
    assert.deepEqual(meta.poppy_domains, ['shop.example', 'shop.example.co.uk']);
    assert.deepEqual(meta.token_endpoint_auth_methods_supported, ['private_key_jwt']);
    assert.isTrue(meta.authorization_response_iss_parameter_supported);
    assert.include(meta.grant_types_supported, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    await env.close();
  });

  test('sem direct/device: endpoints somem da metadata', async ({ assert }) => {
    const env = await setupPoppy({ signIn: { direct: false, device: false } });
    const meta = env.poppy.authorizationServerMetadata() as any;
    assert.notProperty(meta, 'authorization_endpoint');
    assert.notProperty(meta, 'device_authorization_endpoint');
    const doc = env.poppy.discoveryDocument('shop.example') as any;
    assert.notProperty(doc.auth, 'direct');
    await env.close();
  });
});

test.group('poppy — identidade do agente', () => {
  test('client_id diferente da URL buscada → invalid_client', async ({ assert }) => {
    const env = await setupPoppy();
    env.docs.set(CLIENT_ID, clientMetadata({ client_id: 'https://agent.example/other.json' }));
    const dkey = await dpopKey();
    const err = await rejects(async () => env.startSession(dkey));
    assert.equal(err.code, 'invalid_client');
    assert.equal(err.status, 401);
    await env.close();
  });

  test('jwks_uri / redirect_uris de outro domínio, http, ou chave privada → invalid_client', async ({
    assert,
  }) => {
    for (const bad of [
      clientMetadata({ jwks_uri: 'https://keys.other.example/jwks.json' }),
      clientMetadata({ redirect_uris: ['http://agent.example/cb'] }),
      clientMetadata({ redirect_uris: ['https://evil.example/cb'] }),
      clientMetadata({ token_endpoint_auth_method: 'none' }),
    ]) {
      const env = await setupPoppy();
      env.docs.set(CLIENT_ID, bad);
      const err = await rejects(async () => env.startSession(await dpopKey()));
      assert.equal(err.code, 'invalid_client');
      await env.close();
    }
    const env = await setupPoppy();
    env.docs.set(JWKS_URI, { keys: [{ ...env.keys.jwk, d: 'secret' }] });
    const err = await rejects(async () => env.startSession(await dpopKey()));
    assert.equal(err.code, 'invalid_client');
    await env.close();
  });

  test('metadata em cache: uma busca para várias requests', async ({ assert }) => {
    const env = await setupPoppy();
    const dkey = await dpopKey();
    await env.startSession(dkey);
    await env.startSession(dkey);
    assert.equal(env.fetched.filter((u) => u === CLIENT_ID).length, 1);
    await env.close();
  });

  test('registro exigido e blocklist → invalid_client', async ({ assert }) => {
    let env = await setupPoppy({ clients: { requireRegistration: true, registered: [] } });
    let err = await rejects(async () => env.startSession(await dpopKey()));
    assert.equal(err.code, 'invalid_client');
    assert.match(err.description, /not registered/);
    await env.close();

    env = await setupPoppy({ clients: { requireRegistration: true, registered: [CLIENT_ID] } });
    await env.startSession(await dpopKey());
    await env.close();

    env = await setupPoppy({ clients: { blocked: async (id) => id === CLIENT_ID } });
    err = await rejects(async () => env.startSession(await dpopKey()));
    assert.match(err.description, /blocked/);
    await env.close();
  });

  test('private_key_jwt: ausente, aud errado, sub errado, jti repetido → invalid_client', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const dkey = await dpopKey();
    const assertion = await env.sessionAssertion();
    const base = { grant_type: JWT_BEARER_GRANT, assertion };

    let err = await rejects(async () =>
      env.poppy.token({ ...base, client_id: CLIENT_ID }, await dpopProof(dkey)),
    );
    assert.equal(err.code, 'invalid_client');

    err = await rejects(async () =>
      env.poppy.token(
        {
          ...base,
          client_id: CLIENT_ID,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: await env.clientAssertion({ aud: 'https://other.example/token' }),
        },
        await dpopProof(dkey),
      ),
    );
    assert.equal(err.code, 'invalid_client');

    err = await rejects(async () =>
      env.poppy.token(
        {
          ...base,
          client_id: CLIENT_ID,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: await env.clientAssertion({ sub: 'someone' }),
        },
        await dpopProof(dkey),
      ),
    );
    assert.equal(err.code, 'invalid_client');

    const jti = b64();
    const ca = await env.clientAssertion({ jti });
    const form = {
      client_id: CLIENT_ID,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: ca,
    };
    await env.poppy.token({ ...form, ...base }, await dpopProof(dkey));
    err = await rejects(async () =>
      env.poppy.token(
        { ...form, grant_type: JWT_BEARER_GRANT, assertion: await env.sessionAssertion() },
        await dpopProof(dkey),
      ),
    );
    assert.equal(err.code, 'invalid_client');
    assert.match(err.description, /jti/);

    // Assinatura com chave fora do jwks_uri.
    const other = await (await import('./poppy_helpers.js')).agentKeys('k1');
    err = await rejects(async () =>
      env.poppy.token(
        {
          ...base,
          client_id: CLIENT_ID,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: await (async () => {
            const { SignJWT } = await import('jose');
            const iat = Math.floor(Date.now() / 1000);
            return new SignJWT({
              iss: CLIENT_ID,
              sub: CLIENT_ID,
              aud: TOKEN_URL,
              iat,
              exp: iat + 60,
              jti: b64(),
            })
              .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
              .sign(other.sign);
          })(),
        },
        await dpopProof(dkey),
      ),
    );
    assert.equal(err.code, 'invalid_client');
    await env.close();
  });
});

test.group('poppy — Sessions (jwt-bearer)', () => {
  test('inicia deslogada e renova com session_id', async ({ assert }) => {
    const env = await setupPoppy();
    const dkey = await dpopKey();
    const res = await env.poppy.token(
      await env.form({ grant_type: JWT_BEARER_GRANT, assertion: await env.sessionAssertion() }),
      await dpopProof(dkey),
    );
    assert.equal(res.token_type, 'DPoP');
    assert.equal(res.scope, '');
    assert.isFalse(res.signed_in);
    assert.isAbove(res.expires_in, 0);
    assert.match(res.session_id, /^ses_/);
    assert.notProperty(res, 'refresh_token');

    const renewed = await env.poppy.token(
      await env.form({
        grant_type: JWT_BEARER_GRANT,
        assertion: await env.sessionAssertion(),
        session_id: res.session_id,
      }),
      await dpopProof(dkey),
    );
    assert.equal(renewed.session_id, res.session_id);
    assert.notEqual(renewed.access_token, res.access_token);
    await env.close();
  });

  test('erros: outro usuário/sessão, replay, aud em lista, vida longa, scope, typ de navegador', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const dkey = await dpopKey();
    const { session_id } = await env.startSession(dkey);
    const token = async (fields: Record<string, unknown>) =>
      rejects(async () =>
        env.poppy.token(
          await env.form({ grant_type: JWT_BEARER_GRANT, ...fields }),
          await dpopProof(dkey),
        ),
      );

    let err = await token({
      assertion: await env.sessionAssertion({ sub: 'other-user' }),
      session_id,
    });
    assert.equal(err.code, 'invalid_session');
    err = await token({ assertion: await env.sessionAssertion(), session_id: 'ses_unknown' });
    assert.equal(err.code, 'invalid_session');

    const jti = b64();
    await env.poppy.token(
      await env.form({
        grant_type: JWT_BEARER_GRANT,
        assertion: await env.sessionAssertion({ jti }),
      }),
      await dpopProof(dkey),
    );
    err = await token({ assertion: await env.sessionAssertion({ jti }) });
    assert.equal(err.code, 'invalid_grant');

    err = await token({
      assertion: await env.sessionAssertion({ aud: [TOKEN_URL, 'https://x.example'] }),
    });
    assert.equal(err.code, 'invalid_grant');
    err = await token({
      assertion: await env.sessionAssertion({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    });
    assert.equal(err.code, 'invalid_grant');
    err = await token({ assertion: await env.sessionAssertion({ jti: 'short' }) });
    assert.equal(err.code, 'invalid_grant');
    err = await token({ assertion: await env.sessionAssertion({ typ: 'poppy-browser+jwt' }) });
    assert.equal(err.code, 'invalid_grant');
    err = await token({ assertion: await env.sessionAssertion(), scope: 'poppy:read' });
    assert.equal(err.code, 'invalid_scope');
    err = await token({});
    assert.equal(err.code, 'invalid_grant');
    err = await rejects(async () =>
      env.poppy.token(await env.form({ grant_type: 'password' }), await dpopProof(dkey)),
    );
    assert.equal(err.code, 'unsupported_grant_type');
    await env.close();
  });

  test('rate_limited (429 + Retry-After) por client_id', async ({ assert }) => {
    const env = await setupPoppy({ rateLimit: { sessionsPerMinute: 2 } });
    const dkey = await dpopKey();
    await env.startSession(dkey);
    await env.startSession(dkey);
    const err = await rejects(async () => env.startSession(dkey));
    assert.equal(err.code, 'rate_limited');
    assert.equal(err.status, 429);
    assert.isOk(err.headers['Retry-After']);
    await env.close();
  });
});

test.group('poppy — DPoP no token endpoint', () => {
  test('sem prova, htu/htm errados, typ errado, replay → invalid_dpop_proof', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const dkey = await dpopKey();
    const go = async (proof: string | undefined) =>
      rejects(async () =>
        env.poppy.token(
          await env.form({ grant_type: JWT_BEARER_GRANT, assertion: await env.sessionAssertion() }),
          proof,
        ),
      );
    for (const proof of [
      undefined,
      await dpopProof(dkey, { htu: 'https://shop.example/other' }),
      await dpopProof(dkey, { htm: 'GET' }),
      await dpopProof(dkey, { typ: 'JWT' }),
      await dpopProof(dkey, { iat: Math.floor(Date.now() / 1000) - 600 }),
    ]) {
      const err = await go(proof);
      assert.equal(err.code, 'invalid_dpop_proof');
      assert.equal(err.status, 400);
    }
    const reused = await dpopProof(dkey);
    await env.poppy.token(
      await env.form({ grant_type: JWT_BEARER_GRANT, assertion: await env.sessionAssertion() }),
      reused,
    );
    assert.equal((await go(reused)).code, 'invalid_dpop_proof');
    // htu com query é comparado sem ela.
    await env.poppy.token(
      await env.form({ grant_type: JWT_BEARER_GRANT, assertion: await env.sessionAssertion() }),
      await dpopProof(dkey, { htu: `${TOKEN_URL}?x=1` }),
    );
    await env.close();
  });

  test('nonce exigido: use_dpop_nonce com DPoP-Nonce, depois aceita', async ({ assert }) => {
    const env = await setupPoppy({ dpop: { requireNonce: true } });
    const dkey = await dpopKey();
    const err = await rejects(async () => env.startSession(dkey));
    assert.equal(err.code, 'use_dpop_nonce');
    const nonce = err.headers['DPoP-Nonce'];
    assert.isOk(nonce);
    const res = await env.poppy.token(
      await env.form({ grant_type: JWT_BEARER_GRANT, assertion: await env.sessionAssertion() }),
      await dpopProof(dkey, { nonce }),
    );
    assert.isFalse(res.signed_in);
    const bad = await rejects(async () =>
      env.poppy.token(
        await env.form({ grant_type: JWT_BEARER_GRANT, assertion: await env.sessionAssertion() }),
        await dpopProof(dkey, { nonce: 'forged.nonce' }),
      ),
    );
    assert.equal(bad.code, 'use_dpop_nonce');
    await env.close();
  });
});

test.group('poppy — Direct Sign-In', () => {
  test('consentimento → code + state + iss → token com refresh_token e Session logada', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const dkey = await dpopKey();
    const { session_id } = await env.startSession(dkey);
    const { verifier, challenge } = pkce();
    const start = await env.poppy.startAuthorization(
      {
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: 'poppy:read poppy:write addresses',
        state: 'Xq81vR',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      },
      ACCOUNT_ID,
    );
    assert.equal(start.kind, 'consent');
    if (start.kind !== 'consent') return;
    assert.equal(start.request.agentName, 'Example Agent');
    assert.equal(start.request.logoUri, 'https://agent.example/logo.png');
    assert.lengthOf(start.request.scopes, 3);

    // O usuário aprova só parte.
    const decided = await env.poppy.decideAuthorization({
      requestId: start.request.id,
      accountId: ACCOUNT_ID,
      allow: true,
      scopes: ['poppy:read', 'addresses'],
    });
    const url = new URL(decided!.url);
    assert.equal(`${url.origin}${url.pathname}`, REDIRECT_URI);
    assert.equal(url.searchParams.get('state'), 'Xq81vR');
    assert.equal(url.searchParams.get('iss'), POPPY_ISSUER);
    const code = url.searchParams.get('code')!;

    const exchange = async (fields: Record<string, unknown>) =>
      env.poppy.token(
        await env.form({
          grant_type: 'authorization_code',
          code,
          redirect_uri: REDIRECT_URI,
          code_verifier: verifier,
          session_id,
          ...fields,
        }),
        await dpopProof(dkey),
      );
    assert.equal(
      (await rejects(() => exchange({ code_verifier: pkce().verifier }))).code,
      'invalid_grant',
    );
    assert.equal(
      (await rejects(() => exchange({ redirect_uri: 'https://agent.example/x' }))).code,
      'invalid_grant',
    );
    assert.equal(
      (await rejects(() => exchange({ session_id: undefined }))).code,
      'invalid_request',
    );

    const res = await exchange({});
    assert.isTrue(res.signed_in);
    assert.equal(res.scope, 'poppy:read addresses');
    assert.equal(res.session_id, session_id);
    assert.match(res.refresh_token!, /^poa_/);
    assert.equal(res.refresh_token_expires_in, 30 * 24 * 3600);

    // Código reusado: invalid_grant e o Account Token emitido morre.
    assert.equal((await rejects(() => exchange({}))).code, 'invalid_grant');
    const refresh = await rejects(async () =>
      env.poppy.token(
        await env.form({ grant_type: 'refresh_token', refresh_token: res.refresh_token }),
        await dpopProof(dkey),
      ),
    );
    assert.equal(refresh.code, 'invalid_grant');
    await env.close();
  });

  test('negar → access_denied + iss; erros de client/redirect não redirecionam', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const { challenge } = pkce();
    const params = {
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: 'poppy:read',
      state: 's',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    };
    const start = await env.poppy.startAuthorization(params, ACCOUNT_ID);
    if (start.kind !== 'consent') throw new Error('consent');
    const denied = await env.poppy.decideAuthorization({
      requestId: start.request.id,
      accountId: ACCOUNT_ID,
      allow: false,
      scopes: [],
    });
    const url = new URL(denied!.url);
    assert.equal(url.searchParams.get('error'), 'access_denied');
    assert.equal(url.searchParams.get('iss'), POPPY_ISSUER);
    // Decidido: não vale de novo; nem de outra conta.
    assert.isNull(
      await env.poppy.decideAuthorization({
        requestId: start.request.id,
        accountId: ACCOUNT_ID,
        allow: true,
        scopes: ['poppy:read'],
      }),
    );

    assert.equal(
      (
        await env.poppy.startAuthorization(
          { ...params, redirect_uri: 'https://agent.example/other' },
          ACCOUNT_ID,
        )
      ).kind,
      'error',
    );
    assert.equal(
      (
        await env.poppy.startAuthorization(
          { ...params, client_id: 'http://agent.example/agent.json' },
          ACCOUNT_ID,
        )
      ).kind,
      'error',
    );
    const noPkce = await env.poppy.startAuthorization(
      { ...params, code_challenge_method: 'plain' },
      ACCOUNT_ID,
    );
    assert.equal(noPkce.kind, 'redirect');
    if (noPkce.kind === 'redirect')
      assert.equal(new URL(noPkce.url).searchParams.get('error'), 'invalid_request');
    const badScope = await env.poppy.startAuthorization({ ...params, scope: 'admin' }, ACCOUNT_ID);
    if (badScope.kind === 'redirect')
      assert.equal(new URL(badScope.url).searchParams.get('error'), 'invalid_scope');
    else assert.fail('expected redirect');
    const noScope = await env.poppy.startAuthorization({ ...params, scope: undefined }, ACCOUNT_ID);
    assert.equal(noScope.kind, 'redirect');
    await env.close();
  });

  test('pedido de outra conta não pode ser decidido', async ({ assert }) => {
    const env = await setupPoppy();
    const start = await env.poppy.startAuthorization(
      {
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: 'poppy:read',
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      },
      ACCOUNT_ID,
    );
    if (start.kind !== 'consent') throw new Error('consent');
    assert.isNull(
      await env.poppy.decideAuthorization({
        requestId: start.request.id,
        accountId: OTHER_ACCOUNT_ID,
        allow: true,
        scopes: ['poppy:read'],
      }),
    );
    await env.close();
  });
});

test.group('poppy — Device Sign-In', () => {
  test('pending → slow_down → aprovado → tokens; consumido não volta', async ({ assert }) => {
    const env = await setupPoppy();
    const dkey = await dpopKey();
    const { session_id } = await env.startSession(dkey);
    const auth = (await env.poppy.deviceAuthorization(
      await env.form({ scope: 'poppy:read poppy:write' }, `${POPPY_ISSUER}/oauth/device`),
    )) as any;
    assert.equal(auth.verification_uri, `${POPPY_ISSUER}/device`);
    assert.include(auth.verification_uri_complete, `user_code=${auth.user_code}`);
    assert.equal(auth.interval, 5);

    const poll = async () =>
      env.poppy.token(
        await env.form({
          grant_type: DEVICE_CODE_GRANT,
          device_code: auth.device_code,
          session_id,
        }),
        await dpopProof(dkey),
      );
    assert.equal((await rejects(poll)).code, 'authorization_pending');
    assert.equal((await rejects(poll)).code, 'slow_down');

    const pending = await env.poppy.pendingDevice(auth.user_code.toLowerCase().replace('-', ''));
    assert.equal(pending!.agentName, 'Example Agent');
    const decided = await env.poppy.decideDevice({
      userCode: auth.user_code,
      accountId: ACCOUNT_ID,
      allow: true,
      scopes: ['poppy:read'],
    });
    assert.deepEqual(decided!.approved, ['poppy:read']);
    const res = await poll();
    assert.isTrue(res.signed_in);
    assert.equal(res.scope, 'poppy:read');
    assert.isOk(res.refresh_token);
    assert.equal((await rejects(poll)).code, 'invalid_grant');
    await env.close();
  });

  test('negado → access_denied; expirado → expired_token; scope inválido → invalid_scope', async ({
    assert,
  }) => {
    const env = await setupPoppy({ signIn: { device: { scopes: ['poppy:read'] } } });
    const dkey = await dpopKey();
    const { session_id } = await env.startSession(dkey);
    const err = await rejects(async () =>
      env.poppy.deviceAuthorization(
        await env.form({ scope: 'poppy:write' }, `${POPPY_ISSUER}/oauth/device`),
      ),
    );
    assert.equal(err.code, 'invalid_scope');

    const a = (await env.poppy.deviceAuthorization(
      await env.form({ scope: 'poppy:read' }, `${POPPY_ISSUER}/oauth/device`),
    )) as any;
    await env.poppy.decideDevice({
      userCode: a.user_code,
      accountId: ACCOUNT_ID,
      allow: false,
      scopes: [],
    });
    const denied = await rejects(async () =>
      env.poppy.token(
        await env.form({ grant_type: DEVICE_CODE_GRANT, device_code: a.device_code, session_id }),
        await dpopProof(dkey),
      ),
    );
    assert.equal(denied.code, 'access_denied');

    const b = (await env.poppy.deviceAuthorization(
      await env.form({ scope: 'poppy:read' }, `${POPPY_ISSUER}/oauth/device`),
    )) as any;
    env.setNow(Date.now() + 601_000);
    const expired = await rejects(async () =>
      env.poppy.token(
        await env.form({ grant_type: DEVICE_CODE_GRANT, device_code: b.device_code, session_id }),
        await dpopProof(dkey, { iat: Math.floor((Date.now() + 601_000) / 1000) }),
      ),
    );
    assert.equal(expired.code, 'expired_token');
    await env.close();
  });
});

test.group('poppy — Account Tokens, sign-out e scopes', () => {
  test('refresh: nova Session logada, narrowing, invalid_scope, outro client', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const dkey = await dpopKey();
    const { session_id } = await env.startSession(dkey);
    const signed = await directSignIn(env, dkey, session_id);

    const fresh = await env.poppy.token(
      await env.form({
        grant_type: 'refresh_token',
        refresh_token: signed.refresh_token,
        scope: 'poppy:read',
      }),
      await dpopProof(dkey),
    );
    assert.isTrue(fresh.signed_in);
    assert.notEqual(fresh.session_id, session_id);
    assert.equal(fresh.scope, 'poppy:read');
    assert.notProperty(fresh, 'refresh_token');

    const same = await env.poppy.token(
      await env.form({
        grant_type: 'refresh_token',
        refresh_token: signed.refresh_token,
        session_id,
      }),
      await dpopProof(dkey),
    );
    assert.equal(same.session_id, session_id);
    assert.equal(same.scope, 'poppy:read poppy:write');

    const wider = await rejects(async () =>
      env.poppy.token(
        await env.form({
          grant_type: 'refresh_token',
          refresh_token: signed.refresh_token,
          scope: 'addresses',
        }),
        await dpopProof(dkey),
      ),
    );
    assert.equal(wider.code, 'invalid_scope');

    // Outro agente com o Account Token copiado.
    const OTHER = 'https://agent.example/other.json';
    env.docs.set(OTHER, clientMetadata({ client_id: OTHER }));
    const stolen = await rejects(async () =>
      env.poppy.token(
        {
          client_id: OTHER,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: await env.clientAssertion({ iss: OTHER, sub: OTHER }),
          grant_type: 'refresh_token',
          refresh_token: signed.refresh_token,
        },
        await dpopProof(dkey),
      ),
    );
    assert.equal(stolen.code, 'invalid_grant');
    await env.close();
  });

  test('account_mismatch: Session presa a outra conta', async ({ assert }) => {
    const env = await setupPoppy({
      signIn: {
        mediated: {
          fields: [{ name: 'email', label: 'Email', secret: false }],
          verify: async ({ credentials }) => ({
            status: 'complete',
            accountId: credentials.email === 'john@example.com' ? OTHER_ACCOUNT_ID : ACCOUNT_ID,
          }),
        },
      },
    });
    const dkey = await dpopKey();
    const { session_id, access_token } = await env.startSession(dkey);
    await directSignIn(env, dkey, session_id);
    const verified = await env.poppy.verifyAccess(await apiRequest(dkey, access_token));
    assert.isTrue(verified.ok);
    if (!verified.ok) return;
    const err = await rejects(async () =>
      env.poppy.mediatedStart(
        verified.principal,
        verified.jkt,
        { scope: 'poppy:read', credentials: { email: 'john@example.com' } },
        {} as any,
      ),
    );
    assert.equal(err.code, 'account_mismatch');

    // Account Token da outra conta numa Session presa → account_mismatch.
    const other = await env.startSession(dkey);
    const v2 = await env.poppy.verifyAccess(await apiRequest(dkey, other.access_token));
    if (!v2.ok) throw new Error('verify');
    const johnSignIn = (await env.poppy.mediatedStart(
      v2.principal,
      v2.jkt,
      { scope: 'poppy:read', credentials: { email: 'john@example.com' } },
      {} as any,
    )) as any;
    const mismatch = await rejects(async () =>
      env.poppy.token(
        await env.form({
          grant_type: 'refresh_token',
          refresh_token: johnSignIn.refresh_token,
          session_id,
        }),
        await dpopProof(dkey),
      ),
    );
    assert.equal(mismatch.code, 'account_mismatch');
    await env.close();
  });

  test('revogação (RFC 7009): Sessions continuam deslogadas; refresh → invalid_grant', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const dkey = await dpopKey();
    const { session_id } = await env.startSession(dkey);
    const signed = await directSignIn(env, dkey, session_id);
    let check = await env.poppy.verifyAccess(await apiRequest(dkey, signed.access_token), {
      scopes: ['poppy:read'],
    });
    assert.isTrue(check.ok);

    await env.poppy.revoke(
      await env.form(
        { token: signed.refresh_token, token_type_hint: 'refresh_token' },
        `${POPPY_ISSUER}/oauth/revoke`,
      ),
    );
    check = await env.poppy.verifyAccess(await apiRequest(dkey, signed.access_token));
    assert.isTrue(check.ok);
    if (check.ok) {
      assert.isFalse(check.principal.signedIn);
      assert.deepEqual(check.principal.scopes, []);
      assert.isNull(check.principal.accountId);
    }
    const needs = await env.poppy.verifyAccess(await apiRequest(dkey, signed.access_token), {
      scopes: ['poppy:read'],
    });
    assert.isFalse(needs.ok);
    if (!needs.ok) assert.equal(needs.error, 'sign_in_required');

    const refresh = await rejects(async () =>
      env.poppy.token(
        await env.form({ grant_type: 'refresh_token', refresh_token: signed.refresh_token }),
        await dpopProof(dkey),
      ),
    );
    assert.equal(refresh.code, 'invalid_grant');
    // A Session renova deslogada com a asserção.
    const renewed = await env.poppy.token(
      await env.form({
        grant_type: JWT_BEARER_GRANT,
        assertion: await env.sessionAssertion(),
        session_id,
      }),
      await dpopProof(dkey),
    );
    assert.isFalse(renewed.signed_in);
    // Token desconhecido: 200 (sem erro).
    await env.poppy.revoke(await env.form({ token: 'nope' }, `${POPPY_ISSUER}/oauth/revoke`));
    const hint = await rejects(async () =>
      env.poppy.revoke(
        await env.form({ token: 'x', token_type_hint: 'weird' }, `${POPPY_ISSUER}/oauth/revoke`),
      ),
    );
    assert.equal(hint.code, 'unsupported_token_type');
    await env.close();
  });

  test('desconectar pela conta e "sair de tudo" revogam os Account Tokens', async ({ assert }) => {
    const env = await setupPoppy();
    const dkey = await dpopKey();
    const { session_id } = await env.startSession(dkey);
    const signed = await directSignIn(env, dkey, session_id);
    const grants = await env.poppy.listGrants(ACCOUNT_ID);
    assert.lengthOf(grants, 1);
    assert.equal(grants[0].clientId, CLIENT_ID);
    assert.isFalse(await env.runtime.revokeAgentGrant(OTHER_ACCOUNT_ID, grants[0].id));
    assert.isTrue(await env.runtime.revokeAgentGrant(ACCOUNT_ID, grants[0].id));
    assert.lengthOf(await env.poppy.listGrants(ACCOUNT_ID), 0);
    const state = await env.poppy.sessionState(session_id);
    assert.isFalse(state!.signedIn);

    const again = await directSignIn(env, dkey, session_id);
    assert.equal(await env.runtime.revokeAllAgentGrants(ACCOUNT_ID), 1);
    const r = await env.poppy.verifyAccess(await apiRequest(dkey, again.access_token));
    assert.isTrue(r.ok && !r.principal.signedIn);
    assert.isOk(signed);
    await env.close();
  });

  test('conta desativada corta a Session logada', async ({ assert }) => {
    const accounts: Record<string, { email: string }> = {
      [ACCOUNT_ID]: { email: 'jane@example.com' },
    };
    const env = await setupPoppy({}, { accounts });
    const dkey = await dpopKey();
    const { session_id } = await env.startSession(dkey);
    const signed = await directSignIn(env, dkey, session_id);
    delete accounts[ACCOUNT_ID];
    const r = await env.poppy.verifyAccess(await apiRequest(dkey, signed.access_token), {
      signedIn: true,
    });
    assert.isFalse(r.ok);
    if (!r.ok) assert.equal(r.error, 'sign_in_required');
    await env.close();
  });
});

test.group('poppy — resource server (DPoP)', () => {
  test('valida token + prova; erros invalid_token, ath, chave, htu, replay, insufficient_scope', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const dkey = await dpopKey();
    const { session_id } = await env.startSession(dkey);
    const signed = await directSignIn(env, dkey, session_id, 'poppy:read');

    const ok = await env.poppy.verifyAccess(await apiRequest(dkey, signed.access_token), {
      scopes: ['poppy:read'],
    });
    assert.isTrue(ok.ok);
    if (ok.ok) {
      assert.deepEqual(ok.principal, {
        userId: 'usr_Q7c1vK',
        accountId: ACCOUNT_ID,
        clientId: CLIENT_ID,
        scopes: ['poppy:read'],
        sessionId: session_id,
        signedIn: true,
        resource: null,
        tokenType: 'DPoP',
      });
    }

    const scope = await env.poppy.verifyAccess(await apiRequest(dkey, signed.access_token), {
      scopes: ['poppy:read', 'poppy:write'],
    });
    assert.isFalse(scope.ok);
    if (!scope.ok) {
      assert.equal(scope.status, 403);
      assert.equal(scope.error, 'insufficient_scope');
      assert.equal(scope.scope, 'poppy:read poppy:write');
      assert.match(
        scope.wwwAuthenticate,
        /^DPoP .*error="insufficient_scope".*scope="poppy:read poppy:write"/,
      );
    }

    const missing = await env.poppy.verifyAccess({ method: 'GET', url: ORDERS_API, headers: {} });
    assert.isFalse(missing.ok);
    if (!missing.ok) {
      assert.equal(missing.status, 401);
      assert.equal(missing.error, 'invalid_token');
    }
    const unknown = await env.poppy.verifyAccess(await apiRequest(dkey, 'pst_unknown'));
    assert.isTrue(!unknown.ok && unknown.error === 'invalid_token');

    // Bearer com token DPoP-bound.
    const asBearer = await env.poppy.verifyAccess(await apiRequest(null, signed.access_token));
    assert.isTrue(!asBearer.ok && asBearer.error === 'invalid_token');

    // ath de outro token.
    const req = await apiRequest(dkey, signed.access_token, {
      proof: await dpopProof(dkey, {
        htm: 'GET',
        htu: `${ORDERS_API}/ord_1`,
        accessToken: 'other',
      }),
    });
    const ath = await env.poppy.verifyAccess(req);
    assert.isTrue(!ath.ok && ath.error === 'invalid_dpop_proof');

    // Prova com outra chave.
    const other = await dpopKey();
    const wrongKey = await env.poppy.verifyAccess(await apiRequest(other, signed.access_token));
    assert.isTrue(!wrongKey.ok && wrongKey.error === 'invalid_dpop_proof');

    // htu/htm diferentes da request.
    const htu = await env.poppy.verifyAccess(
      await apiRequest(dkey, signed.access_token, {
        proof: await dpopProof(dkey, {
          htm: 'GET',
          htu: `${ORDERS_API}/ord_2`,
          accessToken: signed.access_token,
        }),
      }),
    );
    assert.isTrue(!htu.ok && htu.error === 'invalid_dpop_proof');
    const htm = await env.poppy.verifyAccess(
      await apiRequest(dkey, signed.access_token, {
        proof: await dpopProof(dkey, {
          htm: 'POST',
          htu: `${ORDERS_API}/ord_1`,
          accessToken: signed.access_token,
        }),
      }),
    );
    assert.isTrue(!htm.ok && htm.error === 'invalid_dpop_proof');

    // Replay da mesma prova.
    const once = await apiRequest(dkey, signed.access_token);
    assert.isTrue((await env.poppy.verifyAccess(once)).ok);
    const replay = await env.poppy.verifyAccess(once);
    assert.isTrue(!replay.ok && replay.error === 'invalid_dpop_proof');

    // Expirado.
    env.setNow(Date.now() + 3601_000);
    const expired = await env.poppy.verifyAccess(
      await apiRequest(dkey, signed.access_token, {
        proof: await dpopProof(dkey, {
          htm: 'GET',
          htu: `${ORDERS_API}/ord_1`,
          accessToken: signed.access_token,
          iat: Math.floor((Date.now() + 3601_000) / 1000),
        }),
      }),
    );
    assert.isTrue(!expired.ok && expired.error === 'invalid_token');
    await env.close();
  });

  test('nonce no resource server: use_dpop_nonce + DPoP-Nonce', async ({ assert }) => {
    const env = await setupPoppy({ dpop: { requireNonce: true } });
    const dkey = await dpopKey();
    const first = await rejects(async () => env.startSession(dkey));
    const nonce = first.headers['DPoP-Nonce'];
    const res = await env.poppy.token(
      await env.form({ grant_type: JWT_BEARER_GRANT, assertion: await env.sessionAssertion() }),
      await dpopProof(dkey, { nonce }),
    );
    const noNonce = await env.poppy.verifyAccess(await apiRequest(dkey, res.access_token));
    assert.isFalse(noNonce.ok);
    if (!noNonce.ok) {
      assert.equal(noNonce.error, 'use_dpop_nonce');
      assert.equal(noNonce.status, 401);
      assert.isOk(noNonce.headers['DPoP-Nonce']);
    }
    const withNonce = await env.poppy.verifyAccess(
      await apiRequest(dkey, res.access_token, {
        proof: await dpopProof(dkey, {
          htm: 'GET',
          htu: `${ORDERS_API}/ord_1`,
          accessToken: res.access_token,
          nonce,
        }),
      }),
    );
    assert.isTrue(withNonce.ok);
    await env.close();
  });

  test('resource (RFC 8707): token de um resource só vale nele', async ({ assert }) => {
    const RES = 'https://api.shop.example/payments';
    const env = await setupPoppy({
      apis: [
        {
          type: 'openapi',
          url: 'https://api.shop.example/payments/openapi.json',
          description: 'Pay',
          resource: RES,
        },
        { type: 'mcp', url: MCP_URL, description: 'MCP' },
      ],
    });
    const dkey = await dpopKey();
    const plain = await env.startSession(dkey);
    const bound = await env.poppy.token(
      await env.form({
        grant_type: JWT_BEARER_GRANT,
        assertion: await env.sessionAssertion(),
        session_id: plain.session_id,
        resource: RES,
      }),
      await dpopProof(dkey),
    );
    const at = (token: string, url: string) =>
      env.poppy.verifyAccess(apiRequest(dkey, token, { url }) as any);
    assert.isTrue(
      (
        await env.poppy.verifyAccess(
          await apiRequest(dkey, bound.access_token, { url: `${RES}/charges` }),
        )
      ).ok,
    );
    assert.isFalse(
      (
        await env.poppy.verifyAccess(
          await apiRequest(dkey, plain.access_token, { url: `${RES}/charges` }),
        )
      ).ok,
    );
    assert.isFalse(
      (
        await env.poppy.verifyAccess(
          await apiRequest(dkey, bound.access_token, { url: `${ORDERS_API}/x` }),
        )
      ).ok,
    );
    assert.isOk(at);
    const unknown = await rejects(async () =>
      env.poppy.token(
        await env.form({
          grant_type: JWT_BEARER_GRANT,
          assertion: await env.sessionAssertion(),
          resource: 'https://nope.example',
        }),
        await dpopProof(dkey),
      ),
    );
    assert.equal(unknown.code, 'invalid_target');
    await env.close();
  });
});

test.group('poppy — MCP (Bearer)', () => {
  test('sem DPoP só com resource MCP; Bearer só no MCP dele; Session logada vira AccessToken do oidc-provider', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const dkey = await dpopKey();
    const { session_id } = await env.startSession(dkey);
    const signed = await directSignIn(env, dkey, session_id, 'poppy:read');

    const noProof = await rejects(async () =>
      env.poppy.token(
        await env.form({
          grant_type: 'refresh_token',
          refresh_token: signed.refresh_token,
          session_id,
        }),
        undefined,
      ),
    );
    assert.equal(noProof.code, 'invalid_dpop_proof');

    const bearer = await env.poppy.token(
      await env.form({
        grant_type: 'refresh_token',
        refresh_token: signed.refresh_token,
        session_id,
        resource: MCP_URL,
      }),
      undefined,
    );
    assert.equal(bearer.token_type, 'Bearer');
    assert.isTrue(bearer.signed_in);

    // A integração MCP existente (`AccessToken.find`) aceita o token, com `aud` = MCP.
    const at = await (env.service.provider as any).AccessToken.find(bearer.access_token);
    assert.isOk(at);
    assert.equal(at.accountId, ACCOUNT_ID);
    assert.equal(at.clientId, CLIENT_ID);
    assert.equal(at.aud, MCP_URL);
    assert.equal(at.scope, 'poppy:read');
    assert.isOk(await (env.service.provider as any).Grant.find(at.grantId));

    const ok = await env.poppy.verifyAccess({
      method: 'POST',
      url: MCP_URL,
      headers: { authorization: `Bearer ${bearer.access_token}` },
    });
    assert.isTrue(ok.ok);
    if (ok.ok) assert.equal(ok.principal.tokenType, 'Bearer');
    const elsewhere = await env.poppy.verifyAccess({
      method: 'GET',
      url: `${ORDERS_API}/1`,
      headers: { authorization: `Bearer ${bearer.access_token}` },
    });
    assert.isTrue(!elsewhere.ok && elsewhere.error === 'invalid_token');
    if (!elsewhere.ok) assert.match(elsewhere.wwwAuthenticate, /^Bearer /);

    // DPoP token não serve no MCP.
    const dpopAtMcp = await env.poppy.verifyAccess(
      await apiRequest(dkey, signed.access_token, { method: 'POST', url: MCP_URL }),
    );
    assert.isFalse(dpopAtMcp.ok);

    // Sign-out derruba o AccessToken do oidc-provider.
    await env.poppy.revoke(
      await env.form({ token: signed.refresh_token }, `${POPPY_ISSUER}/oauth/revoke`),
    );
    assert.isUndefined(await (env.service.provider as any).AccessToken.find(bearer.access_token));
    assert.isUndefined(await (env.service.provider as any).Grant.find(at.grantId));
    await env.close();
  });

  test('Bearer de Session deslogada: só no store do Poppy', async ({ assert }) => {
    const env = await setupPoppy();
    const res = await env.poppy.token(
      await env.form({
        grant_type: JWT_BEARER_GRANT,
        assertion: await env.sessionAssertion(),
        resource: MCP_URL,
      }),
      undefined,
    );
    assert.equal(res.token_type, 'Bearer');
    assert.isFalse(res.signed_in);
    assert.isUndefined(await (env.service.provider as any).AccessToken.find(res.access_token));
    const ok = await env.poppy.verifyAccess({
      method: 'POST',
      url: `${MCP_URL}/`,
      headers: { authorization: `Bearer ${res.access_token}` },
    });
    assert.isTrue(ok.ok);
    await env.close();
  });

  test('MCP registrado no slot global de resources também vale', async ({ assert }) => {
    const slot = globalThis as Record<symbol, unknown>;
    const key = Symbol.for('@adonis-agora/oauth:resources');
    const before = slot[key];
    slot[key] = [{ url: 'https://shop.example/agent/mcp' }];
    try {
      const env = await setupPoppy({ apis: [] });
      const res = await env.poppy.token(
        await env.form({
          grant_type: JWT_BEARER_GRANT,
          assertion: await env.sessionAssertion(),
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

test.group('poppy — Mediated Sign-In', () => {
  async function mediatedEnv(extra: Record<string, unknown> = {}) {
    const sent: string[] = [];
    const env = await setupPoppy({
      signIn: {
        mediated: {
          fields: [
            { name: 'email', label: 'Email', secret: false },
            { name: 'password', label: 'Password', secret: true },
          ],
          scopes: ['poppy:read'],
          verify: async ({ credentials }) => {
            if (credentials.password !== 'right') return { status: 'failed' };
            if (credentials.email === 'otp@example.com') {
              sent.push('123456');
              return {
                status: 'code_required',
                accountId: ACCOUNT_ID,
                sentTo: 'Text to the phone number ending in 71',
                code: '123456',
              };
            }
            return { status: 'complete', accountId: ACCOUNT_ID };
          },
          ...extra,
        },
      },
    });
    const dkey = await dpopKey();
    const s = await env.startSession(dkey);
    const auth = async (url = `${POPPY_ISSUER}/sign-in`) => {
      const r = await env.poppy.verifyAccess(
        await apiRequest(dkey, s.access_token, { method: 'POST', url }),
      );
      if (!r.ok) throw new Error(r.error);
      return r;
    };
    return { env, dkey, s, auth, sent };
  }

  test('anunciado no poppy.json; complete devolve os tokens', async ({ assert }) => {
    const { env, auth } = await mediatedEnv();
    const doc = env.poppy.discoveryDocument('shop.example') as any;
    assert.equal(doc.auth.mediated.endpoint, `${POPPY_ISSUER}/sign-in`);
    assert.deepEqual(doc.auth.mediated.scopes, ['poppy:read']);
    assert.isTrue(doc.auth.mediated.fields[1].secret);

    const a = await auth();
    const res = (await env.poppy.mediatedStart(
      a.principal,
      a.jkt,
      { scope: 'poppy:read', credentials: { email: 'jane@example.com', password: 'right' } },
      {} as any,
    )) as any;
    assert.equal(res.status, 'complete');
    assert.isTrue(res.signed_in);
    assert.equal(res.token_type, 'DPoP');
    assert.isOk(res.refresh_token);
    assert.notProperty(res, 'credentials');

    const b = await auth();
    assert.deepEqual(
      await env.poppy.mediatedStart(
        b.principal,
        b.jkt,
        { scope: 'poppy:read', credentials: { email: 'x', password: 'wrong' } },
        {} as any,
      ),
      { status: 'failed' },
    );
    const c = await auth();
    const scopeErr = await rejects(() =>
      env.poppy.mediatedStart(
        c.principal,
        c.jkt,
        { scope: 'poppy:write', credentials: { email: 'x', password: 'right' } },
        {} as any,
      ),
    );
    assert.equal(scopeErr.code, 'invalid_scope');
    const d = await auth();
    const missing = await rejects(() =>
      env.poppy.mediatedStart(
        d.principal,
        d.jkt,
        { scope: 'poppy:read', credentials: { email: 'x' } },
        {} as any,
      ),
    );
    assert.equal(missing.code, 'invalid_request');
    await env.close();
  });

  test('code_required → código errado → certo → complete; só a Session que começou', async ({
    assert,
  }) => {
    const { env, auth, dkey } = await mediatedEnv();
    const a = await auth();
    const started = (await env.poppy.mediatedStart(
      a.principal,
      a.jkt,
      { scope: 'poppy:read', credentials: { email: 'otp@example.com', password: 'right' } },
      {} as any,
    )) as any;
    assert.equal(started.status, 'code_required');
    assert.match(started.sign_in_id, /^sgn_/);
    assert.equal(started.code.sent_to, 'Text to the phone number ending in 71');
    assert.isOk(Date.parse(started.expires_at));

    const url = `${POPPY_ISSUER}/sign-in/${started.sign_in_id}`;
    const wrong = (await env.poppy.mediatedCode(
      (
        await auth(url)
      ).principal,
      null,
      started.sign_in_id,
      { code: '000000' },
    )) as any;
    assert.equal(wrong.status, 'code_required');
    assert.equal(wrong.sign_in_id, started.sign_in_id);

    // Outra Session do mesmo agente não termina este sign-in.
    const other = await env.startSession(dkey);
    const ov = await env.poppy.verifyAccess(
      await apiRequest(dkey, other.access_token, { method: 'POST', url }),
    );
    if (!ov.ok) throw new Error('verify');
    assert.isNull(
      await env.poppy.mediatedCode(ov.principal, ov.jkt, started.sign_in_id, { code: '123456' }),
    );

    const c = await auth(url);
    const done = (await env.poppy.mediatedCode(c.principal, c.jkt, started.sign_in_id, {
      code: '123456',
    })) as any;
    assert.equal(done.status, 'complete');
    assert.isTrue(done.signed_in);
    // Não reaproveita.
    const again = (await env.poppy.mediatedCode(
      (
        await auth(url)
      ).principal,
      null,
      started.sign_in_id,
      { code: '123456' },
    )) as any;
    assert.equal(again.status, 'failed');
    await env.close();
  });

  test('limite de tentativas → failed; expirado → expired; verifyCode do app', async ({
    assert,
  }) => {
    const { env, auth } = await mediatedEnv({ maxCodeAttempts: 2 });
    const start = async () => {
      const a = await auth();
      return (await env.poppy.mediatedStart(
        a.principal,
        a.jkt,
        { scope: 'poppy:read', credentials: { email: 'otp@example.com', password: 'right' } },
        {} as any,
      )) as any;
    };
    const s1 = await start();
    const url = (id: string) => `${POPPY_ISSUER}/sign-in/${id}`;
    assert.equal(
      (
        (await env.poppy.mediatedCode(
          (
            await auth(url(s1.sign_in_id))
          ).principal,
          null,
          s1.sign_in_id,
          { code: '1' },
        )) as any
      ).status,
      'code_required',
    );
    assert.equal(
      (
        (await env.poppy.mediatedCode(
          (
            await auth(url(s1.sign_in_id))
          ).principal,
          null,
          s1.sign_in_id,
          { code: '2' },
        )) as any
      ).status,
      'failed',
    );
    assert.equal(
      (
        (await env.poppy.mediatedCode(
          (
            await auth(url(s1.sign_in_id))
          ).principal,
          null,
          s1.sign_in_id,
          { code: '123456' },
        )) as any
      ).status,
      'failed',
    );

    const s2 = await start();
    const principal = (await auth(url(s2.sign_in_id))).principal;
    env.setNow(Date.now() + 601_000);
    assert.deepEqual(
      await env.poppy.mediatedCode(principal, null, s2.sign_in_id, { code: '123456' }),
      { status: 'expired' },
    );
    await env.close();

    const viaApp = await mediatedEnv({
      verify: async () => ({
        status: 'code_required',
        accountId: ACCOUNT_ID,
        sentTo: 'email',
        state: { otp: 'abc' },
      }),
      verifyCode: async ({ code, state }: { code: string; state: any }) => code === state.otp,
    });
    const a = await viaApp.auth();
    const st = (await viaApp.env.poppy.mediatedStart(
      a.principal,
      a.jkt,
      { scope: 'poppy:read', credentials: { email: 'e', password: 'p' } },
      {} as any,
    )) as any;
    const c = await viaApp.auth(url(st.sign_in_id));
    const done = (await viaApp.env.poppy.mediatedCode(c.principal, c.jkt, st.sign_in_id, {
      code: 'abc',
    })) as any;
    assert.equal(done.status, 'complete');
    await viaApp.env.close();
  });

  test('rate limit de tentativas por (agente, usuário)', async ({ assert }) => {
    const { env, auth } = await mediatedEnv();
    await env.close();
    const limited = await setupPoppy({
      rateLimit: { mediatedPerHour: 1 },
      signIn: {
        mediated: {
          fields: [{ name: 'pin', label: 'PIN', secret: true }],
          verify: async () => ({ status: 'failed' }),
        },
      },
    });
    const dkey = await dpopKey();
    const s = await limited.startSession(dkey);
    const go = async () => {
      const r = await limited.poppy.verifyAccess(
        await apiRequest(dkey, s.access_token, { method: 'POST', url: `${POPPY_ISSUER}/sign-in` }),
      );
      if (!r.ok) throw new Error('verify');
      return limited.poppy.mediatedStart(
        r.principal,
        r.jkt,
        { scope: 'poppy:read', credentials: { pin: '1' } },
        {} as any,
      );
    };
    assert.deepEqual(await go(), { status: 'failed' });
    const err = await rejects(go);
    assert.equal(err.code, 'rate_limited');
    assert.isOk(auth);
    await limited.close();
  });
});

test.group('poppy — sessão de navegador', () => {
  test('asserção válida → Session; checagens de typ/aud/exp/return_to/replay/sessão', async ({
    assert,
  }) => {
    const env = await setupPoppy();
    const dkey = await dpopKey();
    const { session_id } = await env.startSession(dkey);
    const origin = 'https://shop.example';
    const good = await env.browserAssertion({
      session_id,
      return_to: 'https://shop.example/orders',
    });
    const res = await env.poppy.verifyBrowserAssertion(good, origin);
    assert.equal(res.sessionId, session_id);
    assert.equal(res.returnTo, 'https://shop.example/orders');
    assert.isNull(res.accountId);
    const replay = await rejects(() => env.poppy.verifyBrowserAssertion(good, origin));
    assert.equal(replay.code, 'invalid_request');

    const bad = async (
      claims: Record<string, unknown>,
      opts: Record<string, unknown> = {},
      o = origin,
    ) =>
      rejects(async () =>
        env.poppy.verifyBrowserAssertion(
          await env.browserAssertion(
            { session_id, return_to: 'https://shop.example/', ...claims },
            opts,
          ),
          o,
        ),
      );
    await bad({}, { typ: 'JWT' });
    await bad({ aud: 'https://shop.example/other' });
    await bad({ return_to: 'https://evil.example/' });
    await bad({ return_to: 'http://shop.example/' });
    await bad({ session_id: 'ses_nope' });
    await bad({ sub: 'other-user' });
    const iat = Math.floor(Date.now() / 1000);
    await bad({}, { iat, exp: iat + 120 });
    // Subdomínio é aceito no return_to.
    const sub = await env.poppy.verifyBrowserAssertion(
      await env.browserAssertion({ session_id, return_to: 'https://help.shop.example/x' }),
      origin,
    );
    assert.equal(sub.returnTo, 'https://help.shop.example/x');
    // Asserção de Session não serve aqui.
    await rejects(async () =>
      env.poppy.verifyBrowserAssertion(await env.sessionAssertion(), origin),
    );
    // Origem de outro host (o cookie nasceria nele).
    await bad({}, {}, 'https://evil.example');
    assert.isOk(await bad({}, {}, 'https://shop.example.co.uk'));
    await env.close();
  });

  test('Session logada → accountId e scopes', async ({ assert }) => {
    const env = await setupPoppy();
    const dkey = await dpopKey();
    const { session_id } = await env.startSession(dkey);
    await directSignIn(env, dkey, session_id, 'poppy:read');
    const res = await env.poppy.verifyBrowserAssertion(
      await env.browserAssertion({ session_id, return_to: 'https://shop.example/' }),
      'https://shop.example',
    );
    assert.equal(res.accountId, ACCOUNT_ID);
    assert.deepEqual(res.scopes, ['poppy:read']);
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
  test('app só-Poppy (sem audience), PACT desligado; validações', async ({ assert }) => {
    const { resolvePersonalAgentsConfig } = await import('../../src/agents/config.js');
    const org = { name: 'Shop', domain: 'www.Shop.example' };
    const only = resolvePersonalAgentsConfig({ poppy: { organization: org } })!;
    assert.isFalse(only.pact);
    assert.equal(only.poppy!.organization.domain, 'shop.example');
    assert.equal(only.poppy!.prefix, '/poppy');
    assert.isNull(only.poppy!.signIn.mediated);
    assert.deepEqual(only.poppy!.signIn.direct!.scopes, ['poppy:read', 'poppy:write']);

    // Os scopes da delegação PACT viram os custom_scopes por default.
    const both = resolvePersonalAgentsConfig({
      audience: 'aud',
      delegation: { interfaceUrl: 'https://shop.example/a2a', scopes: { 'orders:read': 'Orders' } },
      poppy: { organization: org },
    })!;
    assert.isTrue(both.pact);
    assert.deepEqual(both.poppy!.customScopes, { 'orders:read': 'Orders' });

    assert.throws(() => resolvePersonalAgentsConfig({} as any), /audience/);
    assert.throws(
      () =>
        resolvePersonalAgentsConfig({
          poppy: { organization: org, scopes: { 'poppy:admin': 'x' } },
        }),
      /reservados/,
    );
    assert.throws(
      () =>
        resolvePersonalAgentsConfig({
          poppy: { organization: { name: 'x', domain: 'https://x.example' } },
        }),
      /domínio/,
    );
    assert.throws(
      () =>
        resolvePersonalAgentsConfig({
          audience: 'a',
          protocol: 'poppy' as any,
          poppy: { organization: org },
        }),
      /personalAgents.poppy/,
    );
    assert.throws(
      () =>
        resolvePersonalAgentsConfig({
          audience: 'a',
          prefix: '/agents',
          poppy: { organization: org, prefix: '/agents/poppy' },
        }),
      /debaixo/,
    );
    assert.throws(
      () =>
        resolvePersonalAgentsConfig({
          poppy: { organization: org, signIn: { direct: { scopes: ['nope'] } } },
        }),
      /desconhecido/,
    );
  });
});
