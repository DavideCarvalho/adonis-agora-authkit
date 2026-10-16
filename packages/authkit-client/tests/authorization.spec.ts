import { test } from '@japa/runner';
import {
  completeAuthorization,
  createAuthorizationRequest,
  OidcCallbackError,
} from '../src/authorization.js';
import { conventionEndpoints } from '../src/discovery.js';
import { signIdToken, testKeys } from './helpers/id_tokens.js';

const BASE = {
  issuer: 'http://idp',
  clientId: 'app1',
  redirectUri: 'http://app/cb',
};

function tokenEndpoint(idToken?: string, status = 200) {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: new URLSearchParams(init.body) });
    return {
      ok: status < 300,
      status,
      json: async () => ({ access_token: 'at', id_token: idToken, expires_in: 60 }),
    } as Response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function start(extra: { maxAge?: number } = {}) {
  return createAuthorizationRequest({ ...BASE, scopes: ['openid'], ...extra });
}

async function finish(
  pending: any,
  callbackParams: Record<string, unknown>,
  idToken?: string,
  status?: number,
) {
  const endpoint = tokenEndpoint(idToken, status);
  const result = await completeAuthorization({
    ...BASE,
    endpoints: { ...conventionEndpoints(BASE.issuer), tokenEndpoint: 'http://idp/custom/token' },
    pending,
    callbackParams,
    idToken: { keys: testKeys },
    fetchImpl: endpoint.fetchImpl,
  });
  return { result, calls: endpoint.calls };
}

const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e) => (e instanceof OidcCallbackError ? e.code : e),
  );

test.group('createAuthorizationRequest', () => {
  test('fresh state, nonce and S256 PKCE on every call', async ({ assert }) => {
    const a = await start();
    const b = await start();
    const url = new URL(a.url);
    assert.equal(url.searchParams.get('state'), a.pending.state);
    assert.equal(url.searchParams.get('nonce'), a.pending.nonce);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.notEqual(a.pending.state, b.pending.state);
    assert.notEqual(a.pending.nonce, b.pending.nonce);
    assert.notEqual(a.pending.codeVerifier, b.pending.codeVerifier);
  });

  test('uses the discovered authorization endpoint and sends max_age', async ({ assert }) => {
    const { url, pending } = await createAuthorizationRequest({
      ...BASE,
      scopes: ['openid'],
      maxAge: 300,
      endpoints: { authorizationEndpoint: 'https://kc/realms/a/protocol/openid-connect/auth' },
    });
    assert.isTrue(url.startsWith('https://kc/realms/a/protocol/openid-connect/auth?'));
    assert.equal(new URL(url).searchParams.get('max_age'), '300');
    assert.equal(pending.maxAge, 300);
  });
});

test.group('completeAuthorization', () => {
  test('exchanges the code with the verifier and validates the id_token', async ({ assert }) => {
    const { pending } = await start();
    const idToken = await signIdToken({ nonce: pending.nonce });
    const { result, calls } = await finish(
      pending,
      { code: 'c1', state: pending.state, iss: 'http://idp' },
      idToken,
    );
    assert.equal(result.tokens.idToken, idToken);
    assert.equal(result.claims.sub, 'u1');
    assert.equal(calls[0].url, 'http://idp/custom/token');
    assert.equal(calls[0].body.get('code_verifier'), pending.codeVerifier);
  });

  test('stale or foreign callbacks are restartable', async ({ assert }) => {
    const { pending } = await start();
    assert.equal(await codeOf(finish(undefined, { code: 'c', state: 'x' })), 'missing_pending');
    assert.equal(await codeOf(finish(pending, { code: 'c', state: 'x' })), 'state_mismatch');
    assert.equal(await codeOf(finish(pending, { state: pending.state })), 'missing_code');
    const error = await finish(pending, { state: 'x' }).catch((e) => e);
    assert.isTrue(error.restartable);
  });

  test('RFC 9207: a callback iss from another issuer is rejected', async ({ assert }) => {
    const { pending } = await start();
    const code = await codeOf(
      finish(pending, { code: 'c', state: pending.state, iss: 'http://evil' }),
    );
    assert.equal(code, 'issuer_mismatch');
    const error = await finish(pending, {
      code: 'c',
      state: pending.state,
      iss: 'http://evil',
    }).catch((e) => e);
    assert.isFalse(error.restartable);
  });

  test('an IdP error carries error and description', async ({ assert }) => {
    const { pending } = await start();
    const error = await finish(pending, {
      state: pending.state,
      error: 'access_denied',
      error_description: 'User said no',
    }).catch((e) => e);
    assert.equal(error.code, 'idp_error');
    assert.deepEqual(error.idpError, { error: 'access_denied', description: 'User said no' });
    // The IdP turned the user away: back to login, like a stale callback.
    assert.isTrue(error.restartable);
  });

  test('token endpoint failure, missing or invalid id_token', async ({ assert }) => {
    const { pending } = await start();
    const cb = { code: 'c', state: pending.state };
    assert.equal(await codeOf(finish(pending, cb, undefined, 400)), 'token_exchange_failed');
    assert.equal(await codeOf(finish(pending, cb, undefined)), 'missing_id_token');
    const replayed = await signIdToken({ nonce: 'from-another-login' });
    assert.equal(await codeOf(finish(pending, cb, replayed)), 'invalid_id_token');
  });

  test('max_age from the request is enforced on auth_time', async ({ assert }) => {
    const { pending } = await start({ maxAge: 60 });
    const old = await signIdToken({
      nonce: pending.nonce,
      auth_time: Math.floor(Date.now() / 1000) - 3600,
    });
    const code = await codeOf(finish(pending, { code: 'c', state: pending.state }, old));
    assert.equal(code, 'invalid_id_token');
  });
});
