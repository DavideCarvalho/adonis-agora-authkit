/**
 * O wildcard `${mount}/*` do provider OIDC: throttle por IP SÓ nos POSTs de máquina
 * (token, registro, device, PAR, revogação, introspecção), com os paths lidos do
 * provider real. authorize, userinfo, JWKS e discovery nunca passam pelo limiter.
 */
import { test } from '@japa/runner';
import * as oidc from 'oidc-provider';
import { resolveRateLimit } from '../../src/define_config.js';
import { oidcMachinePaths, oidcMachineThrottle } from '../../src/host/oidc_endpoint_throttle.js';
import { __setLimiterLoaderForTests, createAuthThrottles } from '../../src/host/rate_limit.js';

/** Limiter fake: conta por (bucket, key) e LANÇA o 429 do `@adonisjs/limiter` ao estourar. */
function fakeLimiter() {
  const counts = new Map<string, number>();
  const hits: string[] = [];
  return {
    hits,
    limiter: {
      allowRequests(points: number) {
        const chain: any = {
          points,
          every: () => chain,
          store: () => chain,
          usingKey: (k: string) => {
            chain.key = k;
            return chain;
          },
        };
        return chain;
      },
      define(name: string, fn: (ctx: any) => any) {
        return async (ctx: any, next: () => Promise<void>) => {
          const chain = fn(ctx);
          hits.push(`${name} ${chain.key}`);
          const id = `${name}:${chain.key}`;
          const used = (counts.get(id) ?? 0) + 1;
          counts.set(id, used);
          if (used > chain.points) {
            throw Object.assign(new Error('Too many requests'), {
              code: 'E_TOO_MANY_REQUESTS',
              status: 429,
            });
          }
          return next();
        };
      },
    },
  };
}

function buildProvider(routes?: Record<string, string>) {
  return new oidc.Provider('https://idp.test/oidc', {
    ...(routes ? { routes } : {}),
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true },
      deviceFlow: { enabled: true },
      revocation: { enabled: true },
      introspection: { enabled: true },
      pushedAuthorizationRequests: { enabled: true },
      userinfo: { enabled: true },
    },
  });
}

function ctxFor(provider: unknown, method: string, url: string, ip = '198.51.100.9') {
  return {
    request: { method: () => method, url: () => url, ip: () => ip, header: () => undefined },
    containerResolver: { make: async () => ({ provider }) },
  } as any;
}

test.group('throttle dos POSTs de máquina do provider OIDC', (group) => {
  group.each.teardown(() => __setLimiterLoaderForTests(undefined));

  test('os paths saem do provider (mount do issuer, features ligadas)', ({ assert }) => {
    const paths = oidcMachinePaths(buildProvider());
    assert.sameMembers(
      [...paths],
      [
        '/oidc/token',
        '/oidc/reg',
        '/oidc/device/auth',
        '/oidc/request',
        '/oidc/token/revocation',
        '/oidc/token/introspection',
      ],
    );
  });

  test('respeita `routes` customizado e ignora feature desligada', ({ assert }) => {
    const custom = oidcMachinePaths(buildProvider({ token: '/oauth2/token' }));
    assert.isTrue(custom.has('/oidc/oauth2/token'));
    assert.isFalse(custom.has('/oidc/token'));
    const minimal = oidcMachinePaths(
      new oidc.Provider('https://idp.test/oidc', {
        features: { devInteractions: { enabled: false } },
      }),
    );
    assert.isFalse(minimal.has('/oidc/reg'));
    assert.isTrue(minimal.has('/oidc/token'));
  });

  test('cada POST de máquina recebe 429 ao passar do limite, por IP', async ({ assert }) => {
    const { limiter } = fakeLimiter();
    __setLimiterLoaderForTests(async () => limiter);
    const cfg = resolveRateLimit(undefined);
    assert.deepEqual(cfg.oidcToken, { points: 120, duration: '1 min' });
    cfg.oidcToken = { points: 2, duration: '1 min' };
    const throttle = oidcMachineThrottle(createAuthThrottles(cfg)!.oidcToken);
    const provider = buildProvider();

    for (const path of oidcMachinePaths(provider)) {
      const ip = `ip-${path}`;
      let passed = 0;
      for (let i = 0; i < 2; i++) {
        await throttle(ctxFor(provider, 'POST', path, ip), async () => {
          passed++;
        });
      }
      assert.equal(passed, 2, path);
      const error = await throttle(ctxFor(provider, 'POST', path, ip), async () => {}).then(
        () => null,
        (e) => e,
      );
      assert.equal(error?.status, 429, `esperava 429 em ${path}`);
    }
    // Outro IP tem o próprio orçamento.
    let other = false;
    await throttle(ctxFor(provider, 'POST', '/oidc/token', '203.0.113.1'), async () => {
      other = true;
    });
    assert.isTrue(other);
  });

  test('authorize, userinfo, JWKS, discovery e GETs nunca passam pelo limiter', async ({
    assert,
  }) => {
    const { limiter, hits } = fakeLimiter();
    __setLimiterLoaderForTests(async () => limiter);
    const cfg = resolveRateLimit(undefined);
    cfg.oidcToken = { points: 1, duration: '1 min' };
    const throttle = oidcMachineThrottle(createAuthThrottles(cfg)!.oidcToken);
    const provider = buildProvider();

    const untouched: Array<[string, string]> = [
      ['GET', '/oidc/auth'],
      ['POST', '/oidc/auth'],
      ['GET', '/oidc/me'],
      ['POST', '/oidc/me'],
      ['GET', '/oidc/jwks'],
      ['GET', '/oidc/.well-known/openid-configuration'],
      ['GET', '/oidc/token'],
      ['POST', '/oidc/session/end/confirm'],
      ['POST', '/oidc/device'],
    ];
    for (const [method, url] of untouched) {
      let passed = 0;
      for (let i = 0; i < 5; i++) {
        await throttle(ctxFor(provider, method, url), async () => {
          passed++;
        });
      }
      assert.equal(passed, 5, `${method} ${url}`);
    }
    assert.lengthOf(hits, 0);
  });

  test('o wildcard só ganha o middleware com rate limit ligado', async ({ assert }) => {
    const { registerAuthHost } = await import('../../src/host/register_auth_host.js');
    const wildcardMiddleware = (enabled: boolean) => {
      const used: unknown[] = [];
      const chain: any = {
        as: () => chain,
        use: (m: unknown[]) => {
          used.push(...m);
          return chain;
        },
        middleware: () => chain,
        prefix: () => chain,
      };
      let wildcard: unknown[] | null = null;
      const route = (pattern: string) => {
        if (pattern === '/oidc/*') {
          const own: any = {
            as: () => own,
            use: (m: unknown[]) => {
              wildcard = [...(wildcard ?? []), ...m];
              return own;
            },
          };
          wildcard = [];
          return own;
        }
        return chain;
      };
      const router: any = {
        get: route,
        post: route,
        put: route,
        patch: route,
        delete: route,
        any: route,
        group: (cb: () => void) => {
          cb();
          return chain;
        },
      };
      registerAuthHost(router, { mountPath: '/oidc', rateLimit: { enabled } });
      return wildcard as unknown[] | null;
    };
    assert.lengthOf(wildcardMiddleware(true)!, 1);
    assert.lengthOf(wildcardMiddleware(false)!, 0);
  });
});
