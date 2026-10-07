import 'reflect-metadata';
import { Container, inject } from '@adonisjs/core/container';
import type { HttpContext } from '@adonisjs/core/http';
import { test } from '@japa/runner';
import { resolveLogin, resolvePasswordless } from '../../src/define_config.js';
import type { CustomLoginMethod } from '../../src/host/custom_login.js';
import {
  authenticateCustomLogin,
  beginCustomLogin,
  completeCustomLogin,
} from '../../src/host/custom_login.js';

function fixture(
  opts: {
    disabled?: boolean;
    mfa?: boolean;
    verified?: boolean;
    uid?: string;
    prompt?: string;
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
      param: () => 'uid-1',
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
    rendered,
    get authentications() {
      return authentications;
    },
  };
}

test.group('custom login classes', () => {
  test('resolves a class, starts its challenge and completes a verified login', async ({
    assert,
  }) => {
    const f = fixture();
    assert.equal(await beginCustomLogin(f.ctx, 'whatsapp'), 'challenge-started');
    f.session.proof = 'valid';
    assert.equal(await authenticateCustomLogin(f.ctx, 'whatsapp'), 'logged-in');
    assert.deepEqual(f.completed[0], {
      id: 'acc-1',
      extra: { amr: ['whatsapp'], remember: false },
    });
  });
  test('resolves injected dependencies through the real Adonis request container', async ({
    assert,
  }) => {
    const f = fixture();
    class ProofVerifier {
      async verify() {
        return { accountId: 'acc-1' };
      }
    }
    class InjectedLogin implements CustomLoginMethod {
      constructor(private verifier: ProofVerifier) {}
      async authenticate() {
        return this.verifier.verify();
      }
    }
    // Package test transpilation omits decorator metadata; supply what an Adonis host emits.
    Reflect.defineMetadata('design:paramtypes', [ProofVerifier], InjectedLogin);
    inject()(InjectedLogin);
    const container = new Container();
    container.bind('authkit.server', () => f.service);
    const resolver = container.createResolver();
    const ctx = { ...f.ctx, containerResolver: resolver } as unknown as HttpContext;
    Object.assign(f.service.config.customLoginMethods, { injected: InjectedLogin });
    await authenticateCustomLogin(ctx, 'injected');
    assert.deepEqual(f.completed[0], {
      id: 'acc-1',
      extra: { amr: ['injected'], remember: false },
    });
  });
  test('rejects failed proofs without completing a login', async ({ assert }) => {
    const f = fixture();
    await assert.rejects(() => authenticateCustomLogin(f.ctx, 'whatsapp'));
    assert.lengthOf(f.completed, 0);
    assert.isTrue(
      f.audits.some(
        (event) =>
          event.type === 'login.failure' &&
          (event.metadata as Record<string, unknown>).method === 'whatsapp',
      ),
    );
  });
  test('rejects unknown methods before checking credentials', async ({ assert }) => {
    const f = fixture();
    await assert.rejects(() => authenticateCustomLogin(f.ctx, 'unregistered'));
    assert.equal(f.authentications, 0);
  });
  test('rejects another browser interaction before consuming proof', async ({ assert }) => {
    const f = fixture({ uid: 'different' });
    f.session.proof = 'valid';
    await assert.rejects(() => authenticateCustomLogin(f.ctx, 'whatsapp'));
    assert.equal(f.authentications, 0);
  });
  test('rejects non-login interactions', async ({ assert }) => {
    const f = fixture({ prompt: 'consent' });
    await assert.rejects(() => authenticateCustomLogin(f.ctx, 'whatsapp'));
    assert.equal(f.authentications, 0);
  });
  test('enforces disabled accounts after credential validation', async ({ assert }) => {
    const f = fixture({ disabled: true });
    f.session.proof = 'valid';
    await authenticateCustomLogin(f.ctx, 'whatsapp');
    assert.lengthOf(f.completed, 0);
    assert.equal(f.rendered[0].props.error, 'errors.account_disabled');
  });
  test('enforces configured email verification policy', async ({ assert }) => {
    const f = fixture({ verified: false });
    f.session.proof = 'valid';
    await authenticateCustomLogin(f.ctx, 'whatsapp');
    assert.lengthOf(f.completed, 0);
    assert.equal(f.rendered[0].props.error, 'errors.email_unverified');
  });
  test('challenges MFA and preserves the custom primary factor on completion', async ({
    assert,
  }) => {
    const f = fixture({ mfa: true });
    f.session.proof = 'valid';
    await authenticateCustomLogin(f.ctx, 'whatsapp');
    assert.lengthOf(f.completed, 0);
    assert.equal(f.session.authkit_mfa_primary, 'whatsapp');
    const { default: Controller } = await import(
      '../../src/host/controllers/interaction_controller.js'
    );
    await new Controller().mfaVerify(f.ctx);
    assert.deepEqual(f.completed[0]?.extra, { amr: ['whatsapp', 'mfa', 'totp'], remember: false });
    assert.isUndefined(f.session.authkit_mfa_custom_primary);
  });
  test('ignores a custom MFA marker from another interaction', async ({ assert }) => {
    const f = fixture({ mfa: true });
    f.session.proof = 'valid';
    await authenticateCustomLogin(f.ctx, 'whatsapp');
    f.session.authkit_mfa_custom_primary = { method: 'whatsapp', accountId: 'acc-1', uid: 'other' };
    const { default: Controller } = await import(
      '../../src/host/controllers/interaction_controller.js'
    );
    await new Controller().mfaVerify(f.ctx);
    assert.deepEqual(f.completed[0]?.extra, { amr: ['mfa', 'totp'] });
  });
  test('trusted completion rejects unknown accounts and malformed method IDs', async ({
    assert,
  }) => {
    const f = fixture();
    await assert.rejects(() =>
      completeCustomLogin(f.ctx, { accountId: 'missing', method: 'whatsapp' }),
    );
    await assert.rejects(() =>
      completeCustomLogin(f.ctx, { accountId: 'acc-1', method: 'invalid method' }),
    );
    await assert.rejects(() => completeCustomLogin(f.ctx, { accountId: 'acc-1', method: 'pwd' }));
    assert.lengthOf(f.completed, 0);
  });
});
