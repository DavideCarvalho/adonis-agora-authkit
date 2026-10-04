import { fileURLToPath } from 'node:url';
import { test } from '@japa/runner';
import { Edge } from 'edge.js';
import { DEFAULT_MESSAGES, translate } from '../../src/host/i18n.js';

const method = {
  id: 'sms',
  factorId: 'phone',
  label: 'Phone verification',
  requiresBegin: true,
  started: false,
  beginUrl: '/auth/interaction/u1/mfa/custom/sms/begin',
  verifyUrl: '/auth/interaction/u1/mfa/custom/sms/verify',
  fields: [{ name: 'otp', label: '<Code>', inputMode: 'numeric', autoComplete: 'one-time-code' }],
};

function render(overrides: Record<string, unknown> = {}) {
  const edge = new Edge();
  edge.mount('authkit', fileURLToPath(new URL('../../src/host/views/', import.meta.url)));
  edge.global('t', (key: string, params?: Record<string, string | number>) =>
    translate(DEFAULT_MESSAGES, key, params),
  );
  return edge.render('authkit::mfa-challenge', {
    uid: 'u1',
    csrfToken: 'csrf-token',
    totpAvailable: false,
    passkeyAvailable: false,
    customMfaMethods: [method],
    completedMfaMethods: [],
    requiredMfaFactors: 2,
    ...overrides,
  });
}

test.group('custom MFA challenge views', () => {
  test('renders native initiation before presenting proof fields', async ({ assert }) => {
    const html = await render();
    assert.include(html, `action="${method.beginUrl}"`);
    assert.include(html, 'name="_csrf" value="csrf-token"');
    assert.notInclude(html, 'name="otp"');
    assert.notInclude(html, 'name="code"');
  });

  test('renders escaped declared fields after initiation and for methods without begin', async ({
    assert,
  }) => {
    for (const updated of [
      { ...method, started: true },
      { ...method, requiresBegin: false },
    ]) {
      const html = await render({ customMfaMethods: [updated] });
      assert.include(html, `action="${method.verifyUrl}"`);
      assert.include(html, 'name="otp"');
      assert.include(html, '&lt;Code&gt;');
      assert.include(html, 'inputmode="numeric"');
      assert.notInclude(html, `action="${method.beginUrl}"`);
    }
  });

  test('hides methods already completed and prevents proof forms without enrollment', async ({
    assert,
  }) => {
    const completed = await render({ completedMfaMethods: ['sms'] });
    assert.notInclude(completed, `action="${method.beginUrl}"`);
    const unavailable = await render({
      noEnrollment: true,
      totpAvailable: true,
      passkeyAvailable: true,
    });
    assert.notInclude(unavailable, 'name="code"');
    assert.notInclude(unavailable, 'name="recoveryCode"');
    assert.notInclude(unavailable, 'id="passkey-button"');
    assert.notInclude(unavailable, `action="${method.beginUrl}"`);
  });

  test('OTP lockout hides built-in OTP forms while leaving independent custom factors usable', async ({
    assert,
  }) => {
    const html = await render({ otpLocked: true, totpAvailable: true });
    assert.notInclude(html, 'name="code"');
    assert.notInclude(html, 'name="recoveryCode"');
    assert.include(html, `action="${method.beginUrl}"`);
  });
});
