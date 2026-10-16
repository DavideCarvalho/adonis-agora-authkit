import { test } from '@japa/runner';
import { InvalidIdTokenError, validateIdToken } from '../src/id_token.js';
import { signIdToken, testKeys } from './helpers/id_tokens.js';

const opts = { issuer: 'http://idp', clientId: 'app1', keys: testKeys };

test.group('validateIdToken', () => {
  test('returns the claims of a valid token', async ({ assert }) => {
    const token = await signIdToken({ sub: 'u1', nonce: 'n1', sid: 's1' });
    const claims = await validateIdToken(token, { ...opts, nonce: 'n1' });
    assert.equal(claims.sub, 'u1');
    assert.equal(claims.sid, 's1');
  });

  test('rejects a wrong issuer, audience or an expired token', async ({ assert }) => {
    await assert.rejects(
      async () => validateIdToken(await signIdToken({ iss: 'http://other' }), opts),
      InvalidIdTokenError,
    );
    await assert.rejects(
      async () => validateIdToken(await signIdToken({ aud: 'someone-else' }), opts),
      InvalidIdTokenError,
    );
    await assert.rejects(
      async () => validateIdToken(await signIdToken({}, { expiresIn: '-1m' }), opts),
      InvalidIdTokenError,
    );
  });

  test('rejects a token signed by another key', async ({ assert }) => {
    const { generateKeyPair, SignJWT } = await import('jose');
    const { privateKey } = await generateKeyPair('RS256');
    const forged = await new SignJWT({ sub: 'u1' })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer('http://idp')
      .setAudience('app1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    await assert.rejects(() => validateIdToken(forged, opts), InvalidIdTokenError);
  });

  test('checks nonce when one was sent', async ({ assert }) => {
    const token = await signIdToken({ nonce: 'n1' });
    await assert.rejects(() => validateIdToken(token, { ...opts, nonce: 'n2' }), /nonce/);
    const noNonce = await signIdToken({});
    await assert.rejects(() => validateIdToken(noNonce, { ...opts, nonce: 'n1' }), /nonce/);
  });

  test('checks azp with several audiences', async ({ assert }) => {
    const noAzp = await signIdToken({ aud: ['app1', 'api'] });
    await assert.rejects(() => validateIdToken(noAzp, opts), /azp/);
    const wrongAzp = await signIdToken({ aud: ['app1', 'api'], azp: 'api' });
    await assert.rejects(() => validateIdToken(wrongAzp, opts), /azp/);
    const ok = await signIdToken({ aud: ['app1', 'api'], azp: 'app1' });
    assert.equal((await validateIdToken(ok, opts)).azp, 'app1');
  });

  test('checks sub against the expected subject (refresh)', async ({ assert }) => {
    const token = await signIdToken({ sub: 'u2' });
    await assert.rejects(() => validateIdToken(token, { ...opts, subject: 'u1' }), /sub/);
  });

  test('max_age requires a recent enough auth_time', async ({ assert }) => {
    const now = Math.floor(Date.now() / 1000);
    const missing = await signIdToken({});
    await assert.rejects(() => validateIdToken(missing, { ...opts, maxAge: 60 }), /auth_time/);
    const old = await signIdToken({ auth_time: now - 3600 });
    await assert.rejects(() => validateIdToken(old, { ...opts, maxAge: 60 }), /max_age/);
    const fresh = await signIdToken({ auth_time: now - 10 });
    assert.equal((await validateIdToken(fresh, { ...opts, maxAge: 60 })).auth_time, now - 10);
  });
});
