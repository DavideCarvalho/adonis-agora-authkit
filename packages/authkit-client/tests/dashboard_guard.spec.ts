import type { Identity } from '@adonis-agora/authkit-core';
import type { HttpContext } from '@adonisjs/core/http';
import { test } from '@japa/runner';
import { Authenticator } from '../src/authenticator.js';
import { authkitDashboardAuthorize, isAuthkitAdmin } from '../src/host/dashboard_guard.js';

const adminIdentity: Identity = {
  userId: 'u1',
  email: 'admin@example.com',
  globalRoles: ['ADMIN'],
  profile: { name: 'Admin' },
  issuedAt: 0,
  expiresAt: 0,
  raw: {},
};

const memberIdentity: Identity = {
  userId: 'u2',
  email: 'member@example.com',
  globalRoles: ['MEMBER'],
  profile: { name: 'Member' },
  issuedAt: 0,
  expiresAt: 0,
  raw: {},
};

/**
 * Dublê do `AuthkitClientManager` — mesmo padrão de `authkit_client_guard.spec.ts` — expondo só
 * o que `getAuthkit()` chama (`maybeRefresh` + `createAuthenticator`), montado sobre um
 * `SessionResolver` fake que devolve a `Identity` fixa (ou `null` p/ "sem sessão").
 */
function fakeManager(identity: Identity | null) {
  const calls = { maybeRefresh: 0, createAuthenticator: 0 };
  return {
    calls,
    async maybeRefresh() {
      calls.maybeRefresh++;
    },
    async createAuthenticator() {
      calls.createAuthenticator++;
      return new Authenticator({} as HttpContext, {
        resolver: { resolve: async () => identity },
      });
    },
  };
}

/** `ctx` mínimo: só o que `getAuthkit` (container) e o middleware (`response`) tocam. */
function fakeCtx(identity: Identity | null) {
  const manager = fakeManager(identity);
  const response = {
    calls: [] as Array<{ method: string; body: unknown }>,
    unauthorized(body?: unknown) {
      response.calls.push({ method: 'unauthorized', body });
    },
    forbidden(body?: unknown) {
      response.calls.push({ method: 'forbidden', body });
    },
  };
  const ctx = {
    containerResolver: { make: async () => manager },
    response,
  } as unknown as HttpContext;
  return { ctx, manager, response };
}

test.group('isAuthkitAdmin', () => {
  test('sessão com a global role ADMIN -> true', async ({ assert }) => {
    const { ctx } = fakeCtx(adminIdentity);
    assert.isTrue(await isAuthkitAdmin(ctx));
  });

  test('sessão autenticada sem a global role ADMIN -> false', async ({ assert }) => {
    const { ctx } = fakeCtx(memberIdentity);
    assert.isFalse(await isAuthkitAdmin(ctx));
  });

  test('sem sessão -> false (não lança)', async ({ assert }) => {
    const { ctx } = fakeCtx(null);
    assert.isFalse(await isAuthkitAdmin(ctx));
  });

  test('role customizada via options.role', async ({ assert }) => {
    const staffIdentity: Identity = { ...memberIdentity, globalRoles: ['STAFF'] };
    const { ctx } = fakeCtx(staffIdentity);
    assert.isFalse(await isAuthkitAdmin(ctx));
    assert.isTrue(await isAuthkitAdmin(ctx, { role: 'STAFF' }));
  });
});

test.group('authkitDashboardAuthorize', () => {
  test('admin -> true', async ({ assert }) => {
    const { ctx } = fakeCtx(adminIdentity);
    assert.isTrue(await authkitDashboardAuthorize()(ctx));
  });

  test('sessão sem a role -> false (403)', async ({ assert }) => {
    const { ctx } = fakeCtx(memberIdentity);
    assert.isFalse(await authkitDashboardAuthorize()(ctx));
  });

  test('sem sessão -> unauthenticated (401)', async ({ assert }) => {
    const { ctx } = fakeCtx(null);
    assert.deepEqual(await authkitDashboardAuthorize()(ctx), {
      allowed: false,
      reason: 'unauthenticated',
    });
  });

  test('sem sessão + loginPath -> redirectTo', async ({ assert }) => {
    const { ctx } = fakeCtx(null);
    assert.deepEqual(await authkitDashboardAuthorize({ loginPath: '/login' })(ctx), {
      redirectTo: '/login',
    });
  });

  test('loginPath não afeta quem está logado sem a role', async ({ assert }) => {
    const { ctx } = fakeCtx(memberIdentity);
    assert.isFalse(await authkitDashboardAuthorize({ loginPath: '/login' })(ctx));
  });

  test('role customizada via options.role', async ({ assert }) => {
    const staffIdentity: Identity = { ...memberIdentity, globalRoles: ['STAFF'] };
    const { ctx } = fakeCtx(staffIdentity);
    assert.isFalse(await authkitDashboardAuthorize()(ctx));
    assert.isTrue(await authkitDashboardAuthorize({ role: 'STAFF' })(ctx));
  });
});
