/**
 * Plan 004 — password-reset / magic-link poisoning.
 *
 * `AuthRegistrationController#forgot` and `AuthInteractionController#magicLinkRequest`
 * used to build the emailed URL from `${ctx.request.protocol()}://${ctx.request.host()}`.
 * Both `protocol()` and `host()` reflect client-supplied headers (`Host` /
 * `X-Forwarded-Host`), so an attacker who can reach the server directly (no
 * `Host`-pinning load balancer in front) can forge the `Host` header on a
 * password-reset or magic-link request for a victim's email and get a genuine
 * email pointing at attacker-controlled infrastructure.
 *
 * These tests drive the real controllers (fake-ctx pattern, same style as
 * `account_status_gate.spec.ts` / `registration_toggles.spec.ts`) with a forged
 * `Host` different from the configured `issuer`, and assert the emitted URL is
 * anchored to the issuer origin, never the forged host.
 *
 * MUTATION PROOF (Step 5 of the plan, done manually — see report): reverting
 * either conversion back to `${ctx.request.protocol()}://${ctx.request.host()}`
 * turns the corresponding "forged host" test red.
 */

import { test } from '@japa/runner';
import { resolveLogin, resolvePasswordless } from '../../src/define_config.js';
import AuthInteractionController from '../../src/host/controllers/interaction_controller.js';
import AuthRegistrationController from '../../src/host/controllers/registration_controller.js';

const REAL_ISSUER = 'https://real-issuer.test';
const FORGED_HOST = 'evil.attacker.test';
const SESSION_KEY = 'authkit_login_email';

function noTableDb() {
  return {
    from() {
      return (this as any).table();
    },
    table() {
      throw new Error('no table');
    },
  };
}

/** Minimal fake ctx shared by both flows below. `overrides` layers request-level fakes. */
function fakeCtx(
  service: any,
  session: Record<string, unknown> = {},
  overrides: Record<string, any> = {},
) {
  return {
    containerResolver: {
      make: async (key: string) => {
        if (key === 'authkit.server') return service;
        if (key === 'lucid.db') return noTableDb();
        throw new Error(`unknown: ${key}`);
      },
    },
    request: {
      csrfToken: 'csrf',
      param: (_k: string) => 'test-uid',
      only: () => ({}),
      input: (_k: string, def?: any) => def,
      qs: () => ({}),
      ip: () => '1.2.3.4',
      header: () => undefined,
      // The forgery: a client can set these to whatever it wants.
      protocol: () => 'https',
      host: () => FORGED_HOST,
      validateUsing: async (validator: any) =>
        validator.validate({ email: 'victim@example.com' }, { meta: {} }),
      ...overrides,
    },
    session: {
      get: (k: string) => session[k],
      put: (k: string, v: unknown) => {
        session[k] = v;
      },
      forget: (k: string) => {
        delete session[k];
      },
    },
    response: { redirect: (_url: string) => undefined },
  } as any;
}

// ---------------------------------------------------------------------------
// Case 1: password-reset request (AuthRegistrationController#forgot)
// ---------------------------------------------------------------------------

function buildRegistrationService(opts: { issuer?: string; mailOrigin?: string } = {}) {
  const captured: { resetUrl?: string } = {};
  const store: any = {
    issuePasswordResetToken: async (_email: string) => ({ token: 'reset-tok-1' }),
  };
  const config: any = {
    issuer: opts.issuer ?? REAL_ISSUER,
    render: async (_ctx: any, view: string, props: any) => ({ view, props }),
    messages: {},
    branding: {
      default: { appName: 'Acme', logoUrl: null },
      clients: {},
      firstParty: [],
      company: undefined,
    },
    botProtection: undefined,
    passwordless: resolvePasswordless({ magicLink: false }),
    registration: { enabled: true },
    social: undefined,
    authMethods: undefined,
    accountStore: store,
    audit: { record: async () => {} },
    mail: {
      ...(opts.mailOrigin ? { origin: opts.mailOrigin } : {}),
      onPasswordReset: async (data: { resetUrl: string }) => {
        captured.resetUrl = data.resetUrl;
      },
    },
  };
  return {
    service: { config, interactions: { details: async () => ({ uid: 'test-uid', params: {} }) } },
    captured,
  };
}

test.group('issuer-based email links — password reset (forgot)', () => {
  test('forged Host header does NOT leak into resetUrl; issuer origin does', async ({ assert }) => {
    const { service, captured } = buildRegistrationService();
    const ctx = fakeCtx(service, {}, { protocol: () => 'https', host: () => FORGED_HOST });

    const ctrl = new AuthRegistrationController();
    await ctrl.forgot(ctx);

    assert.isDefined(captured.resetUrl);
    assert.notInclude(captured.resetUrl!, FORGED_HOST, 'must not leak the forged Host header');
    assert.isTrue(
      captured.resetUrl!.startsWith(`${REAL_ISSUER}/auth/reset-password?token=`),
      `expected resetUrl to be anchored at the issuer origin, got: ${captured.resetUrl}`,
    );
  });

  test('no forged header (request host === issuer host): URL unchanged from today’s output', async ({
    assert,
  }) => {
    const { service, captured } = buildRegistrationService();
    // Request host matches the issuer's own host — the normal, non-adversarial case.
    const ctx = fakeCtx(service, {}, { protocol: () => 'https', host: () => 'real-issuer.test' });

    const ctrl = new AuthRegistrationController();
    await ctrl.forgot(ctx);

    assert.equal(captured.resetUrl, `${REAL_ISSUER}/auth/reset-password?token=reset-tok-1`);
  });

  test('mail.origin escape hatch overrides the issuer origin when configured', async ({
    assert,
  }) => {
    const override = 'https://mail-facing.example.org';
    const { service, captured } = buildRegistrationService({ mailOrigin: override });
    const ctx = fakeCtx(service, {}, { protocol: () => 'https', host: () => FORGED_HOST });

    const ctrl = new AuthRegistrationController();
    await ctrl.forgot(ctx);

    assert.isTrue(captured.resetUrl!.startsWith(`${override}/auth/reset-password?token=`));
  });
});

// ---------------------------------------------------------------------------
// Case 2: magic-link request (AuthInteractionController#magicLinkRequest)
// ---------------------------------------------------------------------------

function buildInteractionService(opts: { issuer?: string } = {}) {
  const captured: { magicUrl?: string } = {};
  const account = { id: 'acc-1', email: 'victim@example.com' };
  const store: any = {
    issueMagicLinkToken: async (_email: string) => ({ token: 'magic-tok-1', account }),
  };
  const config: any = {
    issuer: opts.issuer ?? REAL_ISSUER,
    render: async (_ctx: any, view: string, props: any) => ({ view, props }),
    messages: {},
    branding: {
      default: { appName: 'Acme', logoUrl: null },
      clients: {},
      firstParty: [],
      company: undefined,
    },
    passwordless: resolvePasswordless({ magicLink: true }),
    login: resolveLogin({ otp: { enabled: false } }),
    social: undefined,
    authMethods: undefined,
    accountStore: store,
    audit: { record: async () => {} },
    mail: {
      onMagicLink: async (data: { magicUrl: string }) => {
        captured.magicUrl = data.magicUrl;
      },
    },
  };
  return {
    service: { config, interactions: { details: async () => ({ uid: 'test-uid', params: {} }) } },
    captured,
  };
}

test.group('issuer-based email links — magic link (magicLinkRequest)', () => {
  test('forged Host header does NOT leak into magicUrl; issuer origin does', async ({ assert }) => {
    const { service, captured } = buildInteractionService();
    const ctx = fakeCtx(
      service,
      { [SESSION_KEY]: 'victim@example.com' },
      { protocol: () => 'https', host: () => FORGED_HOST },
    );

    const ctrl = new AuthInteractionController();
    await ctrl.magicLinkRequest(ctx);

    assert.isDefined(captured.magicUrl);
    assert.notInclude(captured.magicUrl!, FORGED_HOST, 'must not leak the forged Host header');
    assert.isTrue(
      captured.magicUrl!.startsWith(`${REAL_ISSUER}/auth/interaction/test-uid/magic?token=`),
      `expected magicUrl to be anchored at the issuer origin, got: ${captured.magicUrl}`,
    );
  });

  test('no forged header (request host === issuer host): URL unchanged from today’s output', async ({
    assert,
  }) => {
    const { service, captured } = buildInteractionService();
    const ctx = fakeCtx(
      service,
      { [SESSION_KEY]: 'victim@example.com' },
      { protocol: () => 'https', host: () => 'real-issuer.test' },
    );

    const ctrl = new AuthInteractionController();
    await ctrl.magicLinkRequest(ctx);

    assert.equal(
      captured.magicUrl,
      `${REAL_ISSUER}/auth/interaction/test-uid/magic?token=magic-tok-1`,
    );
  });
});
