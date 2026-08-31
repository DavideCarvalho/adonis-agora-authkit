/**
 * Testes para a feature de expiração de senha no fluxo de login.
 *
 * Cobre:
 *   - isPasswordExpired: retorna true quando senha vencida
 *   - isPasswordExpired: retorna false quando off / sem capability
 *   - attemptPasswordLogin: retorna { ok: false, passwordExpired: true } quando vencida
 *   - attemptPasswordLogin: não força quando expiration está off
 */
import { test } from '@japa/runner';
import type { AccountStore } from '../../src/accounts/account_store.js';
import type { ResolvedServerConfig } from '../../src/define_config.js';
import { resolveLockout } from '../../src/define_config.js';
import {
  checkPasswordExpiration,
  checkPasswordHistory,
  checkPasswordPepper,
} from '../../src/doctor/checks.js';
import { __setLockoutLimiterLoaderForTests } from '../../src/host/account_lockout.js';
import {
  attemptPasswordLogin,
  isEmailUnverifiedBlock,
  isPasswordExpired,
} from '../../src/host/login_attempt.js';
import { RuntimeSettings } from '../../src/host/runtime_settings.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeDbWithSettings(rows: Record<string, any> = {}) {
  const storeKey = (key: string, orgId: string | null) => `${key}|${orgId ?? ''}`;
  const store = new Map<string, { key: string; org_id: string | null; value: string }>(
    Object.entries(rows).map(([k, v]) => [
      storeKey(k, null),
      { key: k, org_id: null, value: JSON.stringify(v) },
    ]),
  );
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
        const orgFilter = filters.find((f) => f.col === 'organization_id');
        if (!keyFilter) return null;
        const keyVal = keyFilter.val!;
        const orgId: string | null = orgFilter ? (orgFilter.isNull ? null : orgFilter.val) : null;
        const sk = storeKey(keyVal, orgId);
        const v = store.get(sk);
        return v ? { key: v.key, organization_id: v.org_id, value: v.value } : null;
      },
    };
  }
  return {
    from(name: string) {
      return this.table(name);
    },
    table(_name: string) {
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
}

function noTableDb() {
  return {
    // table() throws → probe catches → tablePresent = false.
    from() {
      return this.table();
    },
    table() {
      throw new Error('no table');
    },
  };
}

function makeLimiterStub() {
  const counters = new Map<string, number>();
  const blocks = new Map<string, number>();
  function instance() {
    return {
      async increment(key: string) {
        const n = (counters.get(key) ?? 0) + 1;
        counters.set(key, n);
        return { consumed: n, availableIn: 0 };
      },
      async get(key: string) {
        return { consumed: counters.get(key) ?? 0, availableIn: 0 };
      },
      async delete(key: string) {
        counters.delete(key);
        blocks.delete(key);
        return true;
      },
      async block(key: string, dur: number) {
        blocks.set(key, dur);
        return { consumed: 1, availableIn: dur };
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

function makeAccount(id = 'u1', email = 'a@b.com') {
  return { id, email, globalRoles: [] as string[] };
}

/** Constrói um ResolvedServerConfig mínimo para testes de login. */
function makeCfg(opts: {
  verify?: AccountStore['verifyCredentials'];
  getPasswordChangedAt?: (id: string) => Promise<Date | null>;
}): ResolvedServerConfig {
  const accountStore: any = {
    verifyCredentials:
      opts.verify ?? (async (email: string) => (email === 'a@b.com' ? makeAccount() : null)),
    ...(opts.getPasswordChangedAt
      ? {
          getPasswordChangedAt: opts.getPasswordChangedAt,
        }
      : {}),
  };
  return {
    accountStore,
    lockout: resolveLockout({ enabled: false }),
  } as unknown as ResolvedServerConfig;
}

// ---------------------------------------------------------------------------
// isPasswordExpired
// ---------------------------------------------------------------------------

test.group('isPasswordExpired', (group) => {
  test('retorna false quando expiration.enabled = false (setting desligada)', async ({
    assert,
  }) => {
    const cfg = makeCfg({
      getPasswordChangedAt: async () => new Date(Date.now() - 200 * 24 * 60 * 60 * 1000), // 200 dias atrás
    });
    const settings = new RuntimeSettings(
      fakeDbWithSettings({
        password_expiration: { enabled: false, maxAgeDays: 90 },
      }),
    );
    const expired = await isPasswordExpired(cfg, 'u1', settings);
    assert.isFalse(expired);
  });

  test('retorna false quando store não tem getPasswordChangedAt (sem capability)', async ({
    assert,
  }) => {
    const cfg = makeCfg({}); // sem getPasswordChangedAt
    const settings = new RuntimeSettings(
      fakeDbWithSettings({
        password_expiration: { enabled: true, maxAgeDays: 90 },
      }),
    );
    const expired = await isPasswordExpired(cfg, 'u1', settings);
    assert.isFalse(expired);
  });

  test('retorna true quando senha passou do prazo', async ({ assert }) => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000); // 100 dias atrás
    const cfg = makeCfg({ getPasswordChangedAt: async () => old });
    const settings = new RuntimeSettings(
      fakeDbWithSettings({
        password_expiration: { enabled: true, maxAgeDays: 90 }, // max 90 dias
      }),
    );
    const expired = await isPasswordExpired(cfg, 'u1', settings);
    assert.isTrue(expired);
  });

  test('retorna false quando senha ainda está no prazo', async ({ assert }) => {
    const recent = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 dias atrás
    const cfg = makeCfg({ getPasswordChangedAt: async () => recent });
    const settings = new RuntimeSettings(
      fakeDbWithSettings({
        password_expiration: { enabled: true, maxAgeDays: 90 },
      }),
    );
    const expired = await isPasswordExpired(cfg, 'u1', settings);
    assert.isFalse(expired);
  });

  test('retorna true quando changed_at é null (conta legacy)', async ({ assert }) => {
    const cfg = makeCfg({ getPasswordChangedAt: async () => null });
    const settings = new RuntimeSettings(
      fakeDbWithSettings({
        password_expiration: { enabled: true, maxAgeDays: 90 },
      }),
    );
    const expired = await isPasswordExpired(cfg, 'u1', settings);
    assert.isTrue(expired, 'conta legacy (null) deve ser forçada a trocar a senha');
  });

  test('fail-safe: retorna false quando settings table não existe', async ({ assert }) => {
    const cfg = makeCfg({ getPasswordChangedAt: async () => null });
    const settings = new RuntimeSettings(noTableDb());
    const expired = await isPasswordExpired(cfg, 'u1', settings);
    assert.isFalse(expired, 'sem tabela de settings → fail-safe, não bloqueia');
  });
});

// ---------------------------------------------------------------------------
// attemptPasswordLogin com expiração
// ---------------------------------------------------------------------------

test.group('attemptPasswordLogin — passwordExpired', (group) => {
  let stub: ReturnType<typeof makeLimiterStub>;

  group.each.setup(() => {
    stub = makeLimiterStub();
    __setLockoutLimiterLoaderForTests(() => Promise.resolve(stub));
    return () => __setLockoutLimiterLoaderForTests(undefined);
  });

  test('senha vencida → ok=false, passwordExpired=true, account presente', async ({ assert }) => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const cfg = makeCfg({ getPasswordChangedAt: async () => old });
    const settings = new RuntimeSettings(
      fakeDbWithSettings({
        password_expiration: { enabled: true, maxAgeDays: 90 },
      }),
    );
    const res = await attemptPasswordLogin(cfg, {
      email: 'a@b.com',
      password: 'any',
      ip: null,
      settings,
    });
    assert.isFalse(res.ok);
    assert.isTrue((res as any).passwordExpired);
    assert.isObject((res as any).account);
  });

  test('expiration off → login normal (ok=true)', async ({ assert }) => {
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    const cfg = makeCfg({ getPasswordChangedAt: async () => old });
    const settings = new RuntimeSettings(
      fakeDbWithSettings({
        password_expiration: { enabled: false, maxAgeDays: 90 },
      }),
    );
    const res = await attemptPasswordLogin(cfg, {
      email: 'a@b.com',
      password: 'any',
      ip: null,
      settings,
    });
    assert.isTrue(res.ok);
  });

  test('sem capability getPasswordChangedAt → login normal (ok=true)', async ({ assert }) => {
    const cfg = makeCfg({}); // sem getPasswordChangedAt
    const settings = new RuntimeSettings(
      fakeDbWithSettings({
        password_expiration: { enabled: true, maxAgeDays: 90 },
      }),
    );
    const res = await attemptPasswordLogin(cfg, {
      email: 'a@b.com',
      password: 'any',
      ip: null,
      settings,
    });
    assert.isTrue(res.ok);
  });
});

// ---------------------------------------------------------------------------
// Grace period de verificação de e-mail
// ---------------------------------------------------------------------------

test.group('isEmailUnverifiedBlock — grace period', () => {
  test('dentro da janela de graça → não bloqueia', async ({ assert }) => {
    const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // criada há 2 dias
    const accountStore: any = {
      isEmailVerified: async () => false, // e-mail não verificado
      findById: async (id: string) => ({
        id,
        email: 'a@b.com',
        globalRoles: [],
        createdAt: recentDate,
      }),
    };
    const cfg = {
      accountStore,
      login: { requireVerifiedEmail: true },
    } as any;

    const settings = new RuntimeSettings(
      fakeDbWithSettings({
        require_verified_email: { enabled: true, graceDays: 7 }, // 7 dias de graça
      }),
    );

    const blocked = await isEmailUnverifiedBlock(cfg, 'u1', settings);
    assert.isFalse(blocked, 'dentro da janela de graça → não deve bloquear');
  });

  test('fora da janela de graça → bloqueia normalmente', async ({ assert }) => {
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // criada há 30 dias
    const accountStore: any = {
      isEmailVerified: async () => false,
      findById: async (id: string) => ({
        id,
        email: 'a@b.com',
        globalRoles: [],
        createdAt: oldDate,
      }),
    };
    const cfg = {
      accountStore,
      login: { requireVerifiedEmail: true },
    } as any;

    const settings = new RuntimeSettings(
      fakeDbWithSettings({
        require_verified_email: { enabled: true, graceDays: 7 }, // 7 dias de graça
      }),
    );

    const blocked = await isEmailUnverifiedBlock(cfg, 'u1', settings);
    assert.isTrue(blocked, 'fora da janela → deve bloquear');
  });

  test('graceDays=0 → comportamento atual (bloqueia imediatamente)', async ({ assert }) => {
    const recentDate = new Date(Date.now() - 1 * 60 * 60 * 1000); // criada há 1 hora
    const accountStore: any = {
      isEmailVerified: async () => false,
      findById: async (id: string) => ({
        id,
        email: 'a@b.com',
        globalRoles: [],
        createdAt: recentDate,
      }),
    };
    const cfg = {
      accountStore,
      login: { requireVerifiedEmail: true },
    } as any;

    const settings = new RuntimeSettings(
      fakeDbWithSettings({
        require_verified_email: { enabled: true, graceDays: 0 },
      }),
    );

    const blocked = await isEmailUnverifiedBlock(cfg, 'u1', settings);
    assert.isTrue(blocked, 'graceDays=0 → bloqueia mesmo que recém-criada');
  });
});

// ---------------------------------------------------------------------------
// Doctor checks para password hygiene
// ---------------------------------------------------------------------------

test.group('doctor — password hygiene checks', () => {
  test('checkPasswordPepper → null quando sem pepper', ({ assert }) => {
    const input = {
      authkitConfig: { accountStore: {} },
      sessionConfig: null,
      peers: { session: true, shield: true, ally: true, limiter: true },
    };
    assert.isNull(checkPasswordPepper(input as any));
  });

  test('checkPasswordPepper → ok para string', ({ assert }) => {
    const input = {
      authkitConfig: { accountStore: { __pepper: 'secret' } },
      sessionConfig: null,
      peers: { session: true, shield: true, ally: true, limiter: true },
    };
    const f = checkPasswordPepper(input as any);
    assert.equal(f?.level, 'ok');
  });

  test('checkPasswordPepper → ok para array (rotação)', ({ assert }) => {
    const input = {
      authkitConfig: { accountStore: { __pepper: ['new', 'old'] } },
      sessionConfig: null,
      peers: { session: true, shield: true, ally: true, limiter: true },
    };
    const f = checkPasswordPepper(input as any);
    assert.equal(f?.level, 'ok');
    assert.include(f!.message, 'rotation');
  });

  test('checkPasswordHistory → null quando sem capability e sem setting', ({ assert }) => {
    const input = {
      authkitConfig: { accountStore: {} },
      sessionConfig: null,
      peers: { session: true, shield: true, ally: true, limiter: true },
    };
    assert.isNull(checkPasswordHistory(input as any));
  });

  test('checkPasswordHistory → warn quando setting on mas sem capability', ({ assert }) => {
    const input = {
      authkitConfig: { accountStore: {} },
      sessionConfig: null,
      peers: { session: true, shield: true, ally: true, limiter: true },
      passwordHistorySetting: { enabled: true, count: 5 },
    };
    const f = checkPasswordHistory(input as any);
    assert.equal(f?.level, 'warn');
  });

  test('checkPasswordHistory → ok quando capability presente', ({ assert }) => {
    const input = {
      authkitConfig: { accountStore: { isPasswordReused: async () => false } },
      sessionConfig: null,
      peers: { session: true, shield: true, ally: true, limiter: true },
    };
    const f = checkPasswordHistory(input as any);
    assert.equal(f?.level, 'ok');
  });

  test('checkPasswordExpiration → null quando sem capability e sem setting', ({ assert }) => {
    const input = {
      authkitConfig: { accountStore: {} },
      sessionConfig: null,
      peers: { session: true, shield: true, ally: true, limiter: true },
    };
    assert.isNull(checkPasswordExpiration(input as any));
  });

  test('checkPasswordExpiration → warn quando setting on mas sem capability', ({ assert }) => {
    const input = {
      authkitConfig: { accountStore: {} },
      sessionConfig: null,
      peers: { session: true, shield: true, ally: true, limiter: true },
      passwordExpirationSetting: { enabled: true, maxAgeDays: 90 },
    };
    const f = checkPasswordExpiration(input as any);
    assert.equal(f?.level, 'warn');
  });

  test('checkPasswordExpiration → ok quando capability presente', ({ assert }) => {
    const input = {
      authkitConfig: { accountStore: { getPasswordChangedAt: async () => null } },
      sessionConfig: null,
      peers: { session: true, shield: true, ally: true, limiter: true },
      passwordExpirationSetting: { enabled: true, maxAgeDays: 90 },
    };
    const f = checkPasswordExpiration(input as any);
    assert.equal(f?.level, 'ok');
  });
});
