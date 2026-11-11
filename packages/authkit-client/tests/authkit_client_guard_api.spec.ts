import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Identity } from '@adonis-agora/authkit-core';
import { Authenticator as FrameworkAuthenticator } from '@adonisjs/auth';
import type { HttpContext } from '@adonisjs/core/http';
import { test } from '@japa/runner';
import { AuthkitClientManager } from '../providers/authkit_client_provider.js';
import { type ResolvedClientConfig, resolvers } from '../src/define_config.js';
import { createDpopProof, dpopJwkThumbprint, generateDpopKeyPair } from '../src/dpop.js';
import { authkitClientGuard, authkitIdentityProvider } from '../src/host/authkit_client_guard.js';
import type { ResolverFactory } from '../src/resolvers/factory.js';
import { signIdToken, TEST_JWKS } from './helpers/id_tokens.js';

/**
 * The guard on API routes: the identity comes from the request's Authorization
 * header (bearer JWT, PAT) through a real resolver, with no OIDC session, and
 * `authkitIdentityProvider()` needs no user table.
 */
let server: Server;
let base = '';
const introspected: string[] = [];

function config(over: Partial<ResolvedClientConfig> = {}): ResolvedClientConfig {
  return {
    issuer: base,
    clientId: 'app1',
    redirectUri: `${base}/cb`,
    // The web resolver reads the OIDC session; API guards override it.
    resolverFactory: resolvers.jwt({ tokenSource: 'session', jwksUri: `${base}/jwks` }),
    sessionKey: 'authkit',
    scopes: ['openid'],
    globalRolesClaim: 'roles',
    discovery: false,
    ...over,
  };
}

const API_URL = 'https://api.acme.test/v1/courses';

function apiCtx(manager: AuthkitClientManager, authorization?: string, dpop?: string) {
  return {
    request: {
      header: (name: string) => {
        const key = name.toLowerCase();
        if (key === 'authorization') return authorization;
        if (key === 'dpop') return dpop;
        return undefined;
      },
      method: () => 'GET',
      completeUrl: () => API_URL,
    },
    session: { get: () => undefined },
    containerResolver: { make: async () => manager },
  } as unknown as HttpContext;
}

async function bootApiGuard(
  manager: AuthkitClientManager,
  resolver: ResolverFactory | undefined,
  authorization?: string,
  dpop?: string,
) {
  const ctx = apiCtx(manager, authorization, dpop);
  const factory = await authkitClientGuard({
    provider: authkitIdentityProvider(),
    resolver,
  }).resolver('api', {} as never);
  const auth = new FrameworkAuthenticator(ctx, { default: 'api', guards: { api: factory } });
  return { auth, ctx };
}

test.group('authkitClientGuard on API routes', (group) => {
  group.setup(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/jwks') return res.end(JSON.stringify(TEST_JWKS));
      if (req.url === '/pat/introspect') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          introspected.push(body);
          const active = body.includes('pat_good');
          res.end(
            JSON.stringify(
              active
                ? { active: true, sub: 'svc-1', email: 'svc@acme.test', roles: ['API'] }
                : { active: false },
            ),
          );
        });
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return () => new Promise<void>((r) => server.close(() => r()));
  });

  test('bearer JWT: resolvers.jwt({ tokenSource: "bearer" }) on the guard authenticates the request', async ({
    assert,
  }) => {
    const manager = new AuthkitClientManager(config());
    const token = await signIdToken({
      iss: base,
      sub: 'u-42',
      email: 'ana@acme.test',
      roles: ['ADMIN'],
    });
    const { auth, ctx } = await bootApiGuard(
      manager,
      resolvers.jwt({ tokenSource: 'bearer', jwksUri: `${base}/jwks` }),
      `Bearer ${token}`,
    );

    const user = (await auth.authenticate()) as Identity;
    assert.equal(user.userId, 'u-42');
    assert.equal(user.email, 'ana@acme.test');
    assert.deepEqual(user.globalRoles, ['ADMIN']);
    // The guard's authenticator also backs ctx.authkit when nothing set it yet.
    assert.isTrue(
      (ctx as unknown as { authkit: { hasGlobalRole(r: string): boolean } }).authkit.hasGlobalRole(
        'ADMIN',
      ),
    );
  });

  test('bearer JWT: no or invalid header → not authenticated', async ({ assert }) => {
    const manager = new AuthkitClientManager(config());
    const bearer = resolvers.jwt({ tokenSource: 'bearer', jwksUri: `${base}/jwks` });

    assert.isFalse(await (await bootApiGuard(manager, bearer)).auth.check());
    assert.isFalse(await (await bootApiGuard(manager, bearer, 'Bearer not-a-jwt')).auth.check());
  });

  test('without the resolver option the guard uses the configured (session) resolver', async ({
    assert,
  }) => {
    const manager = new AuthkitClientManager(config());
    const token = await signIdToken({ iss: base, sub: 'u-42' });
    const { auth } = await bootApiGuard(manager, undefined, `Bearer ${token}`);

    assert.isFalse(
      await auth.check(),
      'the session resolver does not read the Authorization header',
    );
  });

  test('DPoP: a sender-constrained JWT with a valid proof authenticates', async ({ assert }) => {
    const manager = new AuthkitClientManager(config());
    const bearer = resolvers.jwt({ tokenSource: 'bearer', jwksUri: `${base}/jwks` });
    const key = await generateDpopKeyPair();
    const token = await signIdToken({
      iss: base,
      sub: 'u-7',
      cnf: { jkt: await dpopJwkThumbprint(key) },
    });
    const proof = await createDpopProof({ key, htm: 'GET', htu: API_URL, accessToken: token });

    const { auth } = await bootApiGuard(manager, bearer, `DPoP ${token}`, proof);
    assert.equal(((await auth.authenticate()) as Identity).userId, 'u-7');

    // The same proof cannot be replayed.
    const replayed = await bootApiGuard(manager, bearer, `DPoP ${token}`, proof);
    assert.isFalse(await replayed.auth.check());
  });

  test('DPoP: missing, foreign-key or wrong-URL proofs, and DPoP tokens sent as Bearer, are refused', async ({
    assert,
  }) => {
    const manager = new AuthkitClientManager(config());
    const bearer = resolvers.jwt({ tokenSource: 'bearer', jwksUri: `${base}/jwks` });
    const key = await generateDpopKeyPair();
    const other = await generateDpopKeyPair();
    const token = await signIdToken({
      iss: base,
      sub: 'u-7',
      cnf: { jkt: await dpopJwkThumbprint(key) },
    });

    const check = async (authorization: string, dpop?: string) =>
      (await bootApiGuard(manager, bearer, authorization, dpop)).auth.check();

    assert.isFalse(await check(`DPoP ${token}`), 'no proof');
    assert.isFalse(
      await check(
        `DPoP ${token}`,
        await createDpopProof({ key: other, htm: 'GET', htu: API_URL, accessToken: token }),
      ),
      'proof signed by another key',
    );
    assert.isFalse(
      await check(
        `DPoP ${token}`,
        await createDpopProof({ key, htm: 'GET', htu: 'https://evil.test/x', accessToken: token }),
      ),
      'proof for another URL',
    );
    assert.isFalse(
      await check(`DPoP ${token}`, await createDpopProof({ key, htm: 'GET', htu: API_URL })),
      'proof without ath',
    );
    assert.isFalse(await check(`Bearer ${token}`), 'DPoP-bound token used as a bearer token');
  });

  test('PAT: resolvers.pat on the guard authenticates through introspection', async ({
    assert,
  }) => {
    const manager = new AuthkitClientManager(config());
    const pat = resolvers.pat({
      introspectionUrl: `${base}/pat/introspect`,
      introspectionSecret: 's3cret',
    });

    const ok = await bootApiGuard(manager, pat, 'Bearer pat_good');
    const user = (await ok.auth.authenticate()) as Identity;
    assert.equal(user.userId, 'svc-1');
    assert.deepEqual(user.globalRoles, ['API']);

    const revoked = await bootApiGuard(manager, pat, 'Bearer pat_revoked');
    assert.isFalse(await revoked.auth.check());
    assert.isAbove(introspected.length, 1);
  });
});

test.group('authkitIdentityProvider', () => {
  const identity: Identity = {
    userId: 'u1',
    email: 'ana@example.com',
    globalRoles: ['ADMIN'],
    profile: { name: 'Ana' },
    issuedAt: 0,
    expiresAt: 0,
    raw: {},
  };

  test('builds the guard user from the identity, with no lookup', async ({ assert }) => {
    const provider = authkitIdentityProvider();
    const user = await provider.fromIdentity(identity);
    assert.equal(user?.getId(), 'u1');
    assert.strictEqual(user?.getOriginal(), identity);
    assert.isNull(await provider.findById('u1'));
  });
});
