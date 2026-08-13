import type { Identity } from '@adonis-agora/authkit-core';
import type { HttpContext } from '@adonisjs/core/http';
import { test } from '@japa/runner';
import { Authenticator } from '../src/authenticator.js';
import {
  authkitDashboardAuthorize,
  authkitDashboardMiddleware,
  isAuthkitAdmin,
} from '../src/host/dashboard_guard.js';

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
  test('admin -> authorize(ctx) resolve true', async ({ assert }) => {
    const { ctx } = fakeCtx(adminIdentity);
    const authorize = authkitDashboardAuthorize();
    assert.isTrue(await authorize(ctx));
  });

  test('não-admin -> authorize(ctx) resolve false (o provider responde 403 sozinho)', async ({
    assert,
  }) => {
    const { ctx } = fakeCtx(memberIdentity);
    const authorize = authkitDashboardAuthorize();
    assert.isFalse(await authorize(ctx));
  });

  test('sem sessão -> authorize(ctx) resolve false', async ({ assert }) => {
    const { ctx } = fakeCtx(null);
    const authorize = authkitDashboardAuthorize();
    assert.isFalse(await authorize(ctx));
  });
});

test.group('authkitDashboardMiddleware', () => {
  test('admin -> chama next() e não toca em ctx.response', async ({ assert }) => {
    const { ctx, response } = fakeCtx(adminIdentity);
    const middleware = authkitDashboardMiddleware();
    let nextCalled = false;

    await middleware(ctx, async () => {
      nextCalled = true;
    });

    assert.isTrue(nextCalled);
    assert.lengthOf(response.calls, 0);
  });

  test('sessão sem a role -> 403 forbidden, next() NÃO chamado', async ({ assert }) => {
    const { ctx, response } = fakeCtx(memberIdentity);
    const middleware = authkitDashboardMiddleware();
    let nextCalled = false;

    await middleware(ctx, async () => {
      nextCalled = true;
    });

    assert.isFalse(nextCalled);
    assert.lengthOf(response.calls, 1);
    assert.equal(response.calls[0]?.method, 'forbidden');
  });

  test('sem sessão -> 401 unauthorized, next() NÃO chamado', async ({ assert }) => {
    const { ctx, response } = fakeCtx(null);
    const middleware = authkitDashboardMiddleware();
    let nextCalled = false;

    await middleware(ctx, async () => {
      nextCalled = true;
    });

    assert.isFalse(nextCalled);
    assert.lengthOf(response.calls, 1);
    assert.equal(response.calls[0]?.method, 'unauthorized');
  });

  test('role customizada via options.role', async ({ assert }) => {
    const staffIdentity: Identity = { ...memberIdentity, globalRoles: ['STAFF'] };
    const { ctx, response } = fakeCtx(staffIdentity);
    const middleware = authkitDashboardMiddleware({ role: 'STAFF' });
    let nextCalled = false;

    await middleware(ctx, async () => {
      nextCalled = true;
    });

    assert.isTrue(nextCalled);
    assert.lengthOf(response.calls, 0);
  });
});
