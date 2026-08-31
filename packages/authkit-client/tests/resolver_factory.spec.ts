import { createServer, type Server } from 'node:http';
import { test } from '@japa/runner';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { resolvers } from '../src/resolvers/factory.js';

const PORT = 9811;
const ISSUER = `http://localhost:${PORT}`;

test.group('resolvers.jwt factory', (group) => {
  let server: Server;
  let token: string;
  group.setup(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const pub = await exportJWK(publicKey);
    pub.kid = 'k1';
    pub.alg = 'RS256';
    pub.use = 'sig';
    server = createServer((req, res) => {
      if (req.url?.startsWith('/.well-known'))
        return res.end(JSON.stringify({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks` }));
      if (req.url === '/jwks') return res.end(JSON.stringify({ keys: [pub] }));
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => server.listen(PORT, r));
    token = await new SignJWT({ sub: 'u1', email: 'a@b.com', roles: ['ADMIN'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setAudience('app1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    return async () => new Promise<void>((r) => server.close(() => r()));
  });

  test('resolve identity a partir do idToken na session', async ({ assert }) => {
    const factory = resolvers.jwt({ tokenSource: 'session' });
    const resolver = await factory.resolver({
      issuer: ISSUER,
      clientId: 'app1',
      sessionKey: 'authkit',
      globalRolesClaim: 'roles',
    });
    const ctx = { session: { get: () => ({ idToken: token, accessToken: 'x' }) } } as any;
    const identity = await resolver.resolve(ctx);
    assert.equal(identity!.userId, 'u1');
    assert.deepEqual(identity!.globalRoles, ['ADMIN']);
  });
});
