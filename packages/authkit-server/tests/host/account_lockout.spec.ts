import { test } from '@japa/runner';
import type { AuditEvent, AuditSink } from '../../src/audit/audit_sink.js';
import { type ResolvedLockoutConfig, resolveLockout } from '../../src/define_config.js';
import {
  __setLockoutLimiterLoaderForTests,
  AccountLockout,
  computeLockoutSec,
  createAccountLockout,
} from '../../src/host/account_lockout.js';

/**
 * Stub in-memory do `@adonisjs/limiter` cobrindo SÓ a superfície que o
 * `account_lockout` usa: `use(opts)` / `use(store, opts)` → instância com
 * `increment`, `delete`, `isBlocked`, `availableIn`, `block`, `get`.
 *
 * O backoff temporal é checado pela função pura `computeLockoutSec`, então o
 * stub trata "block" só como um booleano + retryAfter declarado (sem clock real):
 * isso evita flakiness de timing — não dependemos de relógio/expiração.
 */
function makeLimiterStub() {
  // contadores compartilhados por chave (todas as instâncias `use` veem o mesmo mapa)
  const counters = new Map<string, number>();
  const blocks = new Map<string, number>(); // key -> retryAfterSec

  function instance() {
    return {
      async increment(key: string) {
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return { limit: 0, remaining: 0, consumed: next, availableIn: 0 };
      },
      async get(key: string) {
        const consumed = counters.get(key) ?? 0;
        return { limit: 0, remaining: 0, consumed, availableIn: 0 };
      },
      async delete(key: string) {
        // mirror do limiter real: delete reseta TODO o estado da chave (contagem + block)
        counters.delete(key);
        blocks.delete(key);
        return true;
      },
      async block(key: string, duration: number) {
        blocks.set(key, duration);
        return { limit: 1, remaining: 0, consumed: 1, availableIn: duration };
      },
      async isBlocked(key: string) {
        return blocks.has(key);
      },
      async availableIn(key: string) {
        return blocks.get(key) ?? 0;
      },
    };
  }

  return {
    use(_storeOrOpts: unknown, _maybeOpts?: unknown) {
      return instance();
    },
    // helpers de inspeção do teste
    _counters: counters,
    _blocks: blocks,
  };
}

function cfg(overrides: Partial<ResolvedLockoutConfig> = {}): ResolvedLockoutConfig {
  return { ...resolveLockout(), ...overrides };
}

test.group('account_lockout — computeLockoutSec (puro)', () => {
  test('backoff progressivo dobra por lock e respeita o teto', ({ assert }) => {
    const c = cfg({ baseLockoutSec: 60, maxLockoutSec: 3600 });
    assert.equal(computeLockoutSec(1, c), 60); // base
    assert.equal(computeLockoutSec(2, c), 120); // 2º lock > 1º
    assert.equal(computeLockoutSec(3, c), 240);
    assert.equal(computeLockoutSec(4, c), 480);
    // cresce até bater no teto
    assert.equal(computeLockoutSec(10, c), 3600);
    // o 2º lock SEMPRE > o 1º
    assert.isAbove(computeLockoutSec(2, c), computeLockoutSec(1, c));
  });

  test('lockCount < 1 é tratado como 1', ({ assert }) => {
    const c = cfg({ baseLockoutSec: 30 });
    assert.equal(computeLockoutSec(0, c), 30);
  });
});

test.group('account_lockout — fail-safe sem limiter', (group) => {
  group.each.setup(() => {
    __setLockoutLimiterLoaderForTests(() => Promise.resolve(null));
    return () => __setLockoutLimiterLoaderForTests(undefined);
  });

  test('todos os métodos são no-op e isLocked retorna { locked: false }', async ({ assert }) => {
    const lock = createAccountLockout(cfg());
    await lock.recordFailure('a@b.com');
    await lock.clearFailures('a@b.com');
    assert.deepEqual(await lock.isLocked('a@b.com'), { locked: false });
  });
});

test.group('account_lockout — desligado por config', (group) => {
  group.each.setup(() => {
    // mesmo com limiter presente, enabled:false vira no-op.
    __setLockoutLimiterLoaderForTests(() => Promise.resolve(makeLimiterStub()));
    return () => __setLockoutLimiterLoaderForTests(undefined);
  });

  test('enabled:false não bloqueia', async ({ assert }) => {
    const lock = createAccountLockout(cfg({ enabled: false, maxAttempts: 2 }));
    await lock.recordFailure('a@b.com');
    await lock.recordFailure('a@b.com');
    await lock.recordFailure('a@b.com');
    assert.deepEqual(await lock.isLocked('a@b.com'), { locked: false });
  });
});

test.group('account_lockout — com limiter stub', (group) => {
  let stub: ReturnType<typeof makeLimiterStub>;

  group.each.setup(() => {
    stub = makeLimiterStub();
    __setLockoutLimiterLoaderForTests(() => Promise.resolve(stub));
    return () => __setLockoutLimiterLoaderForTests(undefined);
  });

  test('bloqueia após maxAttempts falhas e expõe retryAfter', async ({ assert }) => {
    const lock = createAccountLockout(cfg({ maxAttempts: 3, baseLockoutSec: 60 }));
    assert.deepEqual(await lock.isLocked('User@Example.com'), { locked: false });
    await lock.recordFailure('User@Example.com');
    await lock.recordFailure('User@Example.com');
    assert.isFalse((await lock.isLocked('User@Example.com')).locked);
    await lock.recordFailure('User@Example.com'); // 3ª falha = cruza o teto
    const state = await lock.isLocked('User@Example.com');
    assert.isTrue(state.locked);
    assert.equal(state.retryAfterSec, 60);
  });

  test('email é normalizado (case/trim) para a mesma chave', async ({ assert }) => {
    const lock = createAccountLockout(cfg({ maxAttempts: 2 }));
    await lock.recordFailure('  Foo@Bar.com ');
    await lock.recordFailure('foo@bar.com');
    assert.isTrue((await lock.isLocked('FOO@BAR.COM')).locked);
  });

  test('clearFailures destrava e zera o contador', async ({ assert }) => {
    const lock = createAccountLockout(cfg({ maxAttempts: 2 }));
    await lock.recordFailure('a@b.com');
    await lock.recordFailure('a@b.com');
    assert.isTrue((await lock.isLocked('a@b.com')).locked);
    await lock.clearFailures('a@b.com');
    assert.deepEqual(await lock.isLocked('a@b.com'), { locked: false });
    // contador de falhas zerado
    assert.isFalse(stub._counters.has('authkit_lockout_fail:a@b.com'));
  });

  test('audita account.locked UMA vez na transição (não a cada bloqueio)', async ({ assert }) => {
    const events: AuditEvent[] = [];
    const sink: AuditSink = {
      record: async (e) => {
        events.push(e);
      },
    };
    const lock = createAccountLockout(cfg({ maxAttempts: 2, baseLockoutSec: 60 }));

    await lock.recordFailure('a@b.com', { sink, ip: '1.2.3.4' });
    await lock.recordFailure('a@b.com', { sink, ip: '1.2.3.4' }); // cruza o teto → lock
    // tentativa adicional já bloqueada NÃO reemite account.locked
    await lock.recordFailure('a@b.com', { sink, ip: '1.2.3.4' });

    const locked = events.filter((e) => e.type === 'account.locked');
    assert.lengthOf(locked, 1);
    assert.equal(locked[0].email, 'a@b.com');
    assert.equal(locked[0].ip, '1.2.3.4');
    assert.equal((locked[0].metadata as any).lockCount, 1);
    assert.equal((locked[0].metadata as any).lockoutSec, 60);
  });

  test('lock progressivo: o 2º lock dura mais que o 1º', async ({ assert }) => {
    const lock = new AccountLockout(
      cfg({ maxAttempts: 1, baseLockoutSec: 60, maxLockoutSec: 3600 }),
    );
    // 1º lock
    await lock.recordFailure('a@b.com');
    const first = await lock.isLocked('a@b.com');
    assert.equal(first.retryAfterSec, 60);
    // destrava e força um 2º lock — a contagem de locks persiste (countStore)
    await lock.clearFailures('a@b.com');
    await lock.recordFailure('a@b.com');
    const second = await lock.isLocked('a@b.com');
    assert.equal(second.retryAfterSec, 120);
    assert.isAbove(second.retryAfterSec!, first.retryAfterSec!);
  });
});
