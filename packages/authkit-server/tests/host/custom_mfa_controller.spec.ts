import type { HttpContext } from '@adonisjs/core/http';
import { test } from '@japa/runner';
import { resolveLogin, resolvePasswordless } from '../../src/define_config.js';
import Controller from '../../src/host/controllers/interaction_controller.js';
import type { CustomLoginMethod } from '../../src/host/custom_login.js';

function fixture(
  opts: {
    disabled?: boolean;
    mfa?: boolean;
    verified?: boolean;
    uid?: string;
    prompt?: string;
    requiredFactors?: number;
  } = {},
) {
  const session: Record<string, unknown> = {};
  const audits: Array<Record<string, unknown>> = [];
  const completed: Array<{ id: string; extra: unknown }> = [];
  const rendered: Array<{ view: string; props: Record<string, unknown> }> = [];
  let authentications = 0;
  class WhatsappLogin implements CustomLoginMethod {
    readonly passwordless = true;
    async begin() {
      return 'challenge-started';
    }
    async authenticate() {
      authentications++;
      return session.proof === 'valid' ? { accountId: 'acc-1' } : null;
    }
  }
  let proof = true;
  let starts = 0;
  const mfaMethods = {
    whatsapp: {
      factorId: 'phone',
      isEnabled: async () => true,
      describe: async () => ({
        label: 'WhatsApp',
        fields: [{ name: 'code', label: 'Code', inputMode: 'numeric' as const }],
      }),
      begin: async () => {
        starts++;
      },
      verify: async () => proof,
    },
    device: {
      factorId: 'device',
      isEnabled: async () => true,
      describe: async () => ({ label: 'Security device' }),
      verify: async () => proof,
    },
  };
  const account = { id: 'acc-1', email: 'user@example.com', globalRoles: ['USER'] };
  const store = {
    findById: async (id: string) => (id === account.id ? account : null),
    findByEmail: async () => account,
    verifyCredentials: async () => null,
    create: async () => account,
    disableAccount: async () => {},
    isDisabled: async () => opts.disabled ?? false,
    isEmailVerified: async () => opts.verified ?? true,
    getMfaState: async () => ({ enabled: opts.mfa ?? false, totp: opts.mfa ?? false }),
    startTotpEnrollment: async () => null,
    confirmTotpEnrollment: async () => false,
    verifyTotp: async (_id: string, code: string) => code === '123456',
    consumeRecoveryCode: async () => false,
    disableMfa: async () => {},
  };
  const config = {
    customLoginMethods: { whatsapp: WhatsappLogin },
    mfa: { methods: mfaMethods, requiredFactors: opts.requiredFactors ?? 2 },
    accountStore: store,
    render: async (_ctx: unknown, view: string, props: Record<string, unknown>) => {
      rendered.push({ view, props });
      return { view, props };
    },
    messages: {},
    branding: { default: { appName: 'Acme', logoUrl: null }, clients: {}, firstParty: [] },
    login: resolveLogin({ requireVerifiedEmail: opts.verified === false }),
    passwordless: resolvePasswordless(),
    notifications: { newLoginEmail: false, newDeviceEmail: false },
    trustedDevices: { enabled: false, days: 30 },
    audit: {
      record: async (event: Record<string, unknown>) => {
        audits.push(event);
      },
    },
  };
  const service = {
    config,
    interactions: {
      details: async () => ({
        uid: opts.uid ?? 'uid-1',
        prompt: { name: opts.prompt ?? 'login' },
        params: { client_id: 'web' },
      }),
      completeLogin: async (_ctx: unknown, id: string, extra: unknown) => {
        completed.push({ id, extra });
        return 'logged-in';
      },
    },
  };
  const ctx = {
    containerResolver: {
      make: async (binding: unknown) => {
        if (binding === 'authkit.server') return service;
        if (binding === WhatsappLogin) return new WhatsappLogin();
        if (binding === 'lucid.db')
          return {
            from() {
              throw new Error('no table');
            },
          };
        throw new Error('unknown binding');
      },
    },
    request: {
      param: (name: string) => (name === 'uid' ? 'uid-1' : session.selectedMethod),
      csrfToken: 'csrf',
      ip: () => '127.0.0.1',
      header: () => undefined,
      encryptedCookie: () => undefined,
      only: () => ({ code: '123456' }),
      input: () => undefined,
    },
    response: { encryptedCookie() {}, redirect: () => 'redirect' },
    session: {
      get: (key: string) => session[key],
      put: (key: string, value: unknown) => {
        session[key] = value;
      },
      forget: (key: string) => {
        delete session[key];
      },
    },
    logger: { warn() {}, error() {} },
  } as unknown as HttpContext;
  return {
    ctx,
    service,
    session,
    completed,
    audits,
    setProof: (value: boolean) => {
      proof = value;
    },
    get starts() {
      return starts;
    },
    rendered,
    get authentications() {
      return authentications;
    },
  };
}

test.group('custom MFA shared controller', () => {
  test('requires an enrolled custom factor after a verified primary login', async ({ assert }) => {
    const f = fixture();
    await new Controller().completeCustomLogin(f.ctx, {
      accountId: 'acc-1',
      method: 'portal',
      passwordless: true,
    });
    assert.lengthOf(f.completed, 0);
    assert.equal(f.rendered[0].view, 'mfa-challenge');
    const methods = f.rendered[0].props.customMfaMethods as Array<{ id: string }>;
    assert.isTrue(methods.some((method) => method.id === 'whatsapp'));
  });
  test('begins a delivery challenge then completes only after successful verification', async ({
    assert,
  }) => {
    const f = fixture();
    const c = new Controller();
    await c.completeCustomLogin(f.ctx, {
      accountId: 'acc-1',
      method: 'portal',
      passwordless: true,
    });
    f.session.selectedMethod = 'whatsapp';
    await c.customMfaBegin(f.ctx);
    assert.equal(f.starts, 1);
    f.setProof(false);
    await c.customMfaVerify(f.ctx);
    assert.lengthOf(f.completed, 0);
    f.setProof(true);
    await c.customMfaVerify(f.ctx);
    assert.deepEqual(f.completed[0]?.extra, {
      amr: ['portal', 'mfa', 'whatsapp'],
      remember: false,
    });
    assert.isUndefined(f.session.authkit_mfa_pending);
    assert.isUndefined(f.session.authkit_mfa_flow);
  });
  test('three-factor policy waits for two distinct additional groups', async ({ assert }) => {
    const f = fixture({ requiredFactors: 3 });
    const c = new Controller();
    await c.completeCustomLogin(f.ctx, {
      accountId: 'acc-1',
      method: 'portal',
      passwordless: true,
    });
    f.session.selectedMethod = 'whatsapp';
    await c.customMfaBegin(f.ctx);
    await c.customMfaVerify(f.ctx);
    assert.lengthOf(f.completed, 0);
    f.session.selectedMethod = 'device';
    await c.customMfaVerify(f.ctx);
    assert.deepEqual(f.completed[0]?.extra, {
      amr: ['portal', 'mfa', 'whatsapp', 'device'],
      remember: false,
    });
  });
  test('the primary phone group cannot count as an additional WhatsApp factor', async ({
    assert,
  }) => {
    const f = fixture({ requiredFactors: 3 });
    const c = new Controller();
    await c.completeCustomLogin(f.ctx, {
      accountId: 'acc-1',
      method: 'phone-login',
      factorId: 'phone',
      passwordless: true,
    });
    assert.lengthOf(f.completed, 0);
    assert.isTrue(f.rendered[0].props.noEnrollment);
  });
  test('combines native TOTP and a custom factor for a three-factor policy', async ({ assert }) => {
    const f = fixture({ requiredFactors: 3, mfa: true });
    const c = new Controller();
    await c.completeCustomLogin(f.ctx, {
      accountId: 'acc-1',
      method: 'portal',
      passwordless: true,
    });
    await c.mfaVerify(f.ctx);
    assert.lengthOf(f.completed, 0);
    f.session.selectedMethod = 'device';
    await c.customMfaVerify(f.ctx);
    assert.deepEqual(f.completed[0]?.extra, {
      amr: ['portal', 'mfa', 'totp', 'device'],
      remember: false,
    });
  });
  test('rechecks account status when the final factor succeeds', async ({ assert }) => {
    const opts = { disabled: false };
    const f = fixture(opts);
    const c = new Controller();
    await c.completeCustomLogin(f.ctx, {
      accountId: 'acc-1',
      method: 'portal',
      passwordless: true,
    });
    opts.disabled = true;
    f.session.selectedMethod = 'device';
    await c.customMfaVerify(f.ctx);
    assert.lengthOf(f.completed, 0);
    assert.isUndefined(f.session.authkit_mfa_flow);
  });
  test('native TOTP refuses a different live OIDC interaction', async ({ assert }) => {
    const opts = { mfa: true, uid: 'uid-1' };
    const f = fixture(opts);
    const c = new Controller();
    await c.completeCustomLogin(f.ctx, {
      accountId: 'acc-1',
      method: 'portal',
      passwordless: true,
    });
    opts.uid = 'another-interaction';
    await c.mfaVerify(f.ctx);
    assert.lengthOf(f.completed, 0);
    assert.isUndefined(f.session.authkit_mfa_flow);
  });
  test('native TOTP refuses a live consent prompt', async ({ assert }) => {
    const opts = { mfa: true, prompt: 'login' };
    const f = fixture(opts);
    const c = new Controller();
    await c.completeCustomLogin(f.ctx, {
      accountId: 'acc-1',
      method: 'portal',
      passwordless: true,
    });
    opts.prompt = 'consent';
    await c.mfaVerify(f.ctx);
    assert.lengthOf(f.completed, 0);
  });
});
