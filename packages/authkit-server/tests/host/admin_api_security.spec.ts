import { test } from '@japa/runner';
import { resolveRateLimit } from '../../src/define_config.js';
import { adminApiGuard, adminKeyId } from '../../src/host/admin_api/admin_api_guard.js';
import { __setLimiterLoaderForTests, createAuthThrottles } from '../../src/host/rate_limit.js';

/**
 * Limiter fake mínimo: captura a `key` (`usingKey`) escolhida por cada request e
 * "bloqueia" depois de `bucket.points` chamadas no MESMO bucket (key). Reproduz o
 * suficiente do `@adonisjs/limiter` para validar o KEYING do throttle (M8) sem o
 * peer real.
 */
function fakeLimiter() {
  const counts = new Map<string, number>();
  const calls: { name: string; key: string | undefined }[] = [];
  const limiter = {
    allowRequests(points: number) {
      const chain: any = {
        points,
        _store: undefined as string | undefined,
        _key: undefined as string | undefined,
        every(_d: string) {
          return chain;
        },
        store(s: string) {
          chain._store = s;
          return chain;
        },
        usingKey(k: string) {
          chain._key = k;
          return chain;
        },
      };
      return chain;
    },
    define(name: string, fn: (ctx: any) => any) {
      // Retorna o middleware: resolve a chain por request, conta por key, e
      // "limita" (não chama next) quando estourar os pontos do bucket.
      return async (ctx: any, next: () => Promise<void>) => {
        const chain = fn(ctx);
        const key = chain._key;
        calls.push({ name, key });
        const bucketKey = `${name}:${key ?? '∅'}`;
        const used = (counts.get(bucketKey) ?? 0) + 1;
        counts.set(bucketKey, used);
        if (used > chain.points) {
          ctx.__throttled = true;
          return; // bloqueia: NÃO chama next
        }
        return next();
      };
    },
  };
  return { limiter, calls };
}

test.group('M8 — throttle admin-api por IP', (group) => {
  group.each.teardown(() => {
    __setLimiterLoaderForTests(undefined);
  });

  test('throttle adminIp é keyed por IP (não pelo token)', async ({ assert }) => {
    const { limiter, calls } = fakeLimiter();
    __setLimiterLoaderForTests(async () => limiter);

    const throttles = createAuthThrottles(resolveRateLimit({ enabled: true }))!;
    assert.isFunction(throttles.adminIp);

    const ctx = (ip: string, token: string) =>
      ({
        request: { ip: () => ip, header: () => `Bearer ${token}` },
      }) as any;

    // Duas keys (tokens) DIFERENTES vindas do MESMO IP devem cair na MESMA key.
    await throttles.adminIp(ctx('9.9.9.9', 'tokenA'), async () => {});
    await throttles.adminIp(ctx('9.9.9.9', 'tokenB'), async () => {});

    const adminCalls = calls.filter((c) => c.name === 'authkit_admin_ip');
    assert.lengthOf(adminCalls, 2);
    assert.deepEqual(adminCalls[0].key, 'admin-ip:9.9.9.9');
    assert.deepEqual(adminCalls[1].key, 'admin-ip:9.9.9.9'); // mesma key → mesmo bucket
  });

  test('múltiplas tentativas de bearer inválido do MESMO IP são limitadas', async ({ assert }) => {
    const { limiter } = fakeLimiter();
    __setLimiterLoaderForTests(async () => limiter);

    // Bucket pequeno para o teste: 3/min.
    const cfg = resolveRateLimit({ enabled: true });
    cfg.adminIp = { points: 3, duration: '1 min' };
    const throttles = createAuthThrottles(cfg)!;

    const makeCtx = (token: string) =>
      ({
        request: { ip: () => '7.7.7.7', header: () => `Bearer ${token}` },
        __throttled: false,
      }) as any;

    let allowed = 0;
    let blocked = 0;
    // 5 tentativas (cada uma com token inválido diferente) do mesmo IP.
    for (let i = 0; i < 5; i++) {
      const ctx = makeCtx(`invalid-${i}`);
      await throttles.adminIp(ctx, async () => {
        allowed++;
      });
      if (ctx.__throttled) blocked++;
    }
    // As primeiras 3 passam; as 2 seguintes são limitadas (apesar de tokens distintos).
    assert.equal(allowed, 3);
    assert.equal(blocked, 2);
  });
});

test.group('M9 — id NÃO-SENSÍVEL da API key', () => {
  test('adminKeyId deriva um prefixo de hash estável, sem vazar a key', ({ assert }) => {
    const key = 'super-secret-admin-api-key-with-high-entropy';
    const id = adminKeyId(key);
    assert.match(id, /^admin-key:[0-9a-f]{8}$/);
    // Estável: mesma key → mesmo id.
    assert.equal(adminKeyId(key), id);
    // Não contém a key (nem um pedaço dela).
    assert.notInclude(id, key);
    assert.notInclude(id, key.slice(0, 8));
  });

  test('adminApiGuard anexa ctx.adminApiKeyId com o id da key que casou', async ({ assert }) => {
    const cfg = { adminApi: { enabled: true, apiKeys: ['keyA', 'keyB'] } };
    const ctx: any = {
      request: { header: () => 'Bearer keyB' },
      response: { notFound: () => {}, unauthorized: () => {} },
      containerResolver: { make: async () => ({ config: cfg }) },
    };
    let nexted = false;
    await adminApiGuard(ctx, async () => {
      nexted = true;
    });
    assert.isTrue(nexted);
    assert.equal(ctx.adminApiKeyId, adminKeyId('keyB'));
  });

  test('adminApiGuard com key inválida → 401 e sem adminApiKeyId', async ({ assert }) => {
    const cfg = { adminApi: { enabled: true, apiKeys: ['keyA'] } };
    let status = 0;
    const ctx: any = {
      request: { header: () => 'Bearer wrong' },
      response: { notFound: () => (status = 404), unauthorized: () => (status = 401) },
      containerResolver: { make: async () => ({ config: cfg }) },
    };
    await adminApiGuard(ctx, async () => {});
    assert.equal(status, 401);
    assert.isUndefined(ctx.adminApiKeyId);
  });
});

test.group('throttle agentToken (endpoints OAuth de agentes) por IP', (group) => {
  group.each.teardown(() => {
    __setLimiterLoaderForTests(undefined);
  });

  test('default 120/min, keyed por IP em bucket próprio', async ({ assert }) => {
    const { limiter, calls } = fakeLimiter();
    __setLimiterLoaderForTests(async () => limiter);
    const cfg = resolveRateLimit({ enabled: true });
    assert.deepEqual(cfg.agentToken, { points: 120, duration: '1 min' });
    const throttles = createAuthThrottles(cfg)!;

    const ctx = (ip: string) => ({ request: { ip: () => ip, header: () => undefined } }) as any;
    await throttles.agentToken(ctx('1.1.1.1'), async () => {});
    await throttles.agentToken(ctx('2.2.2.2'), async () => {});
    assert.deepEqual(
      calls.map((c) => [c.name, c.key]),
      [
        ['authkit_agent_token', 'agent-token-ip:1.1.1.1'],
        ['authkit_agent_token', 'agent-token-ip:2.2.2.2'],
      ],
    );
  });

  test('estoura por IP independentemente do client/identificador', async ({ assert }) => {
    const { limiter } = fakeLimiter();
    __setLimiterLoaderForTests(async () => limiter);
    const cfg = resolveRateLimit({ enabled: true });
    cfg.agentToken = { points: 2, duration: '1 min' };
    const throttles = createAuthThrottles(cfg)!;
    let allowed = 0;
    let blocked = 0;
    for (let i = 0; i < 4; i++) {
      const ctx = { request: { ip: () => '5.5.5.5', header: () => undefined } } as any;
      await throttles.agentToken(ctx, async () => {
        allowed++;
      });
      if (ctx.__throttled) blocked++;
    }
    assert.equal(allowed, 2);
    assert.equal(blocked, 2);
  });

  test('`enabled: false` → sem throttles', ({ assert }) => {
    assert.isUndefined(createAuthThrottles(resolveRateLimit({ enabled: false })));
  });
});
