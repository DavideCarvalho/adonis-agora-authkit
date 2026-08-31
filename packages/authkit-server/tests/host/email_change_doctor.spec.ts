/**
 * Testes dos novos checks de doctor:
 * - checkEmailChange: capability presente/ausente
 * - checkSecurityNotifications: mail configurado ou não
 */

import { test } from '@japa/runner';
import type { DoctorInput } from '../../src/doctor/checks.js';
import { checkEmailChange, checkSecurityNotifications } from '../../src/doctor/checks.js';

function baseInput(storeOverride: any = {}, cfgExtra: any = {}): DoctorInput {
  const store = {
    findById: async () => null,
    verifyCredentials: async () => null,
    findByEmail: async () => null,
    create: async () => ({ id: 'x', email: 'x@x.com' }),
    issuePasswordResetToken: async () => null,
    consumePasswordResetToken: async () => false,
    issueEmailVerificationToken: async () => null,
    consumeEmailVerificationToken: async () => false,
    listAccounts: async () => ({ data: [], total: 0 }),
    setGlobalRoles: async () => {},
    ...storeOverride,
  };
  return {
    authkitConfig: {
      issuer: 'https://auth.acme.example.com/oidc',
      accountStore: store,
      ...cfgExtra,
    },
    sessionConfig: {},
    peers: { session: true, shield: true, ally: false, limiter: false },
  };
}

// ---------------------------------------------------------------------------
// checkEmailChange
// ---------------------------------------------------------------------------

test.group('checkEmailChange', () => {
  test('ok quando store implementa changePassword (AccountSecurityCapability)', ({ assert }) => {
    const input = baseInput({ changePassword: async () => true });
    const result = checkEmailChange(input);
    assert.equal(result?.level, 'ok');
  });

  test('warn quando store NÃO implementa changePassword', ({ assert }) => {
    const input = baseInput(); // sem changePassword
    const result = checkEmailChange(input);
    assert.equal(result?.level, 'warn');
    assert.ok(result?.message.includes('AccountSecurityCapability'));
  });

  test('null quando authkitConfig é null', ({ assert }) => {
    const input: DoctorInput = {
      authkitConfig: null,
      sessionConfig: null,
      peers: { session: false, shield: false, ally: false, limiter: false },
    };
    const result = checkEmailChange(input);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// checkSecurityNotifications
// ---------------------------------------------------------------------------

test.group('checkSecurityNotifications', () => {
  test('warn quando não há mail configurado', ({ assert }) => {
    const input = baseInput({ changePassword: async () => true });
    // Sem mail.onSecurityNotice e sem mailer
    const result = checkSecurityNotifications(input);
    assert.equal(result?.level, 'warn');
    assert.ok(result?.message.toLowerCase().includes('mail'));
  });

  test('null (silencioso) quando store + mail estão configurados', ({ assert }) => {
    const input = baseInput(
      { changePassword: async () => true },
      {
        mail: { onSecurityNotice: async () => {} },
      },
    );
    const result = checkSecurityNotifications(input);
    assert.equal(result, null);
  });

  test('warn quando store não implementa changePassword', ({ assert }) => {
    const input = baseInput(
      {},
      {
        mail: { onSecurityNotice: async () => {} },
      },
    );
    const result = checkSecurityNotifications(input);
    // store sem capability → warn
    assert.equal(result?.level, 'warn');
  });

  test('null quando authkitConfig é null', ({ assert }) => {
    const input: DoctorInput = {
      authkitConfig: null,
      sessionConfig: null,
      peers: { session: false, shield: false, ally: false, limiter: false },
    };
    const result = checkSecurityNotifications(input);
    assert.equal(result, null);
  });
});
