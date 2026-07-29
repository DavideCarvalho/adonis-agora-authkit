/**
 * Plan 003 — cobre o ramo de EXPIRAÇÃO (não só `disabled`) do gate
 * compartilhado `assertLoginAllowed`/`assertAccountNotExpired`
 * (`src/host/login_attempt.ts`), o mesmo helper que os fluxos passwordless
 * (magic link, OTP, passkey, social) chamam imediatamente antes de
 * `completeLogin`. Testado no nível do helper (não via HTTP) porque é
 * exatamente o que os controllers chamam — ver `account_status_gate.spec.ts`
 * para a cobertura "disabled" via os controllers reais.
 */

import { test } from '@japa/runner';
import { assertAccountNotExpired, assertLoginAllowed } from '../../src/host/login_attempt.js';

const ACCOUNT_ID = 'acc-1';
const EMAIL = 'user@example.com';

function fakeSettings(rows: Record<string, any>) {
  return {
    getSetting: async (key: string) => rows[key] ?? null,
    setSetting: async () => {},
  };
}

test.group('account status gate — account_expiration (inatividade)', () => {
  test('conta inativa há mais que inactiveDays: recusada com reason=account_expired', async ({
    assert,
  }) => {
    const oldLogin = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000); // 400 dias atrás
    const settings = fakeSettings({ account_expiration: { enabled: true, inactiveDays: 365 } });
    const audit = {
      record: async () => {},
      list: async () => ({ data: [{ createdAt: oldLogin }], total: 1 }),
    };
    const cfg = { accountStore: {} as any, audit };

    const result = await assertAccountNotExpired(cfg, ACCOUNT_ID, {
      email: EMAIL,
      ip: '1.2.3.4',
      settings,
    });

    assert.deepEqual(result, { allowed: false, reason: 'account_expired' });
  });

  test('conta ativa recentemente: permitida', async ({ assert }) => {
    const recentLogin = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const settings = fakeSettings({ account_expiration: { enabled: true, inactiveDays: 365 } });
    const audit = {
      record: async () => {},
      list: async () => ({ data: [{ createdAt: recentLogin }], total: 1 }),
    };
    const cfg = { accountStore: {} as any, audit };

    const result = await assertAccountNotExpired(cfg, ACCOUNT_ID, {
      email: EMAIL,
      ip: '1.2.3.4',
      settings,
    });

    assert.deepEqual(result, { allowed: true });
  });

  test('assertLoginAllowed combinado: disabled tem precedência sobre account_expired', async ({
    assert,
  }) => {
    const oldLogin = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    const settings = fakeSettings({ account_expiration: { enabled: true, inactiveDays: 365 } });
    const audit = {
      record: async () => {},
      list: async () => ({ data: [{ createdAt: oldLogin }], total: 1 }),
    };
    const store: any = {
      disableAccount: async () => {},
      enableAccount: async () => {},
      isDisabled: async () => true,
    };
    const cfg = { accountStore: store, audit };

    const result = await assertLoginAllowed(cfg, ACCOUNT_ID, { email: EMAIL, ip: null, settings });

    assert.deepEqual(result, { allowed: false, reason: 'disabled' });
  });
});
