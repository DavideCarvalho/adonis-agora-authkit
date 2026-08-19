import type { Authenticator } from '@adonis-agora/authkit-client';
import { test } from '@japa/runner';
import { createTestIdentity, fakeAccountStore, fakeAuthenticator } from '../index.js';

/**
 * Compile-time guard: the fake has to stand in for a `ctx.auth` typed as the
 * client's `Authenticator`. Whenever `Authenticator` grows a method, this
 * assignment stops compiling until `FakeAuthenticatorLike` grows it too — which
 * is the only thing that keeps the fake honest.
 */
type CtxAuthSurface = {
  [K in keyof Authenticator]: Authenticator[K];
};

test.group('fakeAuthenticator', () => {
  test('checagens de role e identidade funcionam', async ({ assert }) => {
    const auth = fakeAuthenticator({
      identity: createTestIdentity({ globalRoles: ['ADMIN'] }),
    });

    assert.isTrue(await auth.check());
    assert.isTrue(auth.hasGlobalRole('ADMIN'));
    assert.isFalse(auth.hasGlobalRole('OWNER'));
    assert.equal((await auth.authenticate()).globalRoles[0], 'ADMIN');
  });

  test('identity null simula anônimo', async ({ assert }) => {
    const auth = fakeAuthenticator({ identity: null });
    assert.isFalse(await auth.check());
    assert.isNull(await auth.getUser());
    assert.isFalse(auth.hasGlobalRole('ADMIN'));
    await assert.rejects(() => auth.authenticate());
  });

  test('getUser retorna o user de domínio fornecido', async ({ assert }) => {
    const auth = fakeAuthenticator({ user: { id: 7, name: 'Z' } });
    assert.deepEqual(await auth.getUser(), { id: 7, name: 'Z' });
  });

  test('stands in for a ctx.auth typed as the real Authenticator', async ({ assert }) => {
    const auth = fakeAuthenticator({ user: { id: 7, name: 'Z' } });
    const ctxAuth: CtxAuthSurface = auth;

    assert.deepEqual(await ctxAuth.getUserOrFail(), { id: 7, name: 'Z' });
    assert.deepEqual(await ctxAuth.toSharedProps(), {
      user: { id: 7, name: 'Z' },
      globalRoles: createTestIdentity().globalRoles,
    });
  });

  test('getUserOrFail throws for an anonymous session, toSharedProps returns null', async ({
    assert,
  }) => {
    const auth = fakeAuthenticator({ identity: null });
    await assert.rejects(() => auth.getUserOrFail());
    assert.isNull(await auth.toSharedProps());
  });
});

test.group('fakeAccountStore', () => {
  test('núcleo presente, capacidades opt-in ausentes por default', async ({ assert }) => {
    const store = fakeAccountStore();
    assert.isFunction(store.findById);
    assert.isFunction(store.verifyCredentials);
    assert.isUndefined(store.getMfaState);
    assert.isUndefined(store.listPasskeys);
    assert.isUndefined(store.changePassword);
  });

  test('flags ativam as capacidades (supports* enxergam os métodos)', async ({ assert }) => {
    const store = fakeAccountStore({
      withMfa: true,
      withPasskeys: true,
      withAccountSecurity: true,
    });
    assert.isFunction(store.getMfaState);
    assert.isFunction(store.listPasskeys);
    assert.isFunction(store.changePassword);
  });

  test('overrides substituem métodos individuais', async ({ assert }) => {
    const store = fakeAccountStore({
      overrides: { findById: async () => null },
    });
    const found = await (store.findById as (id: string) => Promise<unknown>)('x');
    assert.isNull(found);
  });
});
