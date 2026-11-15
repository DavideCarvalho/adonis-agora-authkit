import { test } from '@japa/runner';
import { Authenticator } from '../src/authenticator.js';
import {
  __clearOrgLabelsForTests,
  authkitOrgLabels,
  installOrgLabeler,
} from '../src/org_labels.js';
import { buildIdentityFromClaims } from '../src/resolvers/identity.js';

const ISSUER = 'https://auth.acme.test/oidc';

function fakeLabels(labels: Record<string, string>, status = 200) {
  const calls: Array<{ url: string; authorization: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, authorization: (init.headers as Record<string, string>).authorization });
    const ids = new URL(url).searchParams.get('ids')?.split(',') ?? [];
    const body = {
      labels: Object.fromEntries(ids.filter((id) => labels[id]).map((id) => [id, labels[id]])),
    };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test.group('authkitOrgLabels', (group) => {
  group.each.setup(() => __clearOrgLabelsForTests());

  test('asks the issuer origin with the client credentials, then caches hits and misses', async ({
    assert,
  }) => {
    const ep = fakeLabels({ 'org-1': 'Acme', 'org-2': 'Globex' });
    const labels = authkitOrgLabels({
      issuer: ISSUER,
      clientId: 'web',
      clientSecret: 'secret',
      fetch: ep.fetchImpl,
    });
    assert.deepEqual(await labels(['org-1', 'org-2', 'user-9']), {
      'org-1': 'Acme',
      'org-2': 'Globex',
    });
    assert.lengthOf(ep.calls, 1);
    const url = new URL(ep.calls[0].url);
    assert.equal(url.origin + url.pathname, 'https://auth.acme.test/api/orgs/labels');
    assert.equal(url.searchParams.get('ids'), 'org-1,org-2,user-9');
    assert.equal(
      ep.calls[0].authorization,
      `Basic ${Buffer.from('web:secret').toString('base64')}`,
    );

    assert.deepEqual(await labels(['org-1', 'user-9']), { 'org-1': 'Acme' });
    assert.lengthOf(ep.calls, 1, 'hits and misses are cached');
  });

  test('the active org comes from the session claims, with no call', async ({ assert }) => {
    const ep = fakeLabels({});
    const labels = authkitOrgLabels({
      issuer: ISSUER,
      clientId: 'web',
      clientSecret: 'secret',
      fetch: ep.fetchImpl,
    });
    const identity = buildIdentityFromClaims(
      { sub: 'u1', org_id: 'org-7', org_name: 'Initech', iat: 1, exp: 2 },
      'roles',
    );
    await new Authenticator({} as any, {
      resolver: { resolve: async () => identity },
    }).getIdentity();
    assert.deepEqual(await labels(['org-7']), { 'org-7': 'Initech' });
    assert.lengthOf(ep.calls, 0);
  });

  test('another tenant kind gets no label; a failing server answers what is known', async ({
    assert,
  }) => {
    const down = fakeLabels({ 'org-1': 'Acme' }, 503);
    const labels = authkitOrgLabels({
      issuer: ISSUER,
      clientId: 'web',
      clientSecret: 'secret',
      fetch: down.fetchImpl,
    });
    assert.deepEqual(await labels(['org-1'], { kind: 'user' }), {});
    assert.lengthOf(down.calls, 0);
    assert.deepEqual(await labels(['org-1']), {});
    assert.deepEqual(await labels(['org-1']), {});
    assert.lengthOf(down.calls, 2, 'a failure is not cached');
  });

  test('installs into @adonis-agora/context through its tenancy slot', ({ assert, cleanup }) => {
    const slot = Symbol.for('@agora/context:tenancy');
    const previous = (globalThis as any)[slot];
    cleanup(() => {
      (globalThis as any)[slot] = previous;
    });
    let installed: unknown;
    (globalThis as any)[slot] = {
      version: 1,
      setTenantLabeler: (resolver: unknown) => {
        installed = resolver;
      },
    };
    const labels = authkitOrgLabels({ issuer: ISSUER, clientId: 'web', clientSecret: 's' });
    assert.isTrue(installOrgLabeler(labels));
    assert.strictEqual(installed, labels);

    (globalThis as any)[slot] = undefined;
    assert.isFalse(installOrgLabeler(labels));
  });
});
