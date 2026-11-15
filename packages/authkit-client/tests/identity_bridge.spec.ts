import { test } from '@japa/runner';
import { authkitDashboardAuthorize } from '../src/host/dashboard_guard.js';
import { getAuthkit } from '../src/host/request_authenticator.js';
import {
  bindAuthkitIdentity,
  bridgeAuthkitToken,
  identityFromAccessToken,
} from '../src/identity_bridge.js';
import { buildIdentityFromClaims } from '../src/resolvers/identity.js';
import { type MemoryIssuer, startMemoryIssuer } from './helpers/memory_issuer.js';

const MCP = 'https://app.acme.test/mcp';

const userClaims = (overrides: Record<string, unknown> = {}) => ({
  aud: MCP,
  sub: 'user-1',
  client_id: 'claude',
  email: 'ana@acme.test',
  roles: ['ADMIN'],
  org_id: 'org-1',
  ...overrides,
});

test.group('Identity.actor from the act claim', () => {
  test('an impersonated token carries the real actor', ({ assert }) => {
    const identity = buildIdentityFromClaims(
      { sub: 'target', act: { sub: 'admin-1', email: 'admin@acme.test' } },
      'roles',
    );
    assert.equal(identity.userId, 'target');
    assert.deepEqual(identity.actor, { sub: 'admin-1', email: 'admin@acme.test' });
  });

  test('a normal token has no actor', ({ assert }) => {
    assert.notProperty(buildIdentityFromClaims({ sub: 'u' }, 'roles'), 'actor');
  });
});

test.group('bridging a remote authkit token into ctx.authkit', (group) => {
  let idp: MemoryIssuer;
  group.setup(async () => {
    idp = await startMemoryIssuer();
    return () => idp.close();
  });

  test('identityFromAccessToken verifies against the discovered JWKS', async ({ assert }) => {
    const token = await idp.sign(userClaims({ act: { sub: 'admin-9' } }));
    const identity = await identityFromAccessToken(token, { issuer: idp.issuer, audience: MCP });
    assert.equal(identity?.userId, 'user-1');
    assert.deepEqual(identity?.globalRoles, ['ADMIN']);
    assert.equal(identity?.orgId, 'org-1');
    assert.deepEqual(identity?.actor, { sub: 'admin-9' });

    const opts = { issuer: idp.issuer, audience: MCP };
    assert.isNull(await identityFromAccessToken(await idp.sign(userClaims({ aud: 'x' })), opts));
    assert.isNull(
      await identityFromAccessToken(await idp.sign(userClaims(), { key: 'foreign' }), opts),
    );
    // No exp, no identity.
    assert.isNull(
      await identityFromAccessToken(await idp.sign(userClaims({ exp: undefined })), opts),
    );
    // A client_credentials token is not a user.
    assert.isNull(
      await identityFromAccessToken(await idp.sign(userClaims({ sub: 'claude' })), opts),
    );
  });

  test('a console gated by authkitDashboardAuthorize admits the bridged caller', async ({
    assert,
  }) => {
    const authorize = authkitDashboardAuthorize();
    const ctx = { containerResolver: { make: async () => undefined } } as any;
    const token = await idp.sign(userClaims());
    const identity = await bridgeAuthkitToken(ctx, token, { issuer: idp.issuer, audience: MCP });
    assert.equal(identity?.userId, 'user-1');
    assert.equal((await getAuthkit(ctx).then((a) => a.getIdentity()))?.userId, 'user-1');
    const decision = await authorize(ctx);
    assert.isTrue(typeof decision === 'boolean' ? decision : (decision as any).allowed);
  });

  test('uses the app authkit client when there is one, and signs in the guard', async ({
    assert,
  }) => {
    const identity = buildIdentityFromClaims(userClaims(), 'roles');
    let built = 0;
    const manager = {
      createAuthenticator: async (_ctx: unknown, options: any) => {
        built += 1;
        const resolver = await options.resolver.resolver({});
        return { getIdentity: () => resolver.resolve(), marker: 'from-manager' };
      },
    };
    let checked = false;
    const guard = {
      driverName: 'authkit_client',
      isAuthenticated: false,
      authenticationAttempted: true,
    };
    const ctx = {
      containerResolver: {
        make: async (key: string) => (key === 'authkit.client' ? manager : undefined),
      },
      auth: {
        use: () => guard,
        check: async () => {
          checked = true;
          return true;
        },
      },
    } as any;
    await bindAuthkitIdentity(ctx, identity);
    assert.equal(built, 1);
    assert.equal(ctx.authkit.marker, 'from-manager');
    assert.equal((await ctx.authkit.getIdentity()).userId, 'user-1');
    assert.isTrue(checked);
    assert.isFalse(guard.authenticationAttempted);
  });
});
