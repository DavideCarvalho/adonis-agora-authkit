import { test } from '@japa/runner';
import type { StoredAuditEvent } from '../src/audit/audit_sink.js';
import { computeAdminStats } from '../src/host/admin_stats_service.js';

/** Sessão fake para o serviço de sessões. */
function fakeSessions(count: number, canList = true) {
  return {
    canList,
    countActiveSessions: async () => count,
  };
}

/** Store de contas em memória com total fixo. */
function fakeAccountStore(total: number) {
  return {
    listAccounts: async () => ({ data: [], total }),
  } as any;
}

/** Gera eventos no audit com timestamp relativo a agora. */
function makeEvents(
  opts: Array<{ type: string; accountId: string; daysAgo: number }>,
): StoredAuditEvent[] {
  return opts.map((o, i) => ({
    id: `ev-${i}`,
    type: o.type as any,
    accountId: o.accountId,
    createdAt: new Date(Date.now() - o.daysAgo * 86_400_000),
  }));
}

/** Cria um cfg com audit.list em memória. */
function cfgWithEvents(events: StoredAuditEvent[], totalUsers = 10) {
  return {
    accountStore: fakeAccountStore(totalUsers),
    audit: {
      record: async () => {},
      list: async ({ type, page = 1, size = 200 }: any) => {
        const filtered = type ? events.filter((e) => e.type === type) : events;
        const start = (page - 1) * size;
        const data = filtered.slice(start, start + size);
        return { data, total: filtered.length };
      },
    },
  };
}

/** Cfg sem audit.list (write-only). */
function cfgWithoutList(totalUsers = 5) {
  return {
    accountStore: fakeAccountStore(totalUsers),
    audit: { record: async () => {} },
  };
}

test.group('computeAdminStats — métricas do dashboard', () => {
  test('sem audit.list → degrada (séries vazias, auditSupported=false)', async ({ assert }) => {
    const cfg = cfgWithoutList(42);
    const stats = await computeAdminStats(cfg as any, fakeSessions(3));
    assert.equal(stats.totalUsers, 42);
    assert.equal(stats.activeSessions, 3);
    assert.isFalse(stats.auditSupported);
    assert.equal(stats.mau, 0);
    assert.equal(stats.signInsTotal, 0);
    assert.equal(stats.signUpsTotal, 0);
    // Séries ainda têm 30 entradas (datas), todas zeradas.
    assert.lengthOf(stats.signInsPerDay, 30);
    assert.isTrue(stats.signInsPerDay.every((p) => p.count === 0));
    assert.equal(stats.windowDays, 30);
  });

  test('sem cfg.audit → degrada igual ao caso write-only', async ({ assert }) => {
    const cfg = { accountStore: fakeAccountStore(7) };
    const stats = await computeAdminStats(cfg as any, fakeSessions(0));
    assert.isFalse(stats.auditSupported);
    assert.equal(stats.totalUsers, 7);
  });

  test('adapter não enumera → activeSessions null', async ({ assert }) => {
    const cfg = cfgWithoutList();
    const stats = await computeAdminStats(cfg as any, fakeSessions(0, false));
    assert.isNull(stats.activeSessions);
  });

  test('adapter enumera → activeSessions conta corretamente', async ({ assert }) => {
    const cfg = cfgWithEvents([]);
    const stats = await computeAdminStats(cfg as any, fakeSessions(7));
    assert.equal(stats.activeSessions, 7);
  });

  test('contagem de sign-ins na janela de 30 dias', async ({ assert }) => {
    const events = makeEvents([
      { type: 'login.success', accountId: 'u1', daysAgo: 1 }, // dentro da janela
      { type: 'login.success', accountId: 'u2', daysAgo: 15 }, // dentro
      { type: 'login.success', accountId: 'u1', daysAgo: 29 }, // dentro (borda)
      { type: 'login.success', accountId: 'u3', daysAgo: 31 }, // FORA da janela
    ]);
    const cfg = cfgWithEvents(events);
    const stats = await computeAdminStats(cfg as any, fakeSessions(0));
    assert.isTrue(stats.auditSupported);
    assert.equal(stats.signInsTotal, 3);
  });

  test('MAU: contas únicas com login.success na janela', async ({ assert }) => {
    const events = makeEvents([
      { type: 'login.success', accountId: 'u1', daysAgo: 1 },
      { type: 'login.success', accountId: 'u1', daysAgo: 5 }, // u1 duplicado
      { type: 'login.success', accountId: 'u2', daysAgo: 10 },
      { type: 'login.success', accountId: 'u3', daysAgo: 20 },
      { type: 'login.success', accountId: 'u4', daysAgo: 35 }, // fora da janela
    ]);
    const cfg = cfgWithEvents(events);
    const stats = await computeAdminStats(cfg as any, fakeSessions(0));
    // u4 fora da janela; u1 conta uma vez → 3 usuários únicos (u1, u2, u3).
    assert.equal(stats.mau, 3);
  });

  test('sign-ups separados dos sign-ins', async ({ assert }) => {
    const events = makeEvents([
      { type: 'login.success', accountId: 'u1', daysAgo: 2 },
      { type: 'login.success', accountId: 'u2', daysAgo: 3 },
      { type: 'signup', accountId: 'u3', daysAgo: 1 },
      { type: 'signup', accountId: 'u4', daysAgo: 5 },
      { type: 'signup', accountId: 'u5', daysAgo: 40 }, // fora
    ]);
    const cfg = cfgWithEvents(events);
    const stats = await computeAdminStats(cfg as any, fakeSessions(0));
    assert.equal(stats.signInsTotal, 2);
    assert.equal(stats.signUpsTotal, 2);
  });

  test('signInsPerDay cobre TODOS os 30 dias (zeros nos dias sem evento)', async ({ assert }) => {
    const events = makeEvents([
      { type: 'login.success', accountId: 'u1', daysAgo: 0 }, // hoje
    ]);
    const cfg = cfgWithEvents(events);
    const stats = await computeAdminStats(cfg as any, fakeSessions(0));
    assert.lengthOf(stats.signInsPerDay, 30);
    // Todos os dias sem evento devem ter count=0; o dia de hoje deve ter count≥1.
    const nonZero = stats.signInsPerDay.filter((p) => p.count > 0);
    assert.isAtLeast(nonZero.length, 1);
    const withZero = stats.signInsPerDay.filter((p) => p.count === 0);
    assert.isAtLeast(withZero.length, 28); // pelo menos 28 dias zerados (29 sem o de hoje)
  });

  test('datas das séries são strings ISO YYYY-MM-DD únicas e ordenadas', async ({ assert }) => {
    const cfg = cfgWithEvents([]);
    const stats = await computeAdminStats(cfg as any, fakeSessions(0));
    const dates = stats.signInsPerDay.map((p) => p.date);
    // Formato YYYY-MM-DD.
    assert.isTrue(dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
    // Ordenação crescente.
    for (let i = 1; i < dates.length; i++) {
      assert.isTrue(dates[i] > dates[i - 1], `data[${i}] deve ser posterior a data[${i - 1}]`);
    }
    // Sem repetições.
    assert.equal(new Set(dates).size, dates.length);
  });

  test('windowDays é 30', async ({ assert }) => {
    const cfg = cfgWithEvents([]);
    const stats = await computeAdminStats(cfg as any, fakeSessions(0));
    assert.equal(stats.windowDays, 30);
  });

  test('totalUsers vem do accountStore.listAccounts', async ({ assert }) => {
    const cfg = cfgWithEvents([], 99);
    const stats = await computeAdminStats(cfg as any, fakeSessions(0));
    assert.equal(stats.totalUsers, 99);
  });
});
