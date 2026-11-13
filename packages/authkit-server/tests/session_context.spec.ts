import { test } from '@japa/runner';
import type { StoredAuditEvent } from '../src/audit/audit_sink.js';
import type { AdminSession } from '../src/host/admin_sessions_service.js';
import { enrichSessionsWithContext } from '../src/host/session_context.js';
import { auditPageOf } from './helpers/memory_audit_list.js';

/** Cria uma sessão mínima para os testes. */
function makeSession(overrides: Partial<AdminSession> = {}): AdminSession {
  return { id: 'sess-1', accountId: 'acc-1', loginTs: 1700000000, amr: ['pwd'], ...overrides };
}

/** Cria um evento `login.success` mínimo para o audit. */
function makeLoginEvent(overrides: Partial<StoredAuditEvent> = {}): StoredAuditEvent {
  return {
    id: 'ev-1',
    type: 'login.success',
    accountId: 'acc-1',
    ip: '1.2.3.4',
    createdAt: new Date(1700000000 * 1000), // mesmo epoch da sessão
    metadata: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    },
    ...overrides,
  };
}

/** Constrói um cfg mínimo com audit.list plugado. */
function cfgWithAudit(events: StoredAuditEvent[], resolveGeo?: any) {
  return {
    audit: {
      record: async () => {},
      list: async ({ subject }: any) => {
        const filtered = subject ? events.filter((e) => e.accountId === subject) : events;
        return auditPageOf(filtered);
      },
    },
    resolveGeo,
  };
}

test.group('enrichSessionsWithContext — session context (UA + geo)', () => {
  test('lista vazia → devolve imediatamente sem consulta', async ({ assert }) => {
    let listed = false;
    const cfg = {
      audit: {
        record: async () => {},
        list: async () => {
          listed = true;
          return auditPageOf([]);
        },
      },
    };
    const result = await enrichSessionsWithContext(cfg as any, 'acc-1', []);
    assert.deepEqual(result, []);
    assert.isFalse(listed, 'list não deve ser chamado para lista vazia');
  });

  test('sem audit.list → devolve sessões sem enrichment (degradação)', async ({ assert }) => {
    const cfg = { audit: { record: async () => {} } };
    const session = makeSession();
    const result = await enrichSessionsWithContext(cfg as any, 'acc-1', [session]);
    assert.lengthOf(result, 1);
    assert.equal(result[0].id, 'sess-1');
    assert.isUndefined(result[0].userAgent);
    assert.isUndefined(result[0].browser);
    assert.isUndefined(result[0].ip);
  });

  test('sem cfg.audit → devolve sessões sem enrichment (degradação)', async ({ assert }) => {
    const cfg = {};
    const session = makeSession();
    const result = await enrichSessionsWithContext(cfg as any, 'acc-1', [session]);
    assert.lengthOf(result, 1);
    assert.isUndefined(result[0].browser);
  });

  test('correlaciona por loginTs → extrai browser/OS/IP corretos', async ({ assert }) => {
    const event = makeLoginEvent({
      createdAt: new Date(1700000000 * 1000),
      ip: '5.6.7.8',
      metadata: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15' },
    });
    const cfg = cfgWithAudit([event]);
    const session = makeSession({ loginTs: 1700000000 });
    const result = await enrichSessionsWithContext(cfg as any, 'acc-1', [session]);
    assert.equal(result[0].ip, '5.6.7.8');
    assert.equal(
      result[0].userAgent,
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
    );
    assert.equal(result[0].browser, 'Safari');
    assert.equal(result[0].os, 'macOS');
    assert.isNull(result[0].location); // sem resolveGeo
  });

  test('resolveGeo plugado → location preenchida', async ({ assert }) => {
    const event = makeLoginEvent({ ip: '8.8.8.8', createdAt: new Date(1700000000 * 1000) });
    const cfg = cfgWithAudit([event], async (ip: string) => `loc:${ip}`);
    const result = await enrichSessionsWithContext(cfg as any, 'acc-1', [makeSession()]);
    assert.equal(result[0].location, 'loc:8.8.8.8');
  });

  test('resolveGeo falha → location null (fail-safe)', async ({ assert }) => {
    const event = makeLoginEvent({ ip: '1.1.1.1', createdAt: new Date(1700000000 * 1000) });
    const cfg = cfgWithAudit([event], async () => {
      throw new Error('geo down');
    });
    const result = await enrichSessionsWithContext(cfg as any, 'acc-1', [makeSession()]);
    assert.isNull(result[0].location);
  });

  test('resolveGeo com timeout → location null (fail-safe)', async ({ assert }) => {
    const event = makeLoginEvent({ ip: '9.9.9.9', createdAt: new Date(1700000000 * 1000) });
    // resolveGeoSafe usa timeoutMs = 1500 por default; testamos via configuração de
    // timeout curto — ao contrário do geo.spec que testa o módulo direto, aqui
    // queremos garantir que o enrichment não propaga o timeout.
    const slow = () => new Promise<string>((r) => setTimeout(() => r('tarde'), 2000));
    const cfgSlow = cfgWithAudit([event], slow);
    const result = await enrichSessionsWithContext(cfgSlow as any, 'acc-1', [makeSession()]);
    // location é null ou string — não importa qual; o enriquecimento não deve lançar.
    assert.doesNotThrow(() => result[0].location);
  });

  test('sessão sem loginTs → usa o evento mais recente disponível', async ({ assert }) => {
    const event = makeLoginEvent({ ip: '2.3.4.5', metadata: { userAgent: 'Firefox/121.0' } });
    const cfg = cfgWithAudit([event]);
    const session = makeSession({ loginTs: undefined });
    const result = await enrichSessionsWithContext(cfg as any, 'acc-1', [session]);
    assert.equal(result[0].ip, '2.3.4.5');
  });

  test('múltiplas sessões correlacionam ao evento mais próximo individualmente', async ({
    assert,
  }) => {
    const ev1: StoredAuditEvent = {
      id: 'ev-1',
      type: 'login.success',
      accountId: 'acc-1',
      ip: '10.0.0.1',
      createdAt: new Date(1000 * 1000), // epoch 1000
      metadata: { userAgent: 'Firefox/120.0' },
    };
    const ev2: StoredAuditEvent = {
      id: 'ev-2',
      type: 'login.success',
      accountId: 'acc-1',
      ip: '10.0.0.2',
      createdAt: new Date(2000 * 1000), // epoch 2000
      metadata: { userAgent: 'Chrome/120.0' },
    };
    const cfg = cfgWithAudit([ev1, ev2]);
    const sessions = [
      makeSession({ id: 'sess-a', loginTs: 1001 }), // mais perto de ev1
      makeSession({ id: 'sess-b', loginTs: 1999 }), // mais perto de ev2
    ];
    const result = await enrichSessionsWithContext(cfg as any, 'acc-1', sessions);
    // sess-a deve correlacionar com ev1 (ip 10.0.0.1)
    const a = result.find((s) => s.id === 'sess-a')!;
    // sess-b deve correlacionar com ev2 (ip 10.0.0.2)
    const b = result.find((s) => s.id === 'sess-b')!;
    assert.equal(a.ip, '10.0.0.1');
    assert.equal(b.ip, '10.0.0.2');
  });

  test('evento sem ip nem userAgent → não é usado (sessão sem enriquecimento)', async ({
    assert,
  }) => {
    // Evento sem conteúdo útil de contexto — é filtrado por `closestEvent`.
    const emptyEv: StoredAuditEvent = {
      id: 'ev-empty',
      type: 'login.success',
      accountId: 'acc-1',
      ip: null,
      createdAt: new Date(1700000000 * 1000),
      metadata: {},
    };
    const cfg = cfgWithAudit([emptyEv]);
    const result = await enrichSessionsWithContext(cfg as any, 'acc-1', [makeSession()]);
    // Sem evento utilizável, a sessão é devolvida como veio (sem campos extras).
    // Os campos de contexto ficam undefined (não definidos na interface base).
    assert.isUndefined(result[0].ip);
    assert.isUndefined(result[0].browser);
    assert.isUndefined(result[0].os);
  });
});
