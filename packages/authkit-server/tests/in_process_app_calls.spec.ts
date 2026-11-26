/**
 * The in-process `authkit.client` (calls between apps without authkit-client, e.g. the Agora Hub):
 * tokens minted through this server's real token endpoint (in memory, no port), the grant applied
 * exactly as for a remote client, verified with this server's own keys, and the key directory in
 * its own table.
 */
import { Server } from 'node:net';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import { decodeJwt } from 'jose';
import { adapters, defineConfig, type ResolvedServerConfig } from '../src/define_config.js';
import { AdminClientsService } from '../src/host/admin_clients_service.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { ensureAuthkitSchema } from '../src/schema/ensure.js';
import {
  appNamesOf,
  bindInProcessAppCalls,
  InProcessAppCalls,
  InProcessAppCallsError,
} from '../src/service_tenants/in_process_app_calls.js';
import { createTestDatabase, fakeAccountStore } from './bootstrap.js';

const ISSUER = 'https://hub.test/oidc';
const JWK = {
  kty: 'OKP' as const,
  crv: 'X25519',
  x: 'q1Wd3bH4vYbLwOqS9C3p5vH0k3Dq3dU7J0x2pQzKc3A',
};

async function setup(db: any, serviceTenants: Record<string, unknown> = {}) {
  await ensureAuthkitSchema(db, { accountTable: 'users' });
  const cfg = (await configProvider.resolve(
    { container: { make: async () => db } } as any,
    defineConfig({
      issuer: ISSUER,
      adapter: adapters.database({}),
      jwks: { source: 'managed', algorithm: 'RS256' },
      accountStore: fakeAccountStore(),
      serviceTenants: serviceTenants as any,
    }),
  )) as ResolvedServerConfig;
  const service = new OidcService(cfg, 'a'.repeat(32));
  const clients = new AdminClientsService(service);
  const serviceTenant = async (
    clientId: string,
    partition: string,
    apps: Record<string, string[]> = {},
  ) =>
    clients.create({
      clientId,
      redirectUris: [],
      postLogoutRedirectUris: [],
      grantTypes: ['client_credentials'],
      tokenEndpointAuthMethod: 'client_secret_basic',
      serviceTenant: { partition, capabilities: [], apps },
    });
  await serviceTenant('hub-client', 'hub', { shop: ['durable:console:*'] });
  await serviceTenant('shop-client', 'shop');
  const warnings: string[] = [];
  const facade = (names: string | string[]) =>
    new InProcessAppCalls({
      server: async () => service as any,
      db: async () => db,
      appNames: Array.isArray(names) ? names : [names],
      logger: { warn: (_o, msg) => void warnings.push(msg) },
    });
  return { service, clients, facade, warnings, serviceTenant };
}

test.group('in-process authkit.client (calls between apps on the Hub)', (group) => {
  let db: ReturnType<typeof createTestDatabase>;
  group.each.setup(async () => {
    db = createTestDatabase();
    return () => db.manager.closeAll();
  });

  test('mints through the real token endpoint for its own service client', async ({ assert }) => {
    const { facade } = await setup(db);
    const hub = facade('hub');
    const token = await hub.appCallTokens().token('shop');
    const claims = decodeJwt(token);
    assert.equal(claims.aud, 'urn:agora:app:shop');
    assert.equal(claims.partition, 'hub');
    assert.equal(claims.client_id, 'hub-client');
    assert.deepEqual(claims.capabilities, ['durable:console:*']);
    // Cached until close to expiry; reset() mints again.
    assert.equal(await hub.appCallTokens().token('shop'), token);
    hub.appCallTokens().reset();
    assert.notEqual(await hub.appCallTokens().token('shop'), token);
  });

  test('mints in memory: no port is opened', async ({ assert }) => {
    const { facade } = await setup(db);
    const listen = Server.prototype.listen;
    let listened = 0;
    Server.prototype.listen = function (this: Server, ...args: Parameters<typeof listen>) {
      listened++;
      return listen.apply(this, args);
    } as typeof listen;
    try {
      const token = await facade('hub').appCallTokens().token('shop');
      assert.equal(decodeJwt(token).aud, 'urn:agora:app:shop');
    } finally {
      Server.prototype.listen = listen;
    }
    assert.equal(listened, 0);
  });

  test('the grant applies exactly as for a remote client (no grant → refused)', async ({
    assert,
  }) => {
    const { facade } = await setup(db);
    const error = await facade('hub')
      .appCallTokens()
      .token('billing')
      .catch((e) => e);
    assert.instanceOf(error, InProcessAppCallsError);
    assert.match(error.message, /invalid_target/);
    assert.match(error.message, /grant-app hub-client billing/);
  });

  test('verifies with its own keys: the caller, never a token for another app', async ({
    assert,
  }) => {
    const { facade } = await setup(db);
    const token = await facade('hub').appCallTokens().token('shop');
    const caller = await facade('shop').appCallerVerifier().verifyToken(token);
    assert.containsSubset(caller, {
      app: 'hub',
      clientId: 'hub-client',
      capabilities: ['durable:console:*'],
    });
    // Addressed to shop, not to hub.
    assert.isNull(await facade('hub').appCallerVerifier().verifyToken(token));
    assert.isNull(await facade('shop').appCallerVerifier().verifyToken('not-a-jwt'));
  });

  test('`serviceTenants.apps.client` names the client; otherwise a loud error with the line', async ({
    assert,
  }) => {
    const explicit = await setup(db, { apps: { client: 'hub-client' } });
    const token = await explicit.facade('any-name').appCallTokens().token('shop');
    assert.equal(decodeJwt(token).partition, 'hub');

    const error = await explicit
      .facade('nobody')
      .appCallerVerifier()
      .verifyToken(token)
      .then(
        () => null,
        (e) => e,
      );
    // The explicit client wins over the app name, so this verifies as hub (not an error).
    assert.isNull(error);

    // Ambiguous (no name matches, two clients granted other apps): the error names the line.
    const other = createTestDatabase();
    try {
      const two = await setup(other);
      await two.serviceTenant('ops-client', 'ops', { shop: ['durable:console:read'] });
      const missing = await two
        .facade('nobody')
        .appCallTokens()
        .token('shop')
        .catch((e) => e);
      assert.instanceOf(missing, InProcessAppCallsError);
      assert.include(
        missing.message,
        "serviceTenants: { apps: { client: '<this app's service client id>' } } to config/authkit.ts",
      );
      assert.include(missing.message, 'hub-client, ops-client');
      // Quoted by the libs inside their own sentence: never a trailing period (no "ts..").
      assert.notMatch(missing.message, /\.$/);
    } finally {
      await other.manager.closeAll();
    }
  });

  test('default client: scoped package name, unscoped name, appName, then the only caller', async ({
    assert,
  }) => {
    const { facade } = await setup(db);
    const as = async (names: string[]) =>
      decodeJwt(await facade(names).appCallTokens().token('shop')).client_id;
    // A scoped package (`@educacao/hub`): AdonisJS appName is `adonisjs_app`; the unscoped name matches.
    assert.equal(await as(['@educacao/hub', 'hub', 'adonisjs_app']), 'hub-client');
    // No name matches: the only service tenant granted other apps.
    assert.equal(await as(['@educacao/agora-hub', 'agora-hub', 'adonisjs_app']), 'hub-client');
  });

  test('appNamesOf: package.json name, unscoped, then appName', async ({ assert }) => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const dir = await mkdtemp(join(tmpdir(), 'authkit-appnames-'));
    try {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@educacao/agora-hub' }));
      const appRoot = pathToFileURL(`${dir}/`);
      assert.deepEqual(await appNamesOf({ appRoot, appName: 'adonisjs_app' }), [
        '@educacao/agora-hub',
        'agora-hub',
        'adonisjs_app',
      ]);
      assert.deepEqual(await appNamesOf({ appName: 'hub' }), ['hub']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('key directory roundtrip in its own table; a bad key is logged, never thrown', async ({
    assert,
  }) => {
    const { facade, warnings } = await setup(db);
    await facade('shop').publishAppKey({ purpose: 'console:durable', jwk: JWK });
    assert.deepEqual(await facade('hub').appKey({ app: 'shop', purpose: 'console:durable' }), JWK);
    assert.isNull(await facade('hub').appKey({ app: 'shop', purpose: 'console:flags' }));

    await facade('shop').publishAppKey({
      purpose: 'console:durable',
      jwk: { ...JWK, d: 'secret' } as any,
    });
    assert.match(warnings[0]!, /private key/);
    assert.deepEqual(await facade('hub').appKey({ app: 'shop', purpose: 'console:durable' }), JWK);
  });
});

test.group('in-process authkit.client: binding', () => {
  const containerWith = (bound: string[]) => {
    const singletons = new Map<string, () => Promise<unknown>>();
    return {
      singletons,
      app: {
        appName: 'hub',
        container: {
          hasBinding: (name: string) => bound.includes(name) || singletons.has(name),
          singleton: (name: string, factory: () => Promise<unknown>) => {
            singletons.set(name, factory);
          },
          make: async () => ({}),
        },
      },
    };
  };

  test('bound as authkit.client when authkit-client is not installed', async ({ assert }) => {
    const { app, singletons } = containerWith([]);
    assert.isTrue(bindInProcessAppCalls(app));
    const facade = (await singletons.get('authkit.client')!()) as InProcessAppCalls;
    assert.instanceOf(facade, InProcessAppCalls);
    // The same instance on every make (tokens are cached on it).
    assert.strictEqual(await singletons.get('authkit.client')!(), facade);
    for (const method of ['appCallTokens', 'appCallerVerifier', 'appKey', 'publishAppKey']) {
      assert.isFunction((facade as any)[method], method);
    }
  });

  test('authkit-client wins: nothing is bound over it', ({ assert }) => {
    const { app, singletons } = containerWith(['authkit.client']);
    assert.isFalse(bindInProcessAppCalls(app));
    assert.isFalse(singletons.has('authkit.client'));
  });
});
