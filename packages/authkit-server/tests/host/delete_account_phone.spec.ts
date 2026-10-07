import type { HttpContext } from '@adonisjs/core/http';
import { test } from '@japa/runner';
import type { AuthAccount } from '../../src/accounts/account_store.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/account_session_key.js';
import AccountSecurityController from '../../src/host/controllers/account_security_controller.js';
import { SUDO_ACCOUNT_SESSION_KEY, SUDO_SESSION_KEY } from '../../src/host/sudo_mode.js';
import { fakeAccountStore } from '../bootstrap.js';

async function attemptDeletion(account: AuthAccount, confirmEmail: string) {
  const deleted: string[] = [];
  const flashed: string[] = [];
  const session: Record<string, unknown> = {
    [ACCOUNT_SESSION_KEY]: account.id,
    [SUDO_SESSION_KEY]: Date.now(),
    [SUDO_ACCOUNT_SESSION_KEY]: account.id,
  };
  const service = {
    config: {
      messages: {},
      accountStore: fakeAccountStore({
        findById: async () => account,
        deleteAccount: async (id) => {
          deleted.push(id);
          return true;
        },
      }),
    },
  };
  const ctx = {
    containerResolver: {
      make: async (key: string) => {
        if (key === 'authkit.server') return service;
        throw new Error('No runtime database');
      },
    },
    request: {
      validateUsing: async () => ({ confirmEmail }),
      ip: () => '127.0.0.1',
    },
    session: {
      get: (key: string) => session[key],
      forget: (key: string) => {
        delete session[key];
      },
      flash: (key: string) => {
        flashed.push(key);
      },
    },
    response: { redirect: (location: string) => location },
  } as unknown as HttpContext;
  await new AccountSecurityController().deleteAccount(ctx);
  return { deleted, flashed, session };
}

test.group('Account deletion verified phone confirmation', () => {
  test('a phone-only account can confirm with a formatted verified phone', async ({ assert }) => {
    const result = await attemptDeletion(
      { id: 'u1', email: '', phone: '5511999999999' },
      '+55 (11) 99999-9999',
    );
    assert.deepEqual(result.deleted, ['u1']);
    assert.notProperty(result.session, ACCOUNT_SESSION_KEY);
    assert.include(result.flashed, 'accountDeleted');
  });

  for (const confirmation of [
    '5511888888888',
    'phone:5511999999999',
    '5511999999999@example.com',
  ]) {
    test(`refuses an incorrect or non-phone confirmation: ${confirmation}`, async ({ assert }) => {
      const result = await attemptDeletion(
        { id: 'u1', email: '', phone: '5511999999999' },
        confirmation,
      );
      assert.deepEqual(result.deleted, []);
      assert.include(result.flashed, 'deleteError');
    });
  }

  test('refuses phone confirmation when the store exposes no verified phone', async ({
    assert,
  }) => {
    const result = await attemptDeletion({ id: 'u1', email: '' }, '5511999999999');
    assert.deepEqual(result.deleted, []);
    assert.include(result.flashed, 'deleteError');
  });

  test('an account with email still requires email or password confirmation', async ({
    assert,
  }) => {
    const result = await attemptDeletion(
      { id: 'u1', email: 'a@b.com', phone: '5511999999999' },
      '5511999999999',
    );
    assert.deepEqual(result.deleted, []);
    const emailResult = await attemptDeletion({ id: 'u1', email: 'a@b.com' }, 'A@B.COM');
    assert.deepEqual(emailResult.deleted, ['u1']);
  });
});
