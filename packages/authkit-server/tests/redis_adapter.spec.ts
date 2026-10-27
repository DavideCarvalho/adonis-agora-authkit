import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { RedisAdapter } from '../src/adapters/redis_adapter.js';

function make(name: string) {
  const client = new RedisMock();
  return new RedisAdapter(name, client as any, 'authkit');
}

test.group('RedisAdapter', () => {
  test('upsert + find devolve o payload', async ({ assert }) => {
    const a = make('AccessToken');
    await a.upsert('t1', { jti: 't1', accountId: 'u1' }, 60);
    assert.deepInclude(await a.find('t1'), { jti: 't1', accountId: 'u1' });
  });

  test('find devolve undefined após destroy', async ({ assert }) => {
    const a = make('AccessToken');
    await a.upsert('t2', { jti: 't2' }, 60);
    await a.destroy('t2');
    assert.isUndefined(await a.find('t2'));
  });

  test('consume seta flag consumed sem apagar', async ({ assert }) => {
    const a = make('AuthorizationCode');
    await a.upsert('c1', { jti: 'c1' }, 60);
    await a.consume('c1');
    const found = await a.find('c1');
    assert.isOk(found.consumed);
  });

  test('consume lê payload e TTL num único round trip e preserva o TTL', async ({ assert }) => {
    const client = new RedisMock();
    const a = new RedisAdapter('RefreshToken', client as any, 'consume-rtt');
    await a.upsert('r1', { jti: 'r1', accountId: 'u1' }, 600);
    await new RedisAdapter('RefreshToken', client as any, 'consume-rtt').upsert('r2', { x: 1 }, 0);

    const calls = { get: 0, ttl: 0, pipeline: 0 };
    for (const command of Object.keys(calls) as Array<keyof typeof calls>) {
      const original = (client as any)[command].bind(client);
      (client as any)[command] = (...args: unknown[]) => {
        calls[command]++;
        return original(...args);
      };
    }

    await a.consume('r1');
    await a.consume('r2');
    await a.consume('missing');
    assert.deepEqual(calls, { get: 0, ttl: 0, pipeline: 3 });

    const ttl = await client.ttl('consume-rtt:RefreshToken:r1');
    assert.isAbove(ttl, 590);
    assert.deepInclude(await a.find('r1'), { jti: 'r1', accountId: 'u1' });
    assert.isNumber((await a.find('r1'))!.consumed);
    assert.equal(await client.ttl('consume-rtt:RefreshToken:r2'), -1);
    assert.isNumber((await a.find('r2'))!.consumed);
    assert.isUndefined(await a.find('missing'));
  });

  test('findByUid encontra Session pelo uid', async ({ assert }) => {
    const a = make('Session');
    await a.upsert('s1', { jti: 's1', uid: 'uid-1' }, 60);
    assert.deepInclude(await a.findByUid('uid-1'), { uid: 'uid-1' });
  });

  test('findByUserCode encontra DeviceCode pelo userCode', async ({ assert }) => {
    const a = make('DeviceCode');
    await a.upsert('d1', { jti: 'd1', userCode: 'WXYZ' }, 60);
    assert.deepInclude(await a.findByUserCode('WXYZ'), { userCode: 'WXYZ' });
  });

  test('revokeByGrantId apaga todos os payloads do grant', async ({ assert }) => {
    const a = make('AccessToken');
    await a.upsert('g-at', { jti: 'g-at', grantId: 'G1' }, 60);
    const r = make('RefreshToken');
    await r.upsert('g-rt', { jti: 'g-rt', grantId: 'G1' }, 60);
    await a.revokeByGrantId('G1');
    assert.isUndefined(await a.find('g-at'));
  });

  test('list lê cada página do SCAN num único MGET', async ({ assert }) => {
    const client = new RedisMock();
    const a = new RedisAdapter('Session', client as any, 'list-batch');
    for (let i = 0; i < 50; i++) await a.upsert(`s${String(i).padStart(2, '0')}`, { i }, 60);
    await new RedisAdapter('Grant', client as any, 'list-batch').upsert('g1', { other: true }, 60);

    const calls = { get: 0, mget: 0, scan: 0 };
    for (const command of Object.keys(calls) as Array<keyof typeof calls>) {
      const original = (client as any)[command].bind(client);
      (client as any)[command] = (...args: unknown[]) => {
        calls[command]++;
        return original(...args);
      };
    }

    const rows = await a.list();
    assert.lengthOf(rows, 50);
    assert.deepEqual(rows[0], { id: 's00', payload: { i: 0 } });
    assert.equal(calls.get, 0);
    assert.isAtMost(calls.mget, calls.scan);
  });
});
