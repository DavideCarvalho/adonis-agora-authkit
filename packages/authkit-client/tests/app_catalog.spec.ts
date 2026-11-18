import { test } from '@japa/runner';
import {
  publishAppCatalog,
  publishAppCatalogInBackground,
  readAppCatalog,
} from '../src/app_calls/catalog.js';
import { resolveAppCalls } from '../src/app_calls/config.js';

const SLOT = Symbol.for('@adonis-agora/authz:catalog');
const slots = globalThis as Record<symbol, unknown>;

/** A fetch that records each call and answers `status`. */
function recordingFetch(statuses: number[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status: statuses.shift() ?? 204 });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
};

test.group('app catalog', (group) => {
  group.each.teardown(() => {
    delete slots[SLOT];
  });

  test('reads authz by default, nothing without it', async ({ assert }) => {
    assert.isNull(await readAppCatalog(undefined));
    slots[SLOT] = { permissions: async () => ['reports:export', 'media:objects:read'] };
    assert.deepEqual(await readAppCatalog(undefined), {
      capabilities: ['media:objects:read', 'reports:export'],
      dropped: [],
    });
  });

  test('"authz" without authz throws; false publishes nothing', async ({ assert }) => {
    await assert.rejects(() => readAppCatalog('authz'), /not booted/);
    slots[SLOT] = { permissions: async () => ['a:b'] };
    assert.isNull(await readAppCatalog(false));
  });

  test('a function of your own; invalid names are dropped', async ({ assert }) => {
    assert.deepEqual(await readAppCatalog(async () => ['b:c', 'a', 'has space', 'a']), {
      capabilities: ['a', 'b:c'],
      dropped: ['has space'],
    });
  });

  test('PUTs with the service tenant credentials to the issuer origin', async ({ assert }) => {
    const { calls, fetch } = recordingFetch([200]);
    const status = await publishAppCatalog({
      issuer: 'https://hub.example.com/oidc',
      clientId: 'et',
      clientSecret: 's3cret',
      capabilities: ['media:objects:read'],
      fetch,
    });
    assert.equal(status, 200);
    assert.equal(calls[0]?.url, 'https://hub.example.com/api/apps/catalog');
    assert.equal(calls[0]?.init.method, 'PUT');
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Basic ${Buffer.from('et:s3cret').toString('base64')}`);
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      capabilities: ['media:objects:read'],
    });
  });

  test('the background publish retries a failure, not a refusal', async ({ assert }) => {
    slots[SLOT] = { permissions: async () => ['a:b'] };
    const retried = recordingFetch([503, 204]);
    publishAppCatalogInBackground({
      issuer: 'https://hub.example.com/oidc',
      clientId: 'et',
      clientSecret: 'x',
      source: undefined,
      fetch: retried.fetch,
      retryDelaysMs: [1],
    });
    await waitFor(() => retried.calls.length === 2);
    assert.lengthOf(retried.calls, 2);

    const refused = recordingFetch([401, 204]);
    const warnings: string[] = [];
    publishAppCatalogInBackground({
      issuer: 'https://hub.example.com/oidc',
      clientId: 'et',
      clientSecret: 'x',
      source: undefined,
      fetch: refused.fetch,
      retryDelaysMs: [1],
      logger: { warn: (_o, m) => warnings.push(m) },
    });
    await waitFor(() => warnings.length > 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.lengthOf(refused.calls, 1);
    assert.match(warnings[0] ?? '', /refused/);
  });

  test('publishes nothing without a source', async ({ assert }) => {
    const { calls, fetch } = recordingFetch([]);
    publishAppCatalogInBackground({
      issuer: 'https://hub.example.com/oidc',
      clientId: 'et',
      clientSecret: 'x',
      source: undefined,
      fetch,
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.lengthOf(calls, 0);
  });

  test('config: validates service.catalog', ({ assert }) => {
    assert.equal(resolveAppCalls({ name: 'et', catalog: false }, undefined)?.catalog, false);
    assert.isFunction(resolveAppCalls({ name: 'et', catalog: () => [] }, undefined)?.catalog);
    assert.throws(
      () => resolveAppCalls({ name: 'et', catalog: 'nope' as never }, undefined),
      /service\.catalog/,
    );
    assert.throws(
      () => resolveAppCalls({ name: 'et', catalogEndpoint: 'not a url' }, undefined),
      /catalogEndpoint/,
    );
  });
});
