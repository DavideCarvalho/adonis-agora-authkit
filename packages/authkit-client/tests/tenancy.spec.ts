import type { Identity } from '@adonis-agora/authkit-core';
import type { HttpContext } from '@adonisjs/core/http';
import { test } from '@japa/runner';
import { AuthkitClientManager } from '../providers/authkit_client_provider.js';
import { Authenticator } from '../src/authenticator.js';
import AuthkitContextMiddleware from '../src/middleware/authkit_context_middleware.js';
import {
  contextTenancyEnabled,
  populateContext,
  tenantFor,
} from '../src/observability/context_bridge.js';
import { resolvers } from '../src/resolvers/factory.js';

const SET_SLOT = Symbol.for('@agora/context:set');
const ACCESSOR_SLOT = Symbol.for('@agora/context:accessor');
const slots = globalThis as Record<symbol, unknown>;

type Patch = Record<string, unknown>;

/** Installs a fake context (`:set` + `:accessor`) and returns the patches and a restorer. */
function installContext(
  options: { tenancy?: { enabled: boolean } | 'absent'; store?: Patch } = {},
) {
  const prevSet = slots[SET_SLOT];
  const prevAccessor = slots[ACCESSOR_SLOT];
  const patches: Patch[] = [];
  const store: Patch = { ...(options.store ?? {}) };
  slots[SET_SLOT] = (patch: Patch) => {
    patches.push(patch);
    Object.assign(store, patch);
  };
  slots[ACCESSOR_SLOT] = {
    get: (key?: string) => (key === undefined ? store : store[key]),
    ...(options.tenancy === 'absent'
      ? {}
      : { tenancy: () => options.tenancy ?? { enabled: true } }),
  };
  return {
    patches,
    restore() {
      slots[SET_SLOT] = prevSet;
      slots[ACCESSOR_SLOT] = prevAccessor;
    },
  };
}

const orgIdentity: Identity = {
  userId: 'u1',
  email: 'a@b.com',
  globalRoles: [],
  orgId: 'org-1',
  orgSlug: 'acme',
  orgRole: 'owner',
  issuedAt: 0,
  expiresAt: 0,
  raw: {},
};
const orglessIdentity: Identity = { ...orgIdentity, orgId: null, orgSlug: null, orgRole: null };

test.group('tenancy / populateContext', () => {
  test('publishes the active organization with kind, slug and role, and keeps tenantId', ({
    assert,
  }) => {
    const ctx = installContext();
    try {
      populateContext(orgIdentity);
    } finally {
      ctx.restore();
    }
    assert.equal(ctx.patches[0].tenantId, 'org-1');
    assert.deepEqual(ctx.patches[0].tenant, {
      id: 'org-1',
      kind: 'organization',
      source: 'authkit',
      slug: 'acme',
      role: 'owner',
    });
  });

  test('reads slug and role from raw claims when the identity lacks them', ({ assert }) => {
    const ctx = installContext();
    try {
      populateContext({
        ...orglessIdentity,
        raw: { org_id: 'org-9', org_slug: 'nine', org_role: 'member' },
      });
    } finally {
      ctx.restore();
    }
    assert.deepEqual(ctx.patches[0].tenant, {
      id: 'org-9',
      kind: 'organization',
      source: 'authkit',
      slug: 'nine',
      role: 'member',
    });
  });

  test('no active org and personal off: no tenant', ({ assert }) => {
    const ctx = installContext();
    try {
      populateContext(orglessIdentity);
    } finally {
      ctx.restore();
    }
    assert.notProperty(ctx.patches[0], 'tenant');
    assert.notProperty(ctx.patches[0], 'tenantId');
  });

  test('personal: no active org publishes the user as the tenant', ({ assert }) => {
    const ctx = installContext();
    try {
      populateContext(orglessIdentity, { personal: true });
    } finally {
      ctx.restore();
    }
    assert.equal(ctx.patches[0].tenantId, 'u1');
    assert.deepEqual(ctx.patches[0].tenant, { id: 'u1', kind: 'user', source: 'authkit' });
  });

  test('personal: an active org still wins', ({ assert }) => {
    assert.equal(tenantFor(orgIdentity, { personal: true })?.kind, 'organization');
  });

  test('resolve: a chain publishes the active (last) level and the whole chain', ({ assert }) => {
    const ctx = installContext();
    try {
      populateContext(orglessIdentity, {
        resolve: () => [
          { id: 'clinic-1', kind: 'clinic', slug: 'downtown' },
          { id: 'unit-7', kind: 'unit', role: 'doctor' },
        ],
      });
    } finally {
      ctx.restore();
    }
    assert.deepEqual(ctx.patches[0].tenant, {
      id: 'unit-7',
      kind: 'unit',
      role: 'doctor',
      source: 'authkit',
      chain: [
        { id: 'clinic-1', kind: 'clinic', slug: 'downtown' },
        { id: 'unit-7', kind: 'unit', role: 'doctor' },
      ],
    });
    assert.equal(ctx.patches[0].tenantId, 'unit-7');
  });

  test('resolve: undefined keeps the default, null means no tenant', ({ assert }) => {
    assert.equal(tenantFor(orgIdentity, { resolve: () => undefined })?.id, 'org-1');
    assert.isNull(tenantFor(orgIdentity, { resolve: () => null }));
  });

  test('resolve: a throwing hook publishes no tenant but still the user', ({ assert }) => {
    const ctx = installContext();
    try {
      populateContext(orgIdentity, {
        resolve: () => {
          throw new Error('boom');
        },
      });
    } finally {
      ctx.restore();
    }
    assert.deepEqual(ctx.patches[0].userRef, { type: 'user', id: 'u1' });
    assert.notProperty(ctx.patches[0], 'tenant');
  });

  test('never overwrites a tenant the app set itself', ({ assert }) => {
    const ctx = installContext({
      store: { tenant: { id: 'clinic-1', kind: 'clinic', source: 'app' }, tenantId: 'clinic-1' },
    });
    try {
      populateContext(orgIdentity);
    } finally {
      ctx.restore();
    }
    assert.notProperty(ctx.patches[0], 'tenant');
    assert.notProperty(ctx.patches[0], 'tenantId');
    assert.deepEqual(ctx.patches[0].userRef, { type: 'user', id: 'u1' });
  });

  test('no context installed: no-op', ({ assert }) => {
    const prevSet = slots[SET_SLOT];
    const prevAccessor = slots[ACCESSOR_SLOT];
    delete slots[SET_SLOT];
    delete slots[ACCESSOR_SLOT];
    try {
      assert.doesNotThrow(() => populateContext(orgIdentity, { personal: true }));
      assert.isFalse(contextTenancyEnabled());
    } finally {
      slots[SET_SLOT] = prevSet;
      slots[ACCESSOR_SLOT] = prevAccessor;
    }
  });

  test('an old context (accessor without tenancy()) reports tenancy off', ({ assert }) => {
    const ctx = installContext({ tenancy: 'absent' });
    try {
      assert.isFalse(contextTenancyEnabled());
    } finally {
      ctx.restore();
    }
  });
});

function manager(options: { resolver: ReturnType<typeof resolvers.jwt>; tenancy?: object }) {
  return new AuthkitClientManager({
    issuer: 'https://idp.test',
    clientId: 'c',
    redirectUri: 'https://app.test/cb',
    resolverFactory: options.resolver,
    sessionKey: 'authkit',
    scopes: [],
    globalRolesClaim: 'roles',
    discovery: false,
    tenancy: options.tenancy ?? {},
  });
}

test.group('tenancy / eager', () => {
  test('defaults on with context tenancy enabled and the jwt resolver', ({ assert }) => {
    const ctx = installContext({ tenancy: { enabled: true } });
    try {
      assert.isTrue(manager({ resolver: resolvers.jwt() }).eagerTenancy());
    } finally {
      ctx.restore();
    }
  });

  test('defaults off with tenancy disabled, an old context, or a non-jwt resolver', ({
    assert,
  }) => {
    let ctx = installContext({ tenancy: { enabled: false } });
    try {
      assert.isFalse(manager({ resolver: resolvers.jwt() }).eagerTenancy());
    } finally {
      ctx.restore();
    }
    ctx = installContext({ tenancy: 'absent' });
    try {
      assert.isFalse(manager({ resolver: resolvers.jwt() }).eagerTenancy());
    } finally {
      ctx.restore();
    }
    ctx = installContext({ tenancy: { enabled: true } });
    try {
      assert.isFalse(manager({ resolver: resolvers.opaque() }).eagerTenancy());
    } finally {
      ctx.restore();
    }
  });

  test('an explicit eager wins', ({ assert }) => {
    const ctx = installContext({ tenancy: { enabled: true } });
    try {
      assert.isFalse(
        manager({ resolver: resolvers.jwt(), tenancy: { eager: false } }).eagerTenancy(),
      );
      assert.isTrue(
        manager({ resolver: resolvers.opaque(), tenancy: { eager: true } }).eagerTenancy(),
      );
    } finally {
      ctx.restore();
    }
  });

  function middlewareCtx(eager: boolean) {
    let resolves = 0;
    const fake = {
      eagerTenancy: () => eager,
      async maybeRefresh() {},
      async createAuthenticator(ctx: HttpContext) {
        return new Authenticator(ctx, {
          resolver: {
            resolve: async () => {
              resolves++;
              return orgIdentity;
            },
          },
        });
      },
    };
    const ctx = { containerResolver: { make: async () => fake } } as unknown as HttpContext;
    return { ctx, resolves: () => resolves };
  }

  test('eager: the middleware publishes the tenant before the handler runs', async ({ assert }) => {
    const context = installContext();
    const { ctx, resolves } = middlewareCtx(true);
    let seen: unknown;
    try {
      await new AuthkitContextMiddleware().handle(ctx, async () => {
        seen = context.patches[0]?.tenantId;
      });
    } finally {
      context.restore();
    }
    assert.equal(seen, 'org-1');
    assert.equal(resolves(), 1);
  });

  test('lazy: the middleware resolves nothing until asked', async ({ assert }) => {
    const context = installContext();
    const { ctx, resolves } = middlewareCtx(false);
    try {
      await new AuthkitContextMiddleware().handle(ctx, async () => {});
    } finally {
      context.restore();
    }
    assert.equal(resolves(), 0);
    assert.lengthOf(context.patches, 0);
  });

  test('createAuthenticator passes tenancy.personal through to the bridge', async ({ assert }) => {
    const context = installContext();
    const m = manager({ resolver: resolvers.jwt(), tenancy: { personal: true } });
    // Swap the resolver for a fake one through the per-call option.
    const auth = await m.createAuthenticator({} as HttpContext, {
      resolver: { resolver: async () => ({ resolve: async () => orglessIdentity }) },
    });
    try {
      await auth.getIdentity();
    } finally {
      context.restore();
    }
    assert.deepEqual(context.patches[0].tenant, { id: 'u1', kind: 'user', source: 'authkit' });
  });
});
