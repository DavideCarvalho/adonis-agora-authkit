import { randomUUID } from 'node:crypto';
import { compose } from '@adonisjs/core/helpers';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import { DateTime } from 'luxon';
import { lucidAuditSink } from '../../src/audit/lucid_audit_sink.js';
import { withAuditLog } from '../../src/mixins/with_audit_log.js';
import { createTestDatabase } from '../bootstrap.js';

class TestAuditLog extends compose(BaseModel, withAuditLog()) {
  static table = 'audit_logs';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true })
  declare id: string;
  @beforeCreate()
  static assignId(row: TestAuditLog) {
    if (!row.id) row.id = randomUUID();
  }
}

test.group('lucidAuditSink', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    BaseModel.useAdapter(db.modelAdapter());
    await db.connection().schema.createTable('audit_logs', (t: any) => {
      t.string('id').primary();
      t.string('type').notNullable();
      t.string('account_id').nullable();
      t.string('email').nullable();
      t.string('client_id').nullable();
      t.string('actor_id').nullable();
      t.string('ip').nullable();
      t.text('metadata').nullable();
      t.timestamp('created_at').nullable();
    });
    return async () => db.manager.closeAll();
  });

  test('record insere um evento com os campos corretos', async ({ assert }) => {
    const sink = lucidAuditSink(TestAuditLog);
    await sink.record({
      type: 'impersonation',
      actorId: 'admin-1',
      accountId: 'target-1',
      email: 't@x.com',
      clientId: 'app1',
      ip: '127.0.0.1',
      metadata: { scope: 'openid' },
    });
    const rows = await TestAuditLog.all();
    assert.lengthOf(rows, 1);
    const row = rows[0];
    assert.equal(row.type, 'impersonation');
    assert.equal(row.actorId, 'admin-1');
    assert.equal(row.accountId, 'target-1');
    assert.equal(row.email, 't@x.com');
    assert.equal(row.clientId, 'app1');
    assert.equal(row.ip, '127.0.0.1');
    assert.deepEqual(row.metadata, { scope: 'openid' });
    assert.isNotNull(row.createdAt);
  });

  test('record normaliza campos ausentes para null', async ({ assert }) => {
    const sink = lucidAuditSink(TestAuditLog);
    await sink.record({ type: 'login.failure', email: 'a@b.com' });
    const rows = await TestAuditLog.all();
    assert.lengthOf(rows, 1);
    assert.equal(rows[0].type, 'login.failure');
    assert.equal(rows[0].email, 'a@b.com');
    assert.isNull(rows[0].accountId);
    assert.isNull(rows[0].clientId);
    assert.isNull(rows[0].actorId);
    assert.isNull(rows[0].ip);
    assert.isNull(rows[0].metadata);
  });

  test('record engole erros do model (best-effort, nunca lança)', async ({ assert }) => {
    const ThrowingModel = {
      create: async () => {
        throw new Error('db down');
      },
    };
    const sink = lucidAuditSink(ThrowingModel as any);
    // Não deve lançar — silencia o erro de inserção.
    await assert.doesNotReject(() => sink.record({ type: 'login.success', email: 'a@b.com' }));
  });

  // ----- list (console admin — B6) -----

  test('list pages newest first by cursor, forward and back', async ({ assert }) => {
    const sink = lucidAuditSink(TestAuditLog);
    // Same second on purpose: the id breaks the tie, so no row is skipped or repeated.
    const at = DateTime.fromISO('2026-11-13T12:00:00.000Z');
    for (let i = 0; i < 5; i++) {
      await TestAuditLog.create({ id: `ev-${i}`, type: 'login.success', createdAt: at } as any);
    }
    await TestAuditLog.create({
      id: 'ev-newest',
      type: 'login.success',
      createdAt: at.plus({ minutes: 1 }),
    } as any);

    const first = await sink.list!({ size: 2 });
    assert.deepEqual(
      first.data.map((e) => e.id),
      ['ev-newest', 'ev-4'],
    );
    assert.isTrue(first.hasNext);
    assert.isFalse(first.hasPrev);
    assert.isNull(first.prevCursor);
    assert.isNotNull(first.data[0].createdAt);

    const second = await sink.list!({ size: 2, after: first.nextCursor! });
    assert.deepEqual(
      second.data.map((e) => e.id),
      ['ev-3', 'ev-2'],
    );
    assert.isTrue(second.hasPrev);

    const third = await sink.list!({ size: 2, after: second.nextCursor! });
    assert.deepEqual(
      third.data.map((e) => e.id),
      ['ev-1', 'ev-0'],
    );
    assert.isFalse(third.hasNext);
    assert.isNull(third.nextCursor);

    const back = await sink.list!({ size: 2, before: third.prevCursor! });
    assert.deepEqual(
      back.data.map((e) => e.id),
      ['ev-3', 'ev-2'],
    );
    assert.isTrue(back.hasNext);
    assert.isTrue(back.hasPrev);

    const backToStart = await sink.list!({ size: 2, before: back.prevCursor! });
    assert.deepEqual(
      backToStart.data.map((e) => e.id),
      ['ev-newest', 'ev-4'],
    );
    assert.isFalse(backToStart.hasPrev);
  });

  test('list ignores a cursor it did not produce (first page)', async ({ assert }) => {
    const sink = lucidAuditSink(TestAuditLog);
    await sink.record({ type: 'login.success' });
    const page = await sink.list!({ after: 'not-a-cursor' });
    assert.lengthOf(page.data, 1);
  });

  test('list and count filter by type (one or several)', async ({ assert }) => {
    const sink = lucidAuditSink(TestAuditLog);
    await sink.record({ type: 'login.success', email: 'a@x.com' });
    await sink.record({ type: 'login.failure', email: 'b@x.com' });
    await sink.record({ type: 'login.failure', email: 'c@x.com' });
    await sink.record({ type: 'signup', email: 'd@x.com' });

    const failures = await sink.list!({ type: 'login.failure' });
    assert.lengthOf(failures.data, 2);
    assert.isTrue(failures.data.every((e) => e.type === 'login.failure'));
    assert.equal(await sink.count!({ type: 'login.failure' }), 2);

    const logins = await sink.list!({ type: ['login.success', 'login.failure'] });
    assert.lengthOf(logins.data, 3);
    assert.equal(await sink.count!({}), 4);
  });

  test('list and count filter by subject (accountId)', async ({ assert }) => {
    const sink = lucidAuditSink(TestAuditLog);
    await sink.record({ type: 'pat.issued', accountId: 'target-1' });
    await sink.record({ type: 'pat.revoked', accountId: 'target-1' });
    await sink.record({ type: 'pat.issued', accountId: 'target-2' });

    const forTarget1 = await sink.list!({ subject: 'target-1' });
    assert.lengthOf(forTarget1.data, 2);
    assert.isTrue(forTarget1.data.every((e) => e.accountId === 'target-1'));
    assert.equal(await sink.count!({ subject: 'target-1' }), 2);
  });

  // ----- anonymizeAccount (LGPD/GDPR — deleção de conta) -----

  test('anonymizeAccount remove PII mas PRESERVA o histórico', async ({ assert }) => {
    const sink = lucidAuditSink(TestAuditLog);
    // Eventos da conta alvo (como subject) com PII.
    await sink.record({ type: 'login.success', accountId: 'me', email: 'me@x.com', ip: '1.2.3.4' });
    await sink.record({ type: 'pat.issued', accountId: 'me', email: 'me@x.com', ip: '5.6.7.8' });
    // Evento de outra conta — não deve ser tocado.
    await sink.record({
      type: 'login.success',
      accountId: 'other',
      email: 'other@x.com',
      ip: '9.9.9.9',
    });

    const affected = await sink.anonymizeAccount!('me');
    assert.equal(affected, 2);

    // O histórico continua: 3 linhas no total (nada foi deletado).
    const all = await TestAuditLog.all();
    assert.lengthOf(all, 3);

    // As linhas da conta 'me' não têm mais email/ip e o accountId virou pseudônimo.
    const mine = all.filter((r) => r.accountId?.startsWith('anon:'));
    assert.lengthOf(mine, 2);
    for (const row of mine) {
      assert.isNull(row.email);
      assert.isNull(row.ip);
      assert.notEqual(row.accountId, 'me');
    }
    // Pseudônimo estável: as duas linhas compartilham o MESMO anon id.
    assert.equal(mine[0].accountId, mine[1].accountId);

    // A conta 'other' permanece intacta.
    const other = all.find((r) => r.accountId === 'other');
    assert.isNotNull(other);
    assert.equal(other!.email, 'other@x.com');
    assert.equal(other!.ip, '9.9.9.9');
  });

  test('anonymizeAccount também anonimiza o actorId (ações como admin)', async ({ assert }) => {
    const sink = lucidAuditSink(TestAuditLog);
    // 'me' agiu como admin sobre outra conta.
    await sink.record({ type: 'user.disabled', accountId: 'victim', actorId: 'me', ip: '1.1.1.1' });

    await sink.anonymizeAccount!('me');
    const row = (await TestAuditLog.all())[0];
    assert.notEqual(row.actorId, 'me');
    assert.isTrue(row.actorId?.startsWith('anon:'));
    // accountId (a vítima da ação) NÃO é a conta deletada — não muda.
    assert.equal(row.accountId, 'victim');
  });

  test('anonymizeAccount engole erros (best-effort, retorna 0)', async ({ assert }) => {
    const ThrowingModel = {
      query: () => {
        throw new Error('db down');
      },
    };
    const sink = lucidAuditSink(ThrowingModel as any);
    let result = -1;
    await assert.doesNotReject(async () => {
      result = await sink.anonymizeAccount!('me');
    });
    assert.equal(result, 0);
  });
});
