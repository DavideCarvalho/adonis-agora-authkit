import { test } from '@japa/runner';
import type { AccountStore, AuthAccount } from '../../src/accounts/account_store.js';
import type { AuditEvent, AuditSink } from '../../src/audit/audit_sink.js';
import type { ResolvedLockoutConfig, ResolvedServerConfig } from '../../src/define_config.js';
import { __setLockoutLimiterLoaderForTests } from '../../src/host/account_lockout.js';
import { attemptPasswordLogin, isEmailUnverifiedBlock } from '../../src/host/login_attempt.js';
import { RuntimeSettings } from '../../src/host/runtime_settings.js';

/** Limiter stub in-memory (mesma superfície usada pelo account_lockout). */
function makeLimiterStub() {
  const counters = new Map<string, number>();
  const blocks = new Map<string, number>();
  function instance() {
    return {
      async increment(key: string) {
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return { consumed: next, availableIn: 0 };
      },
      async get(key: string) {
        return { consumed: counters.get(key) ?? 0, availableIn: 0 };
      },
      async delete(key: string) {
        counters.delete(key);
        blocks.delete(key);
        return true;
      },
      async block(key: string, duration: number) {
        blocks.set(key, duration);
        return { consumed: 1, availableIn: duration };
      },
      async isBlocked(key: string) {
        return blocks.has(key);
      },
      async availableIn(key: string) {
        return blocks.get(key) ?? 0;
      },
    };
  }
  return { use: () => instance(), _blocks: blocks };
}

const ACCOUNT: AuthAccount = { id: 'u1', email: 'a@b.com', globalRoles: [] };

/** Constrói uma ResolvedLockoutConfig diretamente para testes. */
function makeLockout(
  opts: { enabled?: boolean; maxAttempts?: number } = {},
): ResolvedLockoutConfig {
  return {
    enabled: opts.enabled ?? true,
    maxAttempts: opts.maxAttempts ?? 5,
    windowSec: 900,
    baseLockoutSec: 60,
    maxLockoutSec: 3600,
  };
}

/** Config mínima: só os campos que attemptPasswordLogin toca. */
function makeCfg(opts: {
  verify?: AccountStore['verifyCredentials'];
  audit?: AuditSink;
  lockoutEnabled?: boolean;
  maxAttempts?: number;
}): ResolvedServerConfig {
  const accountStore = {
    verifyCredentials:
      opts.verify ?? (async (email: string) => (email === ACCOUNT.email ? { ...ACCOUNT } : null)),
  } as unknown as AccountStore;
  return {
    accountStore,
    audit: opts.audit,
    lockout: makeLockout({
      enabled: opts.lockoutEnabled ?? true,
      maxAttempts: opts.maxAttempts ?? 5,
    }),
  } as unknown as ResolvedServerConfig;
}

test.group('attemptPasswordLogin', (group) => {
  let stub: ReturnType<typeof makeLimiterStub>;
  group.each.setup(() => {
    stub = makeLimiterStub();
    __setLockoutLimiterLoaderForTests(() => Promise.resolve(stub));
    return () => __setLockoutLimiterLoaderForTests(undefined);
  });

  test('no password posted → invalid credentials, the store is never asked', async ({ assert }) => {
    let asked = false;
    const cfg = makeCfg({
      verify: async () => {
        asked = true;
        return null;
      },
    });
    for (const password of [undefined, '', null]) {
      const res = await attemptPasswordLogin(cfg, {
        email: 'a@b.com',
        password: password as unknown as string,
        ip: null,
      });
      assert.deepEqual(res, { ok: false, locked: false });
    }
    assert.isFalse(asked);
  });

  test('sucesso devolve { ok: true, account } e limpa falhas', async ({ assert }) => {
    const cfg = makeCfg({});
    const res = await attemptPasswordLogin(cfg, {
      email: 'a@b.com',
      password: 'secret',
      ip: '1.2.3.4',
    });
    assert.isTrue(res.ok);
    if (res.ok) assert.equal(res.account.id, 'u1');
  });

  test('falha emite login.failure SEM clientId e devolve { ok: false, locked: false }', async ({
    assert,
  }) => {
    const events: AuditEvent[] = [];
    const sink: AuditSink = {
      record: async (e) => {
        events.push(e);
      },
    };
    const cfg = makeCfg({ audit: sink });

    // email desconhecido → verifyCredentials retorna null → falha
    const res = await attemptPasswordLogin(cfg, {
      email: 'nope@b.com',
      password: 'x',
      ip: '9.9.9.9',
    });
    assert.isFalse(res.ok);
    if (!res.ok) {
      assert.isFalse(res.locked);
    }
    const fail = events.find((e) => e.type === 'login.failure')!;
    assert.equal(fail.email, 'nope@b.com');
    assert.equal(fail.ip, '9.9.9.9');
    // SEM clientId no fluxo do console (não fornecido)
    assert.notProperty(fail, 'clientId');
  });

  test('falha emite login.failure COM clientId quando fornecido', async ({ assert }) => {
    const events: AuditEvent[] = [];
    const sink: AuditSink = {
      record: async (e) => {
        events.push(e);
      },
    };
    const cfg = makeCfg({ audit: sink });

    const res = await attemptPasswordLogin(cfg, {
      email: 'nope@b.com',
      password: 'x',
      ip: '9.9.9.9',
      clientId: 'app1',
    });
    assert.isFalse(res.ok);
    const fail = events.find((e) => e.type === 'login.failure')!;
    assert.equal(fail.clientId, 'app1');
  });

  test('falha com clientId null preserva clientId: null no evento', async ({ assert }) => {
    const events: AuditEvent[] = [];
    const sink: AuditSink = {
      record: async (e) => {
        events.push(e);
      },
    };
    const cfg = makeCfg({ audit: sink });

    await attemptPasswordLogin(cfg, {
      email: 'nope@b.com',
      password: 'x',
      ip: null,
      clientId: null,
    });
    const fail = events.find((e) => e.type === 'login.failure')!;
    assert.property(fail, 'clientId');
    assert.isNull(fail.clientId);
  });

  test('conta desabilitada: rejeita login com { disabled: true } e emite login.failure', async ({
    assert,
  }) => {
    const events: AuditEvent[] = [];
    const sink: AuditSink = {
      record: async (e) => {
        events.push(e);
      },
    };
    // accountStore com a capacidade de status: a conta a@b.com está desabilitada.
    const accountStore = {
      verifyCredentials: async (email: string) => (email === ACCOUNT.email ? { ...ACCOUNT } : null),
      disableAccount: async () => {},
      enableAccount: async () => {},
      isDisabled: async (id: string) => id === ACCOUNT.id,
    } as unknown as AccountStore;
    const cfg = {
      accountStore,
      audit: sink,
      lockout: makeLockout({ enabled: true, maxAttempts: 5 }),
    } as unknown as ResolvedServerConfig;

    const res = await attemptPasswordLogin(cfg, {
      email: 'a@b.com',
      password: 'secret',
      ip: '1.2.3.4',
    });
    assert.isFalse(res.ok);
    if (!res.ok) {
      assert.isFalse(res.locked);
      assert.isTrue(res.disabled);
    }
    const fail = events.find((e) => e.type === 'login.failure')!;
    assert.equal((fail.metadata as any)?.reason, 'disabled');
  });

  test('conta habilitada (isDisabled=false) faz login normalmente', async ({ assert }) => {
    const accountStore = {
      verifyCredentials: async (email: string) => (email === ACCOUNT.email ? { ...ACCOUNT } : null),
      disableAccount: async () => {},
      enableAccount: async () => {},
      isDisabled: async () => false,
    } as unknown as AccountStore;
    const cfg = {
      accountStore,
      lockout: makeLockout({ enabled: true, maxAttempts: 5 }),
    } as unknown as ResolvedServerConfig;
    const res = await attemptPasswordLogin(cfg, { email: 'a@b.com', password: 'secret', ip: null });
    assert.isTrue(res.ok);
  });

  test('e-mail não verificado + requireVerifiedEmail: rejeita com { unverified: true }', async ({
    assert,
  }) => {
    const events: AuditEvent[] = [];
    const sink: AuditSink = {
      record: async (e) => {
        events.push(e);
      },
    };
    const accountStore = {
      verifyCredentials: async (email: string) => (email === ACCOUNT.email ? { ...ACCOUNT } : null),
      isEmailVerified: async () => false,
    } as unknown as AccountStore;
    const cfg = {
      accountStore,
      audit: sink,
      lockout: makeLockout({ enabled: true, maxAttempts: 5 }),
      login: { requireVerifiedEmail: true },
    } as unknown as ResolvedServerConfig;

    const res = await attemptPasswordLogin(cfg, {
      email: 'a@b.com',
      password: 'secret',
      ip: '1.2.3.4',
    });
    assert.isFalse(res.ok);
    if (!res.ok) assert.isTrue(res.unverified);
    const fail = events.find((e) => e.type === 'login.failure')!;
    assert.equal((fail.metadata as any)?.reason, 'unverified');
  });

  test('e-mail verificado + requireVerifiedEmail: login normal', async ({ assert }) => {
    const accountStore = {
      verifyCredentials: async (email: string) => (email === ACCOUNT.email ? { ...ACCOUNT } : null),
      isEmailVerified: async () => true,
    } as unknown as AccountStore;
    const cfg = {
      accountStore,
      lockout: makeLockout({ enabled: true, maxAttempts: 5 }),
      login: { requireVerifiedEmail: true },
    } as unknown as ResolvedServerConfig;
    const res = await attemptPasswordLogin(cfg, { email: 'a@b.com', password: 'secret', ip: null });
    assert.isTrue(res.ok);
  });

  test('requireVerifiedEmail mas store SEM isEmailVerified: degrada (não bloqueia)', async ({
    assert,
  }) => {
    // Store sem a capability → a checagem é no-op (capability-probed).
    const cfg = makeCfg({});
    (cfg as any).login = { requireVerifiedEmail: true };
    const res = await attemptPasswordLogin(cfg, { email: 'a@b.com', password: 'secret', ip: null });
    assert.isTrue(res.ok);
  });

  // ---- require_verified_email via runtime settings ----

  test('runtime setting { require_verified_email: enabled: true } sobrescreve config false → bloqueia', async ({
    assert,
  }) => {
    // Config says requireVerifiedEmail: false, but runtime setting says true.
    const accountStore = {
      verifyCredentials: async (email: string) => (email === ACCOUNT.email ? { ...ACCOUNT } : null),
      isEmailVerified: async () => false,
    } as unknown as AccountStore;
    const cfg = {
      accountStore,
      audit: { record: async () => {} },
      lockout: makeLockout({ enabled: true, maxAttempts: 5 }),
      login: { requireVerifiedEmail: false }, // config OFF
    } as unknown as ResolvedServerConfig;

    // DB with runtime setting enabled = true.
    const db = {
      from(...args: any[]) {
        return (this as any).table(...args);
      },
      table(_: string) {
        function makeChain(filters: Array<{ col: string; val: string | null; isNull: boolean }>) {
          return {
            where(col: string, val: string) {
              return makeChain([...filters, { col, val, isNull: false }]);
            },
            whereNull(col: string) {
              return makeChain([...filters, { col, val: null, isNull: true }]);
            },
            async first() {
              const keyFilter = filters.find((f) => f.col === 'key');
              const keyVal = keyFilter?.val;
              if (keyVal === 'require_verified_email') {
                return {
                  key: keyVal,
                  organization_id: null,
                  value: JSON.stringify({ enabled: true }),
                  updated_at: new Date(),
                  updated_by: null,
                };
              }
              return null;
            },
          };
        }
        return {
          // Probe: select().limit() → resolves (table present).
          select(_cols?: string) {
            return {
              limit(_n: number) {
                return Promise.resolve([]);
              },
            };
          },
          where(col: string, val: string) {
            return makeChain([{ col, val, isNull: false }]);
          },
          whereNull(col: string) {
            return makeChain([{ col, val: null, isNull: true }]);
          },
        };
      },
    };
    const runtimeSettings = new RuntimeSettings(db as any);
    const res = await attemptPasswordLogin(cfg, {
      email: 'a@b.com',
      password: 'secret',
      ip: '1.2.3.4',
      settings: runtimeSettings,
    });
    assert.isFalse(res.ok);
    if (!res.ok) assert.isTrue(res.unverified);
  });

  test('runtime setting { require_verified_email: enabled: false } sobrescreve config true → permite', async ({
    assert,
  }) => {
    // Config says requireVerifiedEmail: true, but runtime setting says false → login allowed.
    const accountStore = {
      verifyCredentials: async (email: string) => (email === ACCOUNT.email ? { ...ACCOUNT } : null),
      isEmailVerified: async () => false,
    } as unknown as AccountStore;
    const cfg = {
      accountStore,
      audit: { record: async () => {} },
      lockout: makeLockout({ enabled: true, maxAttempts: 5 }),
      login: { requireVerifiedEmail: true }, // config ON
    } as unknown as ResolvedServerConfig;

    const db = {
      from(...args: any[]) {
        return (this as any).table(...args);
      },
      table(_: string) {
        function makeChain(filters: Array<{ col: string; val: string | null; isNull: boolean }>) {
          return {
            where(col: string, val: string) {
              return makeChain([...filters, { col, val, isNull: false }]);
            },
            whereNull(col: string) {
              return makeChain([...filters, { col, val: null, isNull: true }]);
            },
            async first() {
              const keyFilter = filters.find((f) => f.col === 'key');
              const keyVal = keyFilter?.val;
              if (keyVal === 'require_verified_email') {
                return {
                  key: keyVal,
                  organization_id: null,
                  value: JSON.stringify({ enabled: false }),
                  updated_at: new Date(),
                  updated_by: null,
                };
              }
              return null;
            },
          };
        }
        return {
          // Probe: select().limit() → resolves (table present).
          select(_cols?: string) {
            return {
              limit(_n: number) {
                return Promise.resolve([]);
              },
            };
          },
          where(col: string, val: string) {
            return makeChain([{ col, val, isNull: false }]);
          },
          whereNull(col: string) {
            return makeChain([{ col, val: null, isNull: true }]);
          },
        };
      },
    };
    const runtimeSettings = new RuntimeSettings(db as any);
    const res = await attemptPasswordLogin(cfg, {
      email: 'a@b.com',
      password: 'secret',
      ip: null,
      settings: runtimeSettings,
    });
    assert.isTrue(res.ok);
  });

  test('isEmailUnverifiedBlock: sem settings → usa config estático', async ({ assert }) => {
    const accountStore = {
      isEmailVerified: async () => false,
    } as unknown as AccountStore;
    const cfg = {
      accountStore,
      login: { requireVerifiedEmail: true },
    } as unknown as ResolvedServerConfig;
    assert.isTrue(await isEmailUnverifiedBlock(cfg, 'u1'));
  });

  // ---- M1: lockout via runtime setting afeta o runtime ----

  /** RuntimeSettings stub que devolve o setting `lockout` pedido. */
  function lockoutSettings(value: Record<string, unknown>) {
    const db = {
      from(...args: any[]) {
        return (this as any).table(...args);
      },
      table(_: string) {
        function makeChain(filters: Array<{ col: string; val: string | null; isNull: boolean }>) {
          return {
            where(col: string, val: string) {
              return makeChain([...filters, { col, val, isNull: false }]);
            },
            whereNull(col: string) {
              return makeChain([...filters, { col, val: null, isNull: true }]);
            },
            async first() {
              const keyVal = filters.find((f) => f.col === 'key')?.val;
              if (keyVal === 'lockout') {
                return {
                  key: keyVal,
                  organization_id: null,
                  value: JSON.stringify(value),
                  updated_at: new Date(),
                  updated_by: null,
                };
              }
              return null;
            },
          };
        }
        return {
          select(_cols?: string) {
            return {
              limit(_n: number) {
                return Promise.resolve([]);
              },
            };
          },
          where(col: string, val: string) {
            return makeChain([{ col, val, isNull: false }]);
          },
          whereNull(col: string) {
            return makeChain([{ col, val: null, isNull: true }]);
          },
        };
      },
    };
    return new RuntimeSettings(db as any);
  }

  test('M1: runtime setting { lockout: enabled:false } desliga o lockout mesmo com cfg.lockout enabled', async ({
    assert,
  }) => {
    // Config diz enabled:true/maxAttempts:1 → travaria na 1ª falha.
    const cfg = makeCfg({ maxAttempts: 1, verify: async () => null });
    const settings = lockoutSettings({ enabled: false });

    // Várias falhas; com o setting OFF, NUNCA trava (locked sempre false).
    for (let i = 0; i < 3; i++) {
      const res = await attemptPasswordLogin(cfg, {
        email: 'm1@b.com',
        password: 'x',
        ip: null,
        settings,
      });
      assert.isFalse(res.ok);
      if (!res.ok) assert.isFalse(res.locked);
    }
  });

  test('M1: runtime setting { lockout: maxAttempts custom } sobrescreve o cfg.lockout', async ({
    assert,
  }) => {
    // Config diz maxAttempts:5; setting reduz para 2 → trava na 3ª tentativa.
    const cfg = makeCfg({ maxAttempts: 5, verify: async () => null });
    const settings = lockoutSettings({ enabled: true, maxAttempts: 2 });

    await attemptPasswordLogin(cfg, { email: 'm1b@b.com', password: 'x', ip: null, settings });
    await attemptPasswordLogin(cfg, { email: 'm1b@b.com', password: 'x', ip: null, settings });
    const res = await attemptPasswordLogin(cfg, {
      email: 'm1b@b.com',
      password: 'x',
      ip: null,
      settings,
    });
    assert.isFalse(res.ok);
    if (!res.ok) assert.isTrue(res.locked);
  });

  test('travada: não verifica a senha e devolve { ok: false, locked: true, retryAfterSec }', async ({
    assert,
  }) => {
    let verifyCalled = 0;
    const cfg = makeCfg({
      maxAttempts: 2,
      verify: async () => {
        verifyCalled++;
        return null;
      },
    });
    // 2 falhas → trava (keyed por email)
    await attemptPasswordLogin(cfg, { email: 'lock@b.com', password: 'x', ip: null });
    await attemptPasswordLogin(cfg, { email: 'lock@b.com', password: 'x', ip: null });
    const before = verifyCalled;

    const res = await attemptPasswordLogin(cfg, { email: 'lock@b.com', password: 'x', ip: null });
    assert.isFalse(res.ok);
    if (!res.ok) {
      assert.isTrue(res.locked);
      assert.isAbove(res.retryAfterSec ?? 0, 0);
    }
    // a 3ª tentativa NÃO chamou verifyCredentials (curto-circuito pelo lock)
    assert.equal(verifyCalled, before);
  });
});
