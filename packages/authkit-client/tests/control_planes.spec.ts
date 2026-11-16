import { test } from '@japa/runner';
import {
  __clearControlPlaneThrottleForTests,
  ControlPlaneNotFoundError,
  controlPlaneUrl,
  discoverControlPlane,
} from '../src/control_planes.js';
import {
  __clearDiscoveryCacheForTests,
  discoverEndpoints,
  OidcDiscoveryError,
} from '../src/discovery.js';

const ISSUER = 'https://auth.example.com';
const TELESCOPE = 'urn:agora:telescope';
const DURABLE = 'urn:agora:durable';

const doc = (planes?: unknown) => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/auth`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
  ...(planes === undefined ? {} : { agora_control_planes: planes }),
});

/** A fetch that answers with `next()` and counts its calls. */
function countingFetch(next: () => { status: number; json?: unknown }) {
  const calls: string[] = [];
  const impl = (async (input: any) => {
    calls.push(String(input));
    const r = next();
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json,
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

test.group('control planes: discovery', (group) => {
  group.each.setup(() => {
    __clearDiscoveryCacheForTests();
    __clearControlPlaneThrottleForTests();
  });

  test('resolves a control plane from agora_control_planes', async ({ assert }) => {
    const { impl, calls } = countingFetch(() => ({
      status: 200,
      json: doc({
        [TELESCOPE]: 'https://telescope.example.com',
        [DURABLE]: 'https://durable.example.com',
      }),
    }));
    const url = await discoverControlPlane({ issuer: ISSUER, resource: TELESCOPE, fetch: impl });
    assert.equal(url, 'https://telescope.example.com');
    assert.deepEqual(calls, [`${ISSUER}/.well-known/openid-configuration`]);
  });

  test('caches the discovery document across calls and resources', async ({ assert }) => {
    const { impl, calls } = countingFetch(() => ({
      status: 200,
      json: doc({
        [TELESCOPE]: 'https://telescope.example.com',
        [DURABLE]: 'https://durable.example.com',
      }),
    }));
    await discoverControlPlane({ issuer: ISSUER, resource: TELESCOPE, fetch: impl });
    await discoverControlPlane({ issuer: ISSUER, resource: TELESCOPE, fetch: impl });
    assert.equal(
      await discoverControlPlane({ issuer: ISSUER, resource: DURABLE, fetch: impl }),
      'https://durable.example.com',
    );
    assert.lengthOf(calls, 1);
  });

  test('tolerates a trailing slash on the resource', async ({ assert }) => {
    const { impl } = countingFetch(() => ({
      status: 200,
      json: doc({ 'https://cp.example.com/': 'https://cp.example.com/api' }),
    }));
    assert.equal(
      await discoverControlPlane({
        issuer: ISSUER,
        resource: 'https://cp.example.com',
        fetch: impl,
      }),
      'https://cp.example.com/api',
    );
  });

  test('a missing resource refetches once, then throws ControlPlaneNotFoundError', async ({
    assert,
  }) => {
    const { impl, calls } = countingFetch(() => ({
      status: 200,
      json: doc({ [DURABLE]: 'https://durable.example.com' }),
    }));
    const error = await discoverControlPlane({
      issuer: ISSUER,
      resource: TELESCOPE,
      fetch: impl,
    }).catch((e) => e);
    assert.instanceOf(error, ControlPlaneNotFoundError);
    assert.equal(error.code, 'E_CONTROL_PLANE_NOT_FOUND');
    assert.equal(error.resource, TELESCOPE);
    assert.match(error.message, /serviceTenants\.resources\["urn:agora:telescope"\]\.url/);
    assert.lengthOf(calls, 2);

    // The forced refetch is throttled: a second miss right away does not hit the IdP again.
    await assert.rejects(
      () => discoverControlPlane({ issuer: ISSUER, resource: TELESCOPE, fetch: impl }),
      ControlPlaneNotFoundError as any,
    );
    assert.lengthOf(calls, 2);
  });

  test('a control plane added on the IdP is found without a restart', async ({ assert }) => {
    let planes: Record<string, string> = { [DURABLE]: 'https://durable.example.com' };
    const { impl, calls } = countingFetch(() => ({ status: 200, json: doc(planes) }));
    await discoverControlPlane({ issuer: ISSUER, resource: DURABLE, fetch: impl });
    planes = { ...planes, [TELESCOPE]: 'https://telescope.example.com' };
    assert.equal(
      await discoverControlPlane({ issuer: ISSUER, resource: TELESCOPE, fetch: impl }),
      'https://telescope.example.com',
    );
    assert.lengthOf(calls, 2);
  });

  test('an issuer that publishes no control planes throws ControlPlaneNotFoundError', async ({
    assert,
  }) => {
    const { impl } = countingFetch(() => ({ status: 200, json: doc() }));
    await assert.rejects(
      () => discoverControlPlane({ issuer: ISSUER, resource: TELESCOPE, fetch: impl }),
      ControlPlaneNotFoundError as any,
    );
  });

  test('a discovery failure throws OidcDiscoveryError and is not cached', async ({ assert }) => {
    let status = 503;
    const { impl, calls } = countingFetch(() => ({
      status,
      json: doc({ [TELESCOPE]: 'https://telescope.example.com' }),
    }));
    await assert.rejects(
      () => discoverControlPlane({ issuer: ISSUER, resource: TELESCOPE, fetch: impl }),
      OidcDiscoveryError as any,
    );
    status = 200;
    assert.equal(
      await discoverControlPlane({ issuer: ISSUER, resource: TELESCOPE, fetch: impl }),
      'https://telescope.example.com',
    );
    assert.lengthOf(calls, 2);
  });

  test('ignores entries that are not http(s) URLs', async ({ assert }) => {
    const endpoints = await discoverEndpoints(ISSUER, {
      onError: 'throw',
      fetchImpl: countingFetch(() => ({
        status: 200,
        json: doc({
          [TELESCOPE]: 'https://telescope.example.com',
          [DURABLE]: 'javascript:alert(1)',
          'urn:agora:flags': 42,
        }),
      })).impl,
    });
    assert.deepEqual(endpoints.controlPlanes, { [TELESCOPE]: 'https://telescope.example.com' });
  });

  test('requires issuer and resource', ({ assert }) => {
    assert.throws(() => controlPlaneUrl({ issuer: ISSUER, resource: '' }), /issuer and resource/);
  });
});

test.group('control planes: controlPlaneUrl', (group) => {
  group.each.setup(() => {
    __clearDiscoveryCacheForTests();
    __clearControlPlaneThrottleForTests();
  });

  test('fetches nothing until called; peek() then holds the URL', async ({ assert }) => {
    const { impl, calls } = countingFetch(() => ({
      status: 200,
      json: doc({ [TELESCOPE]: 'https://telescope.example.com' }),
    }));
    const url = controlPlaneUrl({ issuer: ISSUER, resource: TELESCOPE, fetch: impl });
    assert.lengthOf(calls, 0);
    assert.isUndefined(url.peek());
    assert.equal(url.resource, TELESCOPE);
    assert.equal(await url(), 'https://telescope.example.com');
    assert.equal(url.peek(), 'https://telescope.example.com');
    await url();
    assert.lengthOf(calls, 1);
  });

  test('refresh() picks up a moved control plane', async ({ assert }) => {
    let location = 'https://telescope.example.com';
    const { impl, calls } = countingFetch(() => ({
      status: 200,
      json: doc({ [TELESCOPE]: location }),
    }));
    const url = controlPlaneUrl({ issuer: ISSUER, resource: TELESCOPE, fetch: impl });
    await url();
    location = 'https://telescope-2.example.com';
    assert.equal(await url(), 'https://telescope.example.com');
    assert.equal(await url.refresh(), 'https://telescope-2.example.com');
    assert.equal(url.peek(), 'https://telescope-2.example.com');
    assert.lengthOf(calls, 2);
  });
});
