import { createServer, type Server } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AuthkitClientManager } from '../providers/authkit_client_provider.js';
import {
  BACKCHANNEL_LOGOUT_EVENT,
  InMemorySessionIndex,
  InvalidLogoutTokenError,
  validateLogoutToken,
} from '../src/backchannel_logout.js';
import { defineConfig, type ResolvedClientConfig, resolvers } from '../src/define_config.js';

const PORT = 9831;
const ISSUER = `http://localhost:${PORT}`;
const CLIENT_ID = 'app1';

/** Mock mínimo de HttpContext p/ exercitar handleBackchannelLogout sem servidor HTTP. */
function fakeCtx(body: Record<string, string>) {
  const headers: Record<string, string> = {};
  let status = 200;
  let payload: unknown;
  const response = {
    header(name: string, value: string) {
      headers[name] = value;
    },
    badRequest(data: unknown) {
      status = 400;
      payload = data;
      return data;
    },
  };
  const ctx = {
    request: { input: (key: string) => body[key] },
    response,
  } as any;
  return {
    ctx,
    get status() {
      return status;
    },
    get payload() {
      return payload;
    },
    headers,
  };
}

test.group('back-channel logout', (group) => {
  let server: Server;
  let privateKey: CryptoKey;
  let signLogoutToken: (claims: Record<string, any>, opts?: { aud?: string }) => Promise<string>;

  group.setup(async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    privateKey = keys.privateKey;
    const pub = await exportJWK(keys.publicKey);
    pub.kid = 'k1';
    pub.alg = 'RS256';
    pub.use = 'sig';

    server = createServer((req, res) => {
      if (req.url?.startsWith('/.well-known')) {
        return res.end(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` }));
      }
      if (req.url === '/jwks') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ keys: [pub] }));
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(PORT, r));

    signLogoutToken = (claims, opts) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience(opts?.aud ?? CLIENT_ID)
        .setIssuedAt()
        .sign(privateKey);

    return async () => new Promise<void>((r) => server.close(() => r()));
  });

  function validEvents() {
    return { [BACKCHANNEL_LOGOUT_EVENT]: {} };
  }

  function opts() {
    return { issuer: ISSUER, clientId: CLIENT_ID, jwksUri: `${ISSUER}/jwks` };
  }

  // ----- validateLogoutToken: happy path -----

  test('valida logout_token bem-formado (sid + sub)', async ({ assert }) => {
    const token = await signLogoutToken({ sub: 'u1', sid: 's1', events: validEvents() });
    const result = await validateLogoutToken(token, opts());
    assert.equal(result.sub, 'u1');
    assert.equal(result.sid, 's1');
  });

  test('aceita logout_token só com sub', async ({ assert }) => {
    const token = await signLogoutToken({ sub: 'u1', events: validEvents() });
    const result = await validateLogoutToken(token, opts());
    assert.equal(result.sub, 'u1');
    assert.isUndefined(result.sid);
  });

  // ----- validateLogoutToken: rejeições -----

  test('rejeita iss errado', async ({ assert }) => {
    const token = await new SignJWT({ sub: 'u1', events: validEvents() })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://evil')
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .sign(privateKey);
    await assert.rejects(() => validateLogoutToken(token, opts()), InvalidLogoutTokenError);
  });

  test('rejeita aud errado', async ({ assert }) => {
    const token = await signLogoutToken({ sub: 'u1', events: validEvents() }, { aud: 'other-app' });
    await assert.rejects(() => validateLogoutToken(token, opts()), InvalidLogoutTokenError);
  });

  test('rejeita quando falta a chave do evento em events', async ({ assert }) => {
    const token = await signLogoutToken({ sub: 'u1', events: { 'wrong/event': {} } });
    await assert.rejects(() => validateLogoutToken(token, opts()), InvalidLogoutTokenError);
  });

  test('rejeita quando events está ausente', async ({ assert }) => {
    const token = await signLogoutToken({ sub: 'u1' });
    await assert.rejects(() => validateLogoutToken(token, opts()), InvalidLogoutTokenError);
  });

  test('rejeita logout_token com claim nonce', async ({ assert }) => {
    const token = await signLogoutToken({ sub: 'u1', events: validEvents(), nonce: 'n1' });
    await assert.rejects(() => validateLogoutToken(token, opts()), InvalidLogoutTokenError);
  });

  test('rejeita quando faltam sid E sub', async ({ assert }) => {
    const token = await signLogoutToken({ events: validEvents() });
    await assert.rejects(() => validateLogoutToken(token, opts()), InvalidLogoutTokenError);
  });

  // ----- InMemorySessionIndex -----

  test('SessionIndex mapeia sid->sessionId e sub->sessões', ({ assert }) => {
    const idx = new InMemorySessionIndex();
    idx.register({ sid: 's1', sub: 'u1', sessionId: 'sess-1' });
    idx.register({ sid: 's2', sub: 'u1', sessionId: 'sess-2' });

    assert.deepEqual(idx.revokeBySid('s1'), ['sess-1']);
    // s1 já revogado: sub ainda tem sess-2
    assert.deepEqual(idx.revokeBySub('u1'), ['sess-2']);
    // tudo limpo
    assert.deepEqual(idx.revokeBySid('s2'), []);
    assert.deepEqual(idx.revokeBySub('u1'), []);
  });

  // ----- handler -----

  async function manager(extra: Partial<ResolvedClientConfig> = {}) {
    const resolved = await configProvider.resolve<ResolvedClientConfig>(
      {} as any,
      defineConfig({
        issuer: ISSUER,
        clientId: CLIENT_ID,
        redirectUri: `${ISSUER}/cb`,
        resolver: resolvers.jwt({ jwksUri: `${ISSUER}/jwks` }),
        ...extra,
      }),
    );
    return new AuthkitClientManager(resolved!);
  }

  test('handler retorna 200 e invoca onBackchannelLogout em token válido', async ({ assert }) => {
    const seen: Array<{ sid?: string; sub?: string }> = [];
    const idx = new InMemorySessionIndex();
    idx.register({ sid: 's1', sub: 'u1', sessionId: 'sess-1' });

    const mgr = await manager({
      onBackchannelLogout: (e) => {
        seen.push(e);
      },
      sessionIndex: idx,
    });

    const token = await signLogoutToken({ sub: 'u1', sid: 's1', events: validEvents() });
    const f = fakeCtx({ logout_token: token });
    await mgr.handleBackchannelLogout(f.ctx);

    assert.equal(f.status, 200);
    assert.equal(f.headers['Cache-Control'], 'no-store');
    assert.deepEqual(seen, [{ sid: 's1', sub: 'u1' }]);
    // a sessão indexada foi revogada
    assert.deepEqual(idx.revokeBySid('s1'), []);
  });

  test('handler retorna 400 invalid_request em token inválido', async ({ assert }) => {
    let called = false;
    const mgr = await manager({
      onBackchannelLogout: () => {
        called = true;
      },
    });

    // nonce proibido -> validação falha
    const token = await signLogoutToken({ sub: 'u1', events: validEvents(), nonce: 'n' });
    const f = fakeCtx({ logout_token: token });
    await mgr.handleBackchannelLogout(f.ctx);

    assert.equal(f.status, 400);
    assert.deepEqual(f.payload, { error: 'invalid_request' });
    assert.equal(f.headers['Cache-Control'], 'no-store');
    assert.isFalse(called);
  });

  test('handler retorna 400 quando logout_token ausente', async ({ assert }) => {
    const mgr = await manager();
    const f = fakeCtx({});
    await mgr.handleBackchannelLogout(f.ctx);
    assert.equal(f.status, 400);
    assert.deepEqual(f.payload, { error: 'invalid_request' });
  });
});
