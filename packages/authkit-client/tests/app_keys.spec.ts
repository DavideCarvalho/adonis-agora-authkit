import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import { AuthkitClientManager } from '../providers/authkit_client_provider.js';
import { AppKeysClient, type OkpJwk, publishFix } from '../src/app_calls/keys.js';
import { defineConfig, type ResolvedClientConfig, resolvers } from '../src/define_config.js';

const ISSUER = 'https://hub.test/oidc';
const KEY: OkpJwk = { kty: 'OKP', crv: 'X25519', x: 'q1Wd3bH4vYbLwOqS9C3p5vH0k3Dq3dU7J0x2pQzKc3A' };
const BASIC = `Basic ${Buffer.from('shop-app:shop-secret').toString('base64')}`;

/** A fake Hub: records requests; `keys` is what GET answers (404 when absent). */
function fakeHub(opts: { putStatus?: number[]; getStatus?: number } = {}) {
  const requests: Array<{ method: string; url: string; auth?: string; body?: any }> = [];
  const store = new Map<string, OkpJwk[]>();
  const putStatus = [...(opts.putStatus ?? [])];
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const headers = init.headers as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url, auth: headers?.authorization, body });
    if (method === 'PUT') {
      const status = putStatus.shift() ?? 200;
      if (status === 200) {
        for (const k of body.keys) store.set(k.purpose, [k.jwk]);
      }
      return new Response('{}', { status });
    }
    if (opts.getStatus) return new Response('{}', { status: opts.getStatus });
    const u = new URL(url);
    const keys = store.get(u.searchParams.get('purpose') ?? '');
    return keys
      ? Response.json({ app: 'shop', purpose: u.searchParams.get('purpose'), keys })
      : new Response('{}', { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, requests, store };
}

function warnings() {
  const seen: string[] = [];
  return { seen, logger: { warn: (_o: object, msg: string) => void seen.push(msg) } };
}

const client = (hub: ReturnType<typeof fakeHub>, extra: Record<string, unknown> = {}) =>
  new AppKeysClient({
    issuer: ISSUER,
    clientId: 'shop-app',
    clientSecret: 'shop-secret',
    fetch: hub.fetch,
    ...extra,
  });

test.group('app key directory — client', () => {
  test('publish sends the key with the service credentials', async ({ assert }) => {
    const hub = fakeHub();
    await client(hub).publish({ purpose: 'console:durable', jwk: KEY });
    assert.deepEqual(hub.requests[0], {
      method: 'PUT',
      url: 'https://hub.test/api/apps/keys',
      auth: BASIC,
      body: { keys: [{ purpose: 'console:durable', jwk: KEY }] },
    });
  });

  test('a private key or a bad purpose is never sent, and publish never rejects', async ({
    assert,
  }) => {
    const hub = fakeHub();
    const { seen, logger } = warnings();
    const c = client(hub, { logger });
    await c.publish({ purpose: 'console:durable', jwk: { ...KEY, d: 'secret' } as any });
    await c.publish({ purpose: 'Bad Purpose', jwk: KEY });
    assert.lengthOf(hub.requests, 0);
    assert.match(seen[0]!, /private key/);
    assert.match(seen[1]!, /purpose must match/);
  });

  test('a failed publish is retried in the background; a refusal is not', async ({ assert }) => {
    const hub = fakeHub({ putStatus: [503, 503, 200] });
    const c = client(hub, { retryDelaysMs: [5, 5, 5] });
    await c.publish({ purpose: 'console:durable', jwk: KEY });
    assert.lengthOf(hub.requests, 1); // resolved after the first attempt
    await new Promise((r) => setTimeout(r, 50));
    assert.lengthOf(hub.requests, 3);

    const refused = fakeHub({ putStatus: [401] });
    await client(refused, { retryDelaysMs: [5] }).publish({ purpose: 'p', jwk: KEY });
    await new Promise((r) => setTimeout(r, 30));
    assert.lengthOf(refused.requests, 1);

    const down = fakeHub();
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof globalThis.fetch;
    await assert.doesNotReject(() =>
      new AppKeysClient({
        issuer: ISSUER,
        clientId: 'a',
        clientSecret: 'b',
        fetch: failing,
        retryDelaysMs: [],
      }).publish({ purpose: 'p', jwk: KEY }),
    );
    assert.lengthOf(down.requests, 0);
  });

  test('a failed publish is logged once (status + fix), then retried quietly', async ({
    assert,
  }) => {
    const hub = fakeHub({ putStatus: [500, 503, 500, 200] });
    const { seen, logger } = warnings();
    await client(hub, { logger, retryDelaysMs: [5, 5, 5] }).publish({
      purpose: 'console:durable',
      jwk: KEY,
    });
    await new Promise((r) => setTimeout(r, 60));
    assert.lengthOf(hub.requests, 4);
    assert.lengthOf(seen, 1);
    assert.include(seen[0]!, 'HTTP 500');
    assert.include(seen[0]!, 'agora:doctor');
    assert.include(seen[0]!, 'Retrying in the background');
  });

  test('each status names its fix', ({ assert }) => {
    const url = 'https://hub.test/api/apps/keys';
    assert.match(publishFix(undefined, url), /unreachable at https:\/\/hub\.test/);
    assert.match(publishFix(401, url), /clientId\/clientSecret/);
    assert.match(publishFix(404, url), /upgrade @adonis-agora\/authkit-server/);
    assert.match(publishFix(503, url), /auth_app_keys table is missing/);
  });

  test('a refusal is logged once and not retried', async ({ assert }) => {
    const hub = fakeHub({ putStatus: [401] });
    const { seen, logger } = warnings();
    await client(hub, { logger, retryDelaysMs: [5] }).publish({ purpose: 'p', jwk: KEY });
    await new Promise((r) => setTimeout(r, 30));
    assert.lengthOf(hub.requests, 1);
    assert.lengthOf(seen, 1);
    assert.include(seen[0]!, 'HTTP 401');
    assert.notInclude(seen[0]!, 'Retrying');
  });

  test('get: fetched with the credentials, cached 5 min, null when none', async ({ assert }) => {
    const hub = fakeHub();
    let now = 0;
    const c = client(hub, { now: () => now });
    assert.isNull(await c.get({ app: 'shop', purpose: 'console:durable' }));
    hub.store.set('console:durable', [KEY]);
    // A miss is not cached: the next call asks again.
    assert.deepEqual(await c.get({ app: 'shop', purpose: 'console:durable' }), KEY);
    assert.equal(
      hub.requests[1]!.url,
      'https://hub.test/api/apps/shop/keys?purpose=console%3Adurable',
    );
    assert.equal(hub.requests[1]!.auth, BASIC);
    now = 4 * 60_000;
    await c.get({ app: 'shop', purpose: 'console:durable' });
    assert.lengthOf(hub.requests, 2); // from cache
    now = 5 * 60_000 + 1;
    await c.get({ app: 'shop', purpose: 'console:durable' });
    assert.lengthOf(hub.requests, 3); // expired: refetched
  });

  test('get: concurrent calls share one request; an error keeps the last key', async ({
    assert,
  }) => {
    const hub = fakeHub();
    hub.store.set('p', [KEY]);
    let now = 0;
    const c = client(hub, { now: () => now });
    await Promise.all([c.get({ app: 'shop', purpose: 'p' }), c.get({ app: 'shop', purpose: 'p' })]);
    assert.lengthOf(hub.requests, 1);

    const broken = fakeHub({ getStatus: 500 });
    const { logger } = warnings();
    const d = client(broken, { logger, now: () => now });
    assert.isNull(await d.get({ app: 'shop', purpose: 'p' }));
    now = 10 * 60_000;
    assert.deepEqual(await c.get({ app: 'shop', purpose: 'p' }), KEY);
  });
});

test.group('app key directory — manager', () => {
  async function manager(service: Record<string, unknown> | undefined, fetchImpl: any) {
    const resolved = await configProvider.resolve<ResolvedClientConfig>(
      {} as any,
      defineConfig({
        issuer: ISSUER,
        clientId: 'web',
        redirectUri: 'https://shop.test/cb',
        resolver: resolvers.jwt({ jwksUri: `${ISSUER}/jwks` }),
        ...(service ? { service: service as any } : {}),
      }),
    );
    const { seen, logger } = warnings();
    return { mgr: new AuthkitClientManager(resolved!, { fetchImpl, logger }), seen };
  }

  test('publishAppKey + appKey go through the service credentials', async ({ assert }) => {
    const hub = fakeHub();
    const { mgr } = await manager(
      { name: 'shop', clientId: 'shop-app', clientSecret: 'shop-secret' },
      hub.fetch,
    );
    await mgr.publishAppKey({ purpose: 'console:durable', jwk: KEY });
    assert.deepEqual(await mgr.appKey({ app: 'shop', purpose: 'console:durable' }), KEY);
    assert.isTrue(hub.requests.every((r) => r.auth === BASIC));
  });

  test('without service credentials: a warning, nothing sent, appKey null', async ({ assert }) => {
    const hub = fakeHub();
    const { mgr, seen } = await manager(undefined, hub.fetch);
    await mgr.publishAppKey({ purpose: 'console:durable', jwk: KEY });
    assert.isNull(await mgr.appKey({ app: 'shop', purpose: 'console:durable' }));
    assert.lengthOf(hub.requests, 0);
    assert.match(seen[0]!, /publishAppKey needs `service/);
  });
});
