import { createServer, type Server } from 'node:http';
import { test } from '@japa/runner';
import {
  buildAuthorizeUrl,
  buildEndSessionUrl,
  exchangeCode,
  generatePkce,
} from '../src/oidc_login.js';

test.group('oidc login', () => {
  test('generatePkce produz verifier + challenge S256', async ({ assert }) => {
    const { verifier, challenge, method } = await generatePkce();
    assert.isString(verifier);
    assert.isString(challenge);
    assert.equal(method, 'S256');
    assert.notEqual(verifier, challenge);
  });

  test('buildAuthorizeUrl monta a URL com PKCE e state', async ({ assert }) => {
    const url = buildAuthorizeUrl({
      issuer: 'https://auth.test/oidc',
      clientId: 'app1',
      redirectUri: 'https://app/cb',
      scopes: ['openid', 'profile'],
      state: 'st',
      codeChallenge: 'cc',
    });
    const u = new URL(url);
    assert.equal(u.pathname, '/oidc/auth');
    assert.equal(u.searchParams.get('client_id'), 'app1');
    assert.equal(u.searchParams.get('code_challenge'), 'cc');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('state'), 'st');
    assert.include(u.searchParams.get('scope')!, 'openid');
  });

  test('buildEndSessionUrl monta /session/end com id_token_hint e post_logout_redirect_uri', async ({
    assert,
  }) => {
    const url = buildEndSessionUrl({
      issuer: 'https://auth.test/oidc',
      idToken: 'idt-123',
      postLogoutRedirectUri: 'https://app.test/?x=1',
      clientId: 'app1',
    });
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://auth.test/oidc/session/end');
    assert.equal(u.searchParams.get('id_token_hint'), 'idt-123');
    assert.equal(u.searchParams.get('post_logout_redirect_uri'), 'https://app.test/?x=1');
    assert.equal(u.searchParams.get('client_id'), 'app1');
    // O URL é corretamente codificado (a URI aninhada não vaza seus próprios params).
    assert.include(url, 'post_logout_redirect_uri=https%3A%2F%2Fapp.test%2F%3Fx%3D1');
  });

  test('buildEndSessionUrl omite params ausentes', async ({ assert }) => {
    const url = buildEndSessionUrl({ issuer: 'https://auth.test/oidc' });
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://auth.test/oidc/session/end');
    assert.isNull(u.searchParams.get('id_token_hint'));
    assert.isNull(u.searchParams.get('post_logout_redirect_uri'));
    assert.isNull(u.searchParams.get('client_id'));
  });

  test('exchangeCode troca code por tokens no /token', async ({ assert }) => {
    let received: any;
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received = Object.fromEntries(new URLSearchParams(body));
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            id_token: 'idt',
            access_token: 'at',
            refresh_token: 'rt',
            expires_in: 900,
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(9812, r));
    try {
      const tokenSet = await exchangeCode({
        issuer: 'http://localhost:9812',
        clientId: 'app1',
        clientSecret: 's',
        redirectUri: 'https://app/cb',
        code: 'thecode',
        codeVerifier: 'ver',
      });
      assert.equal(tokenSet.idToken, 'idt');
      assert.equal(tokenSet.accessToken, 'at');
      assert.equal(tokenSet.refreshToken, 'rt');
      assert.equal(received.grant_type, 'authorization_code');
      assert.equal(received.code, 'thecode');
      assert.equal(received.code_verifier, 'ver');
      assert.equal(received.client_id, 'app1');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
