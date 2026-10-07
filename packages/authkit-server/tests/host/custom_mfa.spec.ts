import 'reflect-metadata';
import { Container, inject } from '@adonisjs/core/container';
import type { HttpContext } from '@adonisjs/core/http';
import { test } from '@japa/runner';
import {
  beginCustomMfa,
  type CustomMfaContext,
  type CustomMfaMethod,
  type CustomMfaMethodBinding,
  clearMfaFlow,
  customMfaViewProps,
  getMfaFlow,
  initializeMfaFlow,
  recordVerifiedMfaFactor,
  resolveCustomMfaMethods,
  verifyCustomMfa,
} from '../../src/host/custom_mfa.js';
import type { OidcService } from '../../src/provider/oidc_service.js';

function fixture() {
  const session = new Map<string, unknown>([['authkit_mfa_pending', 'acc-1']]);
  const account = { id: 'acc-1', email: 'user@example.com' };
  const calls: CustomMfaContext[] = [];
  const settings = { enabled: true, proof: true, uid: 'uid-1', prompt: 'login', available: true };
  const methods: Record<string, CustomMfaMethodBinding> = {
    whatsapp: {
      factorId: 'phone',
      async isEnabled(context) {
        calls.push(context);
        return settings.enabled;
      },
      async describe() {
        return {
          label: 'WhatsApp',
          fields: [{ name: 'code', label: 'Código', inputMode: 'numeric' }],
        };
      },
      async begin(context) {
        calls.push(context);
      },
      async verify(context) {
        calls.push(context);
        return settings.proof;
      },
    },
  };
  const service = {
    config: {
      mfa: { methods, requiredFactors: 3 },
      accountStore: {
        findById: async (id: string) => (settings.available && id === account.id ? account : null),
      },
    },
    interactions: {
      details: async () => ({ uid: settings.uid, prompt: { name: settings.prompt } }),
    },
  };
  const container = new Container();
  container.bind('authkit.server', () => service as unknown as OidcService);
  const ctx = {
    containerResolver: container.createResolver(),
    request: { param: (name: string) => (name === 'uid' ? 'uid-1' : undefined) },
    session: {
      get: (key: string) => session.get(key),
      put: (key: string, value: unknown) => session.set(key, value),
      forget: (key: string) => session.delete(key),
    },
  } as unknown as HttpContext;
  const initialize = () =>
    initializeMfaFlow(ctx, {
      uid: 'uid-1',
      accountId: 'acc-1',
      primaryMethod: 'email',
      primaryFactorId: 'email',
      requiredFactors: 3,
    });
  initialize();
  return { ctx, session, account, settings, calls, methods, container, initialize };
}

test.group('custom MFA', () => {
  test('initializes a unique flow and binds context to the trusted account', async ({ assert }) => {
    const f = fixture();
    const flow = getMfaFlow(f.ctx)!;
    assert.match(flow.challengeId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(flow.completed, []);
    assert.equal(flow.attempts, 0);
    await beginCustomMfa(f.ctx, 'whatsapp');
    assert.strictEqual(f.calls[0].account, f.account);
    assert.equal(f.calls[0].accountId, 'acc-1');
    assert.equal(f.calls[0].challengeId, flow.challengeId);
    assert.deepEqual(getMfaFlow(f.ctx)?.startedMethods, ['whatsapp']);
  });

  test('requires challenge initiation before verifying a method with begin', async ({ assert }) => {
    const f = fixture();
    await assert.rejects(() => verifyCustomMfa(f.ctx, 'whatsapp'), /started/);
    await beginCustomMfa(f.ctx, 'whatsapp');
    assert.isTrue(await verifyCustomMfa(f.ctx, 'whatsapp'));
  });

  test('supports independent injected classes without requiring begin', async ({ assert }) => {
    const f = fixture();
    class Proof {
      async verify() {
        return true;
      }
    }
    class SmsMfa implements CustomMfaMethod {
      constructor(private proof: Proof) {}
      async isEnabled() {
        return true;
      }
      async describe() {
        return { label: 'SMS' };
      }
      async verify() {
        return this.proof.verify();
      }
    }
    Reflect.defineMetadata('design:paramtypes', [Proof], SmsMfa);
    inject()(SmsMfa);
    f.methods.sms = SmsMfa;
    assert.isTrue(await verifyCustomMfa(f.ctx, 'sms'));
    const descriptors = await resolveCustomMfaMethods(
      f.ctx,
      'acc-1',
      'uid-1',
      'email',
      getMfaFlow(f.ctx)!.challengeId,
    );
    assert.deepEqual(
      descriptors.map((d) => d.id),
      ['whatsapp', 'sms'],
    );
    assert.equal(descriptors[1].factorId, 'sms');
    assert.isFalse(descriptors[1].requiresBegin);
  });

  test('rejects unregistered, reserved and malformed bindings', async ({ assert }) => {
    const f = fixture();
    for (const method of ['absent', 'totp', 'recovery', 'pwd', 'email', 'webauthn', '../escape']) {
      await assert.rejects(() => beginCustomMfa(f.ctx, method));
    }
    f.methods.invalid = {} as CustomMfaMethod;
    await assert.rejects(() => beginCustomMfa(f.ctx, 'invalid'), /method/);
  });

  test('rejects another interaction, prompt or pending account', async ({ assert }) => {
    for (const variant of ['uid', 'prompt', 'account']) {
      const f = fixture();
      if (variant === 'uid') f.settings.uid = 'another';
      if (variant === 'prompt') f.settings.prompt = 'consent';
      if (variant === 'account') f.session.set('authkit_mfa_pending', 'another-account');
      await assert.rejects(() => beginCustomMfa(f.ctx, 'whatsapp'));
      assert.lengthOf(f.calls, 0);
    }
  });

  test('expires old flows and rejects malformed session data', ({ assert }) => {
    const f = fixture();
    f.session.set('authkit_mfa_flow', { ...getMfaFlow(f.ctx), createdAt: Date.now() - 600_001 });
    assert.isNull(getMfaFlow(f.ctx));
    f.session.set('authkit_mfa_flow', { uid: 'uid-1', accountId: 'acc-1' });
    assert.isNull(getMfaFlow(f.ctx));
    f.initialize();
    clearMfaFlow(f.ctx);
    assert.isNull(getMfaFlow(f.ctx));
  });

  test('reloads enrollment and account before beginning or verifying', async ({ assert }) => {
    const f = fixture();
    await beginCustomMfa(f.ctx, 'whatsapp');
    f.settings.enabled = false;
    await assert.rejects(() => verifyCustomMfa(f.ctx, 'whatsapp'), /enabled/);
    f.settings.enabled = true;
    f.settings.available = false;
    await assert.rejects(() => beginCustomMfa(f.ctx, 'whatsapp'), /account/);
  });

  test('counts failed proofs and removes the pending flow after five attempts', async ({
    assert,
  }) => {
    const f = fixture();
    await beginCustomMfa(f.ctx, 'whatsapp');
    f.settings.proof = false;
    for (let attempt = 1; attempt <= 5; attempt++) {
      assert.isFalse(await verifyCustomMfa(f.ctx, 'whatsapp'));
      if (attempt < 5) assert.equal(getMfaFlow(f.ctx)?.attempts, attempt);
    }
    assert.isNull(getMfaFlow(f.ctx));
    assert.isFalse(f.session.has('authkit_mfa_pending'));
  });

  test('requires total distinct factors and excludes primary or replayed factors', async ({
    assert,
  }) => {
    const f = fixture();
    assert.throws(() => recordVerifiedMfaFactor(f.ctx, 'email-again', 'email'), /factor/);
    assert.deepEqual(recordVerifiedMfaFactor(f.ctx, 'whatsapp', 'phone'), {
      complete: false,
      amr: ['email', 'whatsapp'],
    });
    assert.throws(() => recordVerifiedMfaFactor(f.ctx, 'sms', 'phone'), /factor/);
    await assert.rejects(() => beginCustomMfa(f.ctx, 'whatsapp'), /factor/);
    assert.deepEqual(recordVerifiedMfaFactor(f.ctx, 'totp'), {
      complete: true,
      amr: ['email', 'whatsapp', 'totp'],
    });
  });

  test('renders serializable descriptors only for unused enabled factors', async ({ assert }) => {
    const f = fixture();
    await beginCustomMfa(f.ctx, 'whatsapp');
    const view = await customMfaViewProps(f.ctx);
    assert.equal(view.requiredMfaFactors, 3);
    assert.deepEqual(view.completedMfaMethods, []);
    assert.isTrue(view.customMfaMethods[0].started);
    assert.equal(view.customMfaMethods[0].label, 'WhatsApp');
    assert.notProperty(view.customMfaMethods[0], 'verify');
    assert.include(view.customMfaMethods[0].beginUrl, 'uid-1');
    assert.equal(JSON.parse(JSON.stringify(view)).customMfaMethods[0].factorId, 'phone');
    recordVerifiedMfaFactor(f.ctx, 'whatsapp', 'phone');
    assert.deepEqual((await customMfaViewProps(f.ctx)).customMfaMethods, []);
  });
  test('does not resurrect a replaced challenge after an asynchronous delivery', async ({
    assert,
  }) => {
    const f = fixture();
    f.methods.whatsapp = {
      async isEnabled() {
        return true;
      },
      async describe() {
        return { label: 'WhatsApp' };
      },
      async begin() {
        f.initialize();
      },
      async verify() {
        return true;
      },
    };
    await assert.rejects(() => beginCustomMfa(f.ctx, 'whatsapp'), /challenge/);
    assert.deepEqual(getMfaFlow(f.ctx)?.startedMethods, []);
  });

  test('does not accept a proof when its challenge changed during verification', async ({
    assert,
  }) => {
    const f = fixture();
    f.methods.whatsapp = {
      async isEnabled() {
        return true;
      },
      async describe() {
        return { label: 'WhatsApp' };
      },
      async verify() {
        f.initialize();
        return true;
      },
    };
    await assert.rejects(() => verifyCustomMfa(f.ctx, 'whatsapp'), /challenge/);
    assert.deepEqual(getMfaFlow(f.ctx)?.completed, []);
  });

  test('strips private descriptor values and rejects unsupported form fields', async ({
    assert,
  }) => {
    const f = fixture();
    f.methods.whatsapp = {
      async isEnabled() {
        return true;
      },
      async describe() {
        return {
          label: 'WhatsApp',
          secret: 'hidden-key',
          fields: [{ name: 'code', label: 'Code', token: 'hidden-token' }],
        };
      },
      async verify() {
        return true;
      },
    };
    const view = await customMfaViewProps(f.ctx);
    assert.notInclude(JSON.stringify(view), 'hidden');
    f.methods.whatsapp.describe = async () => ({
      label: 'WhatsApp',
      fields: [{ name: 'code', label: 'Code', type: 'email' as 'text' }],
    });
    await assert.rejects(() => customMfaViewProps(f.ctx), /fields/);
  });
});
