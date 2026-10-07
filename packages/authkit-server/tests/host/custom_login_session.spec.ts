import { randomUUID } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { RedisAdapter } from '../../src/adapters/redis_adapter.js';
import { completeCustomLoginSession } from '../../src/host/custom_login_completion.js';
import type { CompleteLoginExtra } from '../../src/provider/interaction_actions.js';
import { fakeAccountStore } from '../bootstrap.js';

/** Exercise real RuntimeSettings reads, including its table-presence probe. */
function settingsDb(policy: Record<string, boolean>) {
  function query(filters: Record<string, unknown> = {}) {
    return {
      select: (_column: string) => ({ limit: async (_count: number) => [] }),
      where: (column: string, value: unknown) => query({ ...filters, [column]: value }),
      whereNull: (column: string) => query({ ...filters, [column]: null }),
      first: async () =>
        filters.key === 'session_policy' && filters.organization_id === null
          ? { value: JSON.stringify(policy) }
          : null,
    };
  }
  return { from: (_table: string) => query() };
}

function harness(policy: Record<string, boolean> = {}, mode: 'new' | 'reused' | 'failed' = 'new') {
  const redis = new RedisMock();
  const prefix = `custom-login-session:${randomUUID()}`;
  class Adapter extends RedisAdapter {
    constructor(model: string) {
      super(model, redis, prefix);
    }
  }
  const sessions = new Adapter('Session');
  const completed: { accountId: string; extra: CompleteLoginExtra | undefined }[] = [];
  const audit: { type: string; accountId?: string | null }[] = [];
  const db = settingsDb(policy);
  const service = {
    config: {
      AdapterClass: Adapter,
      accountStore: fakeAccountStore(),
      audit: {
        record: async (event: { type: string; accountId?: string | null }) => {
          audit.push(event);
        },
      },
    },
    provider: {
      Session: {
        findByUid: async (uid: string) => (uid === 'current-uid' ? { id: 'current' } : undefined),
      },
    },
    interactions: {
      details: async () => ({ session: { uid: 'current-uid' } }),
      completeLogin: async (_ctx: HttpContext, accountId: string, extra?: CompleteLoginExtra) => {
        completed.push({ accountId, extra });
        if (mode === 'failed') return { ok: false };
        await sessions.upsert('current', { accountId, uid: 'current-uid', loginTs: 200 }, 3600);
        return { ok: true };
      },
    },
  };
  const ctx = {
    containerResolver: {
      make: async (key: string) => {
        if (key === 'authkit.server') return service;
        if (key === 'lucid.db') return db;
        throw new Error(`Unexpected binding: ${key}`);
      },
    },
    request: { ip: () => '127.0.0.1' },
  } as unknown as HttpContext;
  return { ctx, sessions, completed, audit, Adapter };
}

test.group('Custom login completion session policies', () => {
  test('defaults to a transient session and retains the custom authentication method', async ({
    assert,
  }) => {
    const h = harness();
    const result = await completeCustomLoginSession(h.ctx, 'u1', { amr: ['whatsapp'] });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(h.completed, [
      { accountId: 'u1', extra: { amr: ['whatsapp'], remember: false } },
    ]);
  });

  test('ignores requested persistence when runtime policy disables remember', async ({
    assert,
  }) => {
    const h = harness({ rememberEnabled: false });
    await completeCustomLoginSession(h.ctx, 'u1', { amr: ['whatsapp'] }, true);
    assert.equal(h.completed[0].extra?.remember, false);
  });

  test('persists a session when explicitly requested and allowed', async ({ assert }) => {
    const h = harness({ rememberEnabled: true });
    await completeCustomLoginSession(h.ctx, 'u1', { amr: ['whatsapp'] }, true);
    assert.equal(h.completed[0].extra?.remember, true);
  });

  test('MFA continuation uses a transient session even if extra requested remember', async ({
    assert,
  }) => {
    const h = harness({ rememberEnabled: true });
    await completeCustomLoginSession(h.ctx, 'u1', { amr: ['whatsapp', 'otp'], remember: true });
    assert.deepEqual(h.completed[0].extra, { amr: ['whatsapp', 'otp'], remember: false });
  });

  test('single-session policy preserves a reused current IdP session', async ({ assert }) => {
    const h = harness({ singleSession: true }, 'reused');
    await h.sessions.upsert('previous', { accountId: 'u1', loginTs: 100 }, 3600);
    await h.sessions.upsert('current', { accountId: 'u1', uid: 'current-uid', loginTs: 190 }, 3600);
    await completeCustomLoginSession(h.ctx, 'u1', { amr: ['whatsapp'] });
    assert.isUndefined(await h.sessions.find('previous'));
    assert.propertyVal(await h.sessions.find('current'), 'accountId', 'u1');
  });

  test('failed completion retains existing sessions and skips single-session audit', async ({
    assert,
  }) => {
    const h = harness({ singleSession: true }, 'failed');
    await h.sessions.upsert('previous', { accountId: 'u1', loginTs: 100 }, 3600);
    const result = await completeCustomLoginSession(h.ctx, 'u1', { amr: ['whatsapp'] });
    assert.deepEqual(result, { ok: false });
    assert.propertyVal(await h.sessions.find('previous'), 'accountId', 'u1');
    assert.deepEqual(h.audit, []);
  });

  test('single-session policy removes old sessions and grants while preserving the new session', async ({
    assert,
  }) => {
    const h = harness({ singleSession: true });
    await h.sessions.upsert('previous', { accountId: 'u1', loginTs: 100 }, 3600);
    await h.sessions.upsert('other-account', { accountId: 'u2', loginTs: 100 }, 3600);
    const grants = new h.Adapter('Grant');
    const tokens = new h.Adapter('AccessToken');
    await grants.upsert('previous-grant', { accountId: 'u1' }, 3600);
    await tokens.upsert('previous-token', { grantId: 'previous-grant' }, 3600);
    await completeCustomLoginSession(h.ctx, 'u1', { amr: ['whatsapp'] });
    assert.isUndefined(await h.sessions.find('previous'));
    assert.propertyVal(await h.sessions.find('current'), 'accountId', 'u1');
    assert.propertyVal(await h.sessions.find('other-account'), 'accountId', 'u2');
    assert.isUndefined(await grants.find('previous-grant'));
    assert.isUndefined(await tokens.find('previous-token'));
    assert.deepEqual(h.audit, [
      {
        type: 'session.single_enforced',
        accountId: 'u1',
        ip: '127.0.0.1',
        metadata: { revokedCount: 1 },
      },
    ]);
  });
});
