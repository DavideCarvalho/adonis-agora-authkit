import { createServer, type Server } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AuthkitClientManager } from '../providers/authkit_client_provider.js';
import { defineConfig, type ResolvedClientConfig, resolvers } from '../src/define_config.js';

const PORT = 9813;
const ISSUER = `http://localhost:${PORT}`;

test.group('AuthkitClientManager', (group) => {
  let server: Server;
  let token: string;
  group.setup(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256', {
      extractable: true,
    });
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

  test('createAuthenticator resolve identity da session', async ({ assert }) => {
    const resolved = await configProvider.resolve<ResolvedClientConfig>(
      {} as any,
      defineConfig({
        issuer: ISSUER,
        clientId: 'app1',
        redirectUri: `${ISSUER}/cb`,
        resolver: resolvers.jwt({ tokenSource: 'session' }),
      }),
    );
    const manager = new AuthkitClientManager(resolved!);
    const ctx = {
      session: { get: () => ({ idToken: token, accessToken: 'x' }) },
    } as any;
    const auth = await manager.createAuthenticator(ctx);
    const identity = await auth.getIdentity();
    assert.equal(identity!.userId, 'u1');
    assert.isTrue(auth.hasGlobalRole('ADMIN'));
  });
});
