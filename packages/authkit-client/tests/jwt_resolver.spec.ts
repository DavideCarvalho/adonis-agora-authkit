import { createServer, type Server } from 'node:http';
import { test } from '@japa/runner';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { JwtResolver } from '../src/resolvers/jwt_resolver.js';

const PORT = 9810;
const ISSUER = `http://localhost:${PORT}`;

test.group('JwtResolver', (group) => {
  let server: Server;
  let signToken: (claims: Record<string, any>) => Promise<string>;

  group.setup(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const pubJwk = await exportJWK(publicKey);
    pubJwk.kid = 'k1';
    pubJwk.alg = 'RS256';
    pubJwk.use = 'sig';
    server = createServer((req, res) => {
      if (req.url === '/.well-known/openid-configuration') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` }));
      }
      if (req.url === '/jwks') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ keys: [pubJwk] }));
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(PORT, r));
    signToken = (claims) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setAudience('app1')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
    return async () => new Promise<void>((r) => server.close(() => r()));
  });

  function makeResolver() {
    return new JwtResolver({
      issuer: ISSUER,
      jwksUri: `${ISSUER}/jwks`,
      audience: 'app1',
      globalRolesClaim: 'roles',
    });
  }

  test('valida um JWT e monta a Identity', async ({ assert }) => {
    const token = await signToken({ sub: 'u1', email: 'a@b.com', roles: ['ADMIN'], name: 'Ana' });
    const identity = await makeResolver().resolveToken(token);
    assert.equal(identity!.userId, 'u1');
    assert.equal(identity!.email, 'a@b.com');
    assert.deepEqual(identity!.globalRoles, ['ADMIN']);
    assert.equal(identity!.profile?.name, 'Ana');
    assert.isNumber(identity!.expiresAt);
  });

  test('rejeita token com assinatura/issuer inválidos', async ({ assert }) => {
    const bad = await new SignJWT({ sub: 'x' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://evil')
      .setAudience('app1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign((await generateKeyPair('RS256', { extractable: true })).privateKey);
    const identity = await makeResolver().resolveToken(bad);
    assert.isNull(identity);
  });

  test('globalRoles default [] quando claim ausente', async ({ assert }) => {
    const token = await signToken({ sub: 'u2', email: 'c@d.com' });
    const identity = await makeResolver().resolveToken(token);
    assert.deepEqual(identity!.globalRoles, []);
  });

  test('rejeita token sem sub (subject obrigatório)', async ({ assert }) => {
    const token = await signToken({ email: 'nosub@b.com' });
    const identity = await makeResolver().resolveToken(token);
    assert.isNull(identity);
  });
});
