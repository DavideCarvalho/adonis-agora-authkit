import { errors } from '@adonisjs/auth';
import type { HttpContext } from '@adonisjs/core/http';
import { test } from '@japa/runner';
import { ACCOUNT_SESSION_KEY } from '../../src/host/account_session_key.js';
import { ACCOUNT_IDP_SESSION_KEY } from '../../src/host/idp_session_bridge.js';
import { OidcRpGuard } from '../../src/host/oidc_rp_guard.js';
import { fakeAccountStore } from '../bootstrap.js';

function harness(
  options: {
    current?: string;
    linked?: boolean;
    transient?: boolean;
    missing?: boolean;
    disabled?: boolean;
    renewal?: boolean;
    databaseError?: boolean;
    accept?: boolean;
  } = {},
) {
  const store: Record<string, unknown> = {};
  if (options.current) store[ACCOUNT_SESSION_KEY] = options.current;
  if (options.linked) store[ACCOUNT_IDP_SESSION_KEY] = 'idp-uid';
  let regenerated = 0;
  let destroyed = 0;
  const renewed: { id: string; ttl: number }[] = [];
  const cookies: { name: string; value: string; options: Record<string, unknown> }[] = [];
  const idp = {
    id: 'idp-id',
    uid: 'idp-uid',
    accountId: 'u1',
    transient: options.transient,
    exp: Date.now() / 1000 + 60,
    destroy: async () => {
      destroyed++;
    },
  };
  const service = {
    config: {
      accountStore: fakeAccountStore({
        isDisabled: async () => options.disabled === true,
        disableAccount: async () => {},
        enableAccount: async () => {},
      }),
    },
    sessionTtlHolder: { rememberSec: 3600 },
    provider: {
      cookieName: (_kind: string) => '_session',
      createContext: () => ({
        secure: true,
        cookies: {
          get: (_key: string) => 'idp-id',
          set: (name: string, value: string, options: Record<string, unknown>) => {
            cookies.push({ name, value, options });
          },
        },
      }),
      Session: {
        find: async (_id: string) => {
          if (options.databaseError) throw new Error('IdP database unavailable');
          return options.missing ? undefined : idp;
        },
        adapter: {
          renewSession: async (id: string, ttl: number) => {
            renewed.push({ id, ttl });
            return options.renewal !== false;
          },
        },
      },
    },
  };
  const ctx = {
    session: {
      get: (key: string) => store[key],
      put: (key: string, value: unknown) => {
        store[key] = value;
      },
      forget: (key: string) => {
        delete store[key];
      },
      clear: () => {
        for (const key of Object.keys(store)) delete store[key];
      },
      regenerate: async () => {
        regenerated++;
      },
    },
    request: { ip: () => '127.0.0.1', request: {} },
    response: { response: {} },
    containerResolver: { make: async (_key: string) => service },
  } as unknown as HttpContext;
  const userProvider = {
    createUserForGuard: async (user: { id: string }) => ({
      getId: () => user.id,
      getOriginal: () => user,
    }),
    findById: async (id: string) => ({ getId: () => id, getOriginal: () => ({ id }) }),
  } as unknown as ConstructorParameters<typeof OidcRpGuard>[4];
  const emitter = { emit: () => {} } as unknown as ConstructorParameters<typeof OidcRpGuard>[3];
  const guard = new OidcRpGuard(
    'web',
    ctx,
    ACCOUNT_SESSION_KEY,
    emitter,
    userProvider,
    errors.E_UNAUTHORIZED_ACCESS,
    { acceptIdpSession: options.accept ?? true },
  );
  return {
    guard,
    ctx,
    store,
    cookies,
    renewed,
    regenerated: () => regenerated,
    destroyed: () => destroyed,
  };
}

test.group('Remembered same-host RP session', () => {
  test('restores the RP from the signed IdP credential and renews its cookie', async ({
    assert,
  }) => {
    const h = harness();
    assert.isTrue(await h.guard.check());
    assert.equal(h.store[ACCOUNT_SESSION_KEY], 'u1');
    assert.equal(h.store[ACCOUNT_IDP_SESSION_KEY], 'idp-uid');
    assert.equal(h.regenerated(), 1);
    assert.deepEqual(h.renewed, [{ id: 'idp-id', ttl: 3600 }]);
    assert.deepInclude(h.cookies[0].options, {
      signed: true,
      httpOnly: true,
      secure: true,
      maxAge: 3600000,
    });
  });

  for (const options of [
    { transient: true },
    { disabled: true },
    { missing: true },
    { renewal: false },
    { accept: false },
  ]) {
    test(`does not restore unavailable credentials: ${JSON.stringify(options)}`, async ({
      assert,
    }) => {
      const h = harness(options);
      assert.isFalse(await h.guard.check());
      assert.isUndefined(h.store[ACCOUNT_SESSION_KEY]);
    });
  }

  test('invalidates a linked RP when the IdP credential is revoked', async ({ assert }) => {
    const h = harness({ current: 'u1', linked: true, missing: true });
    assert.isFalse(await h.guard.check());
    assert.isUndefined(h.store[ACCOUNT_SESSION_KEY]);
  });

  test('does not replace an existing local login with another IdP account', async ({ assert }) => {
    const h = harness({ current: 'u2' });
    assert.isTrue(await h.guard.check());
    assert.equal(h.store[ACCOUNT_SESSION_KEY], 'u2');
    assert.deepEqual(h.renewed, []);
  });

  test('propagates IdP storage errors', async ({ assert }) => {
    const h = harness({ databaseError: true });
    await assert.rejects(() => h.guard.check(), 'IdP database unavailable');
  });

  test('logout revokes the persistent credential even after the local RP session expired', async ({
    assert,
  }) => {
    const h = harness();
    await h.guard.logout();
    assert.equal(h.destroyed(), 1);
    assert.isUndefined(h.store[ACCOUNT_IDP_SESSION_KEY]);
  });
});
