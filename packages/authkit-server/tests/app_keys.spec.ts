import { generateKeyPairSync } from 'node:crypto';
import { test } from '@japa/runner';
import { listAppCatalogsHandler } from '../src/host/app_catalog.js';
import {
  listAppKeysHandler,
  publishAppKeysHandler,
  readAppKeysHandler,
} from '../src/host/app_keys.js';
import { authkitCsrfExceptions } from '../src/host/csrf.js';
import { ensureAuthkitSchema } from '../src/schema/ensure.js';
import { MAX_KEYS_PER_PURPOSE, validateAppKeys } from '../src/service_tenants/app_keys.js';
import { createTestDatabase } from './bootstrap.js';

const CLIENTS: Record<string, Record<string, unknown>> = {
  durable: {
    client_id: 'durable-app',
    client_secret: 'durable-secret',
    authkit_service_tenant: { partition: 'shop', capabilities: [] },
  },
  hub: {
    client_id: 'hub',
    client_secret: 'hub-secret',
    authkit_service_tenant: { partition: 'hub', capabilities: [] },
  },
  off: {
    client_id: 'off',
    client_secret: 'x',
    authkit_disabled: true,
    authkit_service_tenant: { partition: 'off', capabilities: [] },
  },
  web: { client_id: 'web', client_secret: 'web-secret' },
};

class MemoryAdapter {
  constructor(readonly model: string) {}
  async find(id: string) {
    return this.model === 'Client'
      ? Object.values(CLIENTS).find((c) => c.client_id === id)
      : undefined;
  }
}

const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;
const SHOP = basic('durable-app', 'durable-secret');
const HUB = basic('hub', 'hub-secret');

function okp(): Record<string, string> {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const pub = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  const priv = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  return { ...pub, privateD: priv.d! };
}
const publicOf = ({ privateD: _d, ...jwk }: Record<string, string>) => jwk;

function fakeCtx(
  db: any,
  opts: {
    authorization?: string;
    input?: Record<string, unknown>;
    params?: Record<string, string>;
    qs?: Record<string, string>;
    audit?: unknown[];
  },
) {
  const reply: { status: number; body?: unknown } = { status: 200 };
  const fail = (status: number) => (body: unknown) => {
    reply.status = status;
    reply.body = body;
    return reply;
  };
  return {
    reply,
    ctx: {
      containerResolver: {
        make: async (key: string) =>
          key === 'lucid.db'
            ? db
            : {
                config: {
                  AdapterClass: MemoryAdapter,
                  schema: {},
                  audit: { record: async (e: unknown) => opts.audit?.push(e) },
                },
              },
      },
      request: {
        header: (name: string) => (name === 'authorization' ? opts.authorization : undefined),
        input: (name: string) => opts.input?.[name],
        param: (name: string) => opts.params?.[name],
        qs: () => opts.qs ?? {},
        ip: () => '203.0.113.5',
      },
      response: {
        header: () => {},
        unauthorized: fail(401),
        badRequest: fail(400),
        notFound: fail(404),
        unprocessableEntity: fail(422),
        serviceUnavailable: fail(503),
      },
    },
  };
}

test.group('app key directory — validation', () => {
  test('a private key (`d`) is refused', ({ assert }) => {
    const key = okp();
    const result = validateAppKeys([
      { purpose: 'console:durable', jwk: { ...publicOf(key), d: key.privateD } },
    ]);
    assert.match((result as { error: string }).error, /private key/);
  });

  test('only public OKP JWKs, with a valid purpose and bounded counts', ({ assert }) => {
    const jwk = publicOf(okp());
    const error = (raw: unknown) => (validateAppKeys(raw) as { error?: string }).error;
    assert.instanceOf(validateAppKeys([{ purpose: 'console:durable', jwk }]), Map);
    assert.match(error([]) ?? '', /non-empty/);
    assert.match(error([{ purpose: 'Console', jwk }]) ?? '', /purpose/);
    assert.match(error([{ purpose: 'x'.repeat(65), jwk }]) ?? '', /purpose/);
    assert.match(error([{ purpose: 'p', jwk: { kty: 'RSA', n: 'x', e: 'AQAB' } }]) ?? '', /OKP|n/);
    assert.match(error([{ purpose: 'p', jwk: { ...jwk, crv: 'P-256' } }]) ?? '', /crv/);
    assert.match(error([{ purpose: 'p', jwk: { ...jwk, extra: 1 } }]) ?? '', /extra/);
    const many = Array.from({ length: MAX_KEYS_PER_PURPOSE + 1 }, () => ({
      purpose: 'p',
      jwk: publicOf(okp()),
    }));
    assert.match(error(many) ?? '', /at most/);
  });
});

test.group('app key directory — endpoints', (group) => {
  let db: ReturnType<typeof createTestDatabase>;
  group.each.setup(async () => {
    db = createTestDatabase();
    await ensureAuthkitSchema(db, { accountTable: 'users' });
    return () => db.manager.closeAll();
  });

  test('the app publishes its keys; any service client reads them', async ({ assert }) => {
    const jwk = publicOf(okp());
    const audit: any[] = [];
    const put = fakeCtx(db, {
      authorization: SHOP,
      input: { keys: [{ purpose: 'console:durable', jwk }] },
      audit,
    });
    await publishAppKeysHandler(put.ctx);
    assert.equal(put.reply.status, 200);
    assert.equal(audit[0].type, 'app.keys_published');
    assert.equal(audit[0].metadata.app, 'shop');

    const get = fakeCtx(db, {
      authorization: HUB,
      params: { app: 'shop' },
      qs: { purpose: 'console:durable' },
    });
    const body: any = await readAppKeysHandler(get.ctx);
    assert.equal(get.reply.status, 200);
    assert.deepEqual(body.keys, [jwk]);
    assert.equal(body.app, 'shop');
  });

  test('a publish replaces only the purposes it names', async ({ assert }) => {
    const a = publicOf(okp());
    const b = publicOf(okp());
    const c = publicOf(okp());
    for (const keys of [
      [
        { purpose: 'console:durable', jwk: a },
        { purpose: 'console:flags', jwk: b },
      ],
      [{ purpose: 'console:durable', jwk: c }],
    ]) {
      await publishAppKeysHandler(fakeCtx(db, { authorization: SHOP, input: { keys } }).ctx);
    }
    const read = async (purpose: string) =>
      (
        (await readAppKeysHandler(
          fakeCtx(db, { authorization: HUB, params: { app: 'shop' }, qs: { purpose } }).ctx,
        )) as any
      ).keys;
    assert.deepEqual(await read('console:durable'), [c]);
    assert.deepEqual(await read('console:flags'), [b]);
    const list: any = await listAppKeysHandler(fakeCtx(db, { qs: { app: 'shop' } }).ctx);
    assert.lengthOf(list.keys, 2);
  });

  test('authentication is required on both, and only service clients pass', async ({ assert }) => {
    const jwk = publicOf(okp());
    for (const authorization of [
      undefined,
      basic('durable-app', 'wrong'),
      basic('off', 'x'),
      basic('web', 'web-secret'),
    ]) {
      const put = fakeCtx(db, {
        authorization,
        input: { keys: [{ purpose: 'console:durable', jwk }] },
      });
      await publishAppKeysHandler(put.ctx);
      assert.equal(put.reply.status, 401, String(authorization));
      const get = fakeCtx(db, {
        authorization,
        params: { app: 'shop' },
        qs: { purpose: 'console:durable' },
      });
      await readAppKeysHandler(get.ctx);
      assert.equal(get.reply.status, 401, String(authorization));
    }
  });

  test('`d` is refused with 422 and nothing is stored', async ({ assert }) => {
    const key = okp();
    const put = fakeCtx(db, {
      authorization: SHOP,
      input: { keys: [{ purpose: 'console:durable', jwk: { ...publicOf(key), d: key.privateD } }] },
    });
    await publishAppKeysHandler(put.ctx);
    assert.equal(put.reply.status, 422);
    assert.equal((put.reply.body as any).error, 'invalid_keys');
    const get = fakeCtx(db, {
      authorization: HUB,
      params: { app: 'shop' },
      qs: { purpose: 'console:durable' },
    });
    await readAppKeysHandler(get.ctx);
    assert.equal(get.reply.status, 404);
  });

  test('404 when none, 400 without a valid purpose', async ({ assert }) => {
    const none = fakeCtx(db, { authorization: HUB, params: { app: 'shop' }, qs: { purpose: 'x' } });
    await readAppKeysHandler(none.ctx);
    assert.equal(none.reply.status, 404);
    const noPurpose = fakeCtx(db, { authorization: HUB, params: { app: 'shop' } });
    await readAppKeysHandler(noPurpose.ctx);
    assert.equal(noPurpose.reply.status, 400);
  });

  test('the publish endpoint is CSRF-exempt by default', ({ assert }) => {
    assert.isTrue(authkitCsrfExceptions('/api/apps/keys'));
    assert.isFalse(authkitCsrfExceptions('/api/apps/keys', { appKeys: false }));
    assert.isFalse(authkitCsrfExceptions('/api/apps/shop/keys'));
  });
});

test.group('/api/apps: errors are JSON, never a stack trace', () => {
  const ctxThatThrows = (error: Error) => {
    const reply: { status: number; body?: any } = { status: 200 };
    const logged: unknown[] = [];
    const ctx = {
      logger: { error: (obj: unknown) => void logged.push(obj) },
      containerResolver: {
        make: async (key: string) => {
          if (key === 'lucid.db') {
            return {
              connection: () => ({
                from: () => {
                  throw error;
                },
              }),
            };
          }
          return {
            config: {
              AdapterClass: MemoryAdapter,
              schema: { name: 'entretextos' },
            },
          };
        },
      },
      request: {
        header: () => HUB,
        input: () => undefined,
        param: () => 'shop',
        qs: () => ({ purpose: 'console:durable' }),
      },
      response: {
        header: () => {},
        status: (s: number) => {
          reply.status = s;
          return {
            send: (b: any) => {
              reply.body = b;
              return b;
            },
          };
        },
      },
    };
    return { ctx, reply, logged };
  };

  test('a missing table → 503 schema_missing with the fix; logged server-side', async ({
    assert,
  }) => {
    const pgMissing = Object.assign(
      new Error('relation "entretextos.auth_app_keys" does not exist'),
      {
        code: '42P01',
      },
    );
    for (const handler of [readAppKeysHandler, listAppKeysHandler, listAppCatalogsHandler]) {
      const { ctx, reply, logged } = ctxThatThrows(pgMissing);
      await handler(ctx);
      assert.equal(reply.status, 503);
      assert.equal(reply.body.error, 'schema_missing');
      assert.include(reply.body.message, 'ensureAuthkitSchema');
      assert.notMatch(JSON.stringify(reply.body), /\bat .+:\d+:\d+/);
      assert.notProperty(reply.body, 'stack');
      assert.lengthOf(logged, 1);
    }
  });

  test('any other failure → 500 server_error, no stack, no message leak', async ({ assert }) => {
    const { ctx, reply } = ctxThatThrows(new Error('password=hunter2 connection refused'));
    await readAppKeysHandler(ctx);
    assert.equal(reply.status, 500);
    assert.equal(reply.body.error, 'server_error');
    assert.notInclude(JSON.stringify(reply.body), 'hunter2');
    assert.notProperty(reply.body, 'stack');
  });
});
