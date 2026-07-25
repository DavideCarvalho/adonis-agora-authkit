import { test } from '@japa/runner';
import { resolveRateLimit } from '../../src/define_config.js';
import { __setLimiterLoaderForTests, createAuthThrottles } from '../../src/host/rate_limit.js';

/**
 * Tela amigável de throttle (`withFriendly429` + view `throttled`): os throttles
 * de BROWSER (`login`, `sudo`, `otpLogin`) trocam o 429 cru do limiter pela tela
 * themeável, com `Retry-After` e link de volta pro passo atual. APIs
 * (`introspection`/`adminIp`) NÃO passam pelo wrapper — lá o 429 cru é contrato.
 */

/** Limiter fake cujo middleware SEMPRE lança o erro de throttle do limiter real. */
function throwingLimiter() {
  return {
    allowRequests(points: number) {
      const chain: any = {
        points,
        every() {
          return chain;
        },
        store() {
          return chain;
        },
        usingKey() {
          return chain;
        },
      };
      return chain;
    },
    define() {
      return async () => {
        const err: any = new Error('Too many requests');
        err.code = 'E_TOO_MANY_REQUESTS';
        err.status = 429;
        err.response = { availableIn: 42 };
        throw err;
      };
    },
  };
}

/** ctx fake com o mínimo que o wrapper toca: container, request e response. */
function fakeCtx(uid?: string) {
  const state: {
    status?: number;
    headers: Record<string, string>;
    sent?: unknown;
    render?: { view: string; props: Record<string, unknown> };
  } = { headers: {} };
  const ctx: any = {
    containerResolver: {
      make: async () => ({
        config: {
          branding: undefined,
          render: async (_ctx: unknown, view: string, props: Record<string, unknown>) => {
            state.render = { view, props };
            return `<html>${view}</html>`;
          },
        },
      }),
    },
    request: {
      param: (name: string) => (name === 'uid' ? uid : undefined),
      url: () => '/conta/confirmar',
      ip: () => '1.2.3.4',
    },
    response: {
      hasLazyBody: false,
      status(s: number) {
        state.status = s;
        return this;
      },
      header(name: string, value: string) {
        state.headers[name] = value;
        return this;
      },
      send(body: unknown) {
        state.sent = body;
      },
    },
  };
  return { ctx, state };
}

test.group('withFriendly429 — tela throttled', (group) => {
  group.each.teardown(() => __setLimiterLoaderForTests(undefined));

  test('429 vira a view throttled com Retry-After e link pro passo atual', async ({ assert }) => {
    __setLimiterLoaderForTests(async () => throwingLimiter());
    const throttles = createAuthThrottles(resolveRateLimit({ enabled: true }))!;
    const { ctx, state } = fakeCtx('uid-1');

    let nextCalled = false;
    await throttles.login(ctx, async () => {
      nextCalled = true;
    });

    assert.isFalse(nextCalled, 'next não deve ser chamado quando throttled');
    assert.equal(state.status, 429);
    assert.equal(state.headers['Retry-After'], '42');
    assert.deepEqual(state.render?.view, 'throttled');
    assert.deepEqual(state.render?.props.retryAfter, 42);
    // Com uid na rota, o retry aponta pra RAIZ da interaction (GET navegável) —
    // a URL do POST (/magic, /otp-verify) não é recarregável.
    assert.deepEqual(state.render?.props.retryUrl, '/auth/interaction/uid-1');
    assert.equal(state.sent, '<html>throttled</html>');
  });

  test('sem uid na rota, o retry aponta pra própria URL (telas GET, ex.: sudo)', async ({
    assert,
  }) => {
    __setLimiterLoaderForTests(async () => throwingLimiter());
    const throttles = createAuthThrottles(resolveRateLimit({ enabled: true }))!;
    const { ctx, state } = fakeCtx(undefined);

    await throttles.sudo(ctx, async () => {});
    assert.deepEqual(state.render?.props.retryUrl, '/conta/confirmar');
  });

  test('erro que NÃO é de throttle é relançado (não vira tela)', async ({ assert }) => {
    __setLimiterLoaderForTests(async () => ({
      allowRequests: () => ({ every: () => ({ store: () => ({ usingKey: () => ({}) }) }) }),
      define: () => async () => {
        throw new Error('falha qualquer');
      },
    }));
    const throttles = createAuthThrottles(resolveRateLimit({ enabled: true }))!;
    const { ctx, state } = fakeCtx('uid-1');

    await assert.rejects(() => throttles.login(ctx, async () => {}), /falha qualquer/);
    assert.isUndefined(state.render);
  });

  test('sem renderer configurado, o 429 cru é relançado (comportamento anterior)', async ({
    assert,
  }) => {
    __setLimiterLoaderForTests(async () => throwingLimiter());
    const throttles = createAuthThrottles(resolveRateLimit({ enabled: true }))!;
    const { ctx } = fakeCtx('uid-1');
    // Sobrescreve o container pra config SEM render.
    ctx.containerResolver = { make: async () => ({ config: { branding: undefined } }) };

    await assert.rejects(() => throttles.login(ctx, async () => {}), /Too many requests/);
  });
});
