import { test } from '@japa/runner';
import { AppCallerVerifier } from '../src/app_calls/inbound.js';
import { __clearDiscoveryCacheForTests } from '../src/discovery.js';
import { type MemoryIssuer, startMemoryIssuer } from './helpers/memory_issuer.js';

/**
 * `AppCallerVerifier.verifyToken`: the service-token check without an HTTP request, for the
 * channels that carry a token some other way (a Redis command, a queue job).
 */
test.group('AppCallerVerifier.verifyToken (non-HTTP channels)', (group) => {
  let idp: MemoryIssuer;
  group.setup(async () => {
    idp = await startMemoryIssuer();
    return async () => {
      __clearDiscoveryCacheForTests();
      await idp.close();
    };
  });

  const claims = {
    sub: 'orders',
    client_id: 'orders',
    partition: 'orders',
    capabilities: ['invoices:read'],
    aud: 'urn:agora:app:billing',
  };
  const verifier = (environment?: string) =>
    new AppCallerVerifier({
      issuer: idp.issuer,
      name: 'billing',
      ...(environment ? { environment } : {}),
    });

  test('a valid service token for this app → the caller', async ({ assert }) => {
    const caller = await verifier().verifyToken(await idp.sign(claims));
    assert.containsSubset(caller, {
      app: 'orders',
      capabilities: ['invoices:read'],
      clientId: 'orders',
    });
    assert.isAbove(caller!.expiresAt, Date.now());
  });

  test('every bad token → null, never a throw', async ({ assert }) => {
    const v = verifier();
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      '',
      'not-a-jwt',
      'a.b.c',
      await idp.sign({ ...claims, aud: 'urn:agora:app:reports' }),
      await idp.sign({ ...claims, iat: now - 900, exp: now - 600 }),
      await idp.sign(claims, { key: 'foreign' }),
      await idp.sign(claims, { typ: 'JWT' }),
      await idp.sign({ ...claims, partition: undefined }),
      await idp.sign({ ...claims, sub: 'someone-else' }),
    ];
    for (const token of bad) assert.isNull(await v.verifyToken(token), token);
    assert.isNull(await v.verifyToken(undefined as any));
  });

  test('environment pinning: another or a missing environment → null', async ({ assert }) => {
    const v = verifier('production');
    assert.isNull(await v.verifyToken(await idp.sign({ ...claims, environment: 'staging' })));
    assert.isNull(await v.verifyToken(await idp.sign(claims)));
    const caller = await v.verifyToken(await idp.sign({ ...claims, environment: 'production' }));
    assert.equal(caller?.environment, 'production');
  });
});
