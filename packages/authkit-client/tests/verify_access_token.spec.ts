import { createServer, type Server } from 'node:http';
import { test } from '@japa/runner';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { clearJwksCache, verifyJwtAccessToken } from '../src/verify_access_token.js';

const PORT = 9811;
const ISSUER = `http://localhost:${PORT}`;
const AUDIENCE = 'https://api.acme.test';

test.group('verifyJwtAccessToken (RFC 9068)', (group) => {
  let server: Server;
  let sign: (claims: Record<string, any>, typ?: string) => Promise<string>;

  group.setup(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const pubJwk = await exportJWK(publicKey);
    pubJwk.kid = 'k1';
    pubJwk.alg = 'RS256';
    pubJwk.use = 'sig';
    server = createServer((req, res) => {
      if (req.url === '/jwks') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ keys: [pubJwk] }));
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(PORT, r));
    sign = (claims, typ = 'at+jwt') =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
    return async () => new Promise<void>((r) => server.close(() => r()));
  });

  group.each.setup(() => {
    clearJwksCache();
  });

  const opts = () => ({ issuer: ISSUER, jwksUri: `${ISSUER}/jwks`, audience: AUDIENCE });

  test('valida um JWT AT typ=at+jwt e devolve as claims', async ({ assert }) => {
    const token = await sign({ sub: 'u1', client_id: 'app1', scope: 'openid read', jti: 'j1' });
    const claims = await verifyJwtAccessToken(token, opts());
    assert.equal(claims.sub, 'u1');
    assert.equal(claims.client_id, 'app1');
    assert.equal(claims.scope, 'openid read');
    assert.equal(claims.aud, AUDIENCE);
    assert.equal(claims.iss, ISSUER);
  });

  test('rejeita JWT que NÃO seja typ=at+jwt (perfil RFC 9068)', async ({ assert }) => {
    const token = await sign({ sub: 'u1' }, 'JWT'); // typ errado
    await assert.rejects(() => verifyJwtAccessToken(token, opts()));
  });

  test('allowAnyTyp aceita typ genérico', async ({ assert }) => {
    const token = await sign({ sub: 'u1' }, 'JWT');
    const claims = await verifyJwtAccessToken(token, { ...opts(), allowAnyTyp: true });
    assert.equal(claims.sub, 'u1');
  });

  test('rejeita audience errada', async ({ assert }) => {
    const token = await sign({ sub: 'u1' });
    await assert.rejects(() => verifyJwtAccessToken(token, { ...opts(), audience: 'other-api' }));
  });

  test('rejeita assinatura inválida (chave desconhecida)', async ({ assert }) => {
    const other = await generateKeyPair('RS256', { extractable: true });
    const token = await new SignJWT({ sub: 'evil' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'at+jwt' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(other.privateKey);
    await assert.rejects(() => verifyJwtAccessToken(token, opts()));
  });
});
