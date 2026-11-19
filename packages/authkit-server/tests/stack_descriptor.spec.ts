import { setApp } from '@adonisjs/core/services/app';
import { test } from '@japa/runner';
import { lucidAccountStore } from '../src/accounts/lucid_account_store.js';
import { adapters } from '../src/adapters/factory.js';
import { lucidAuditSink } from '../src/audit/lucid_audit_sink.js';
import { defineConfig } from '../src/define_config.js';
import { lucidPatStore } from '../src/pat/lucid_pat_store.js';
import { STACK_DESCRIPTOR } from '../src/stack.js';

const uses = (value: object) => (value as Record<symbol, unknown>)[STACK_DESCRIPTOR];

const database = {
  connection: 'pg',
  connections: { pg: { client: 'pg' }, auth: { client: 'pg' }, lite: { client: 'better-sqlite3' } },
};

function fakeApp(config: Record<string, unknown>) {
  setApp({ config: { get: (key: string) => config[key] } } as never);
}

/** An account store that describes itself, as `lucidAccountStore` does. */
function accountStore(connection?: string) {
  const store = { findById: async () => null, verifyCredentials: async () => null };
  Object.defineProperty(store, STACK_DESCRIPTOR, {
    get: () => [{ tech: 'postgres', connection: connection ?? 'pg', purpose: 'accounts' }],
  });
  return store as never;
}

test.group('stack descriptors', (group) => {
  group.each.setup(() => {
    fakeApp({ database, redis: { connection: 'cache' } });
    return () => setApp(undefined as never);
  });

  test('the config provider describes adapters, accounts and the keystore', ({ assert }) => {
    const provider = defineConfig({
      issuer: 'https://auth.example.com',
      adapter: adapters.database(),
      session: { adapter: adapters.redis() },
      jwks: { source: 'managed', algorithm: 'RS256', store: { driver: 'lucid' } },
      accountStore: accountStore(),
    } as never);
    assert.equal(STACK_DESCRIPTOR, Symbol.for('@adonis-agora/stack'));
    assert.deepEqual(uses(provider), [
      { tech: 'postgres', connection: 'pg', purpose: 'oidc state' },
      { tech: 'redis', connection: 'cache', purpose: 'sessions' },
      { tech: 'postgres', connection: 'pg', purpose: 'accounts' },
      { tech: 'postgres', connection: 'pg', purpose: 'key store' },
    ]);
    assert.notInclude(Object.keys(provider), STACK_DESCRIPTOR.toString());
  });

  test('schema.connection is the default of the adapter, keystore and auth tables', ({
    assert,
  }) => {
    const provider = defineConfig({
      issuer: 'https://auth.example.com',
      schema: { connection: 'auth' },
      adapter: adapters.database(),
      jwks: { source: 'managed', store: { driver: 'lucid' } },
      accountStore: accountStore('pg'),
      patStore: lucidPatStore(class {}),
      audit: lucidAuditSink(
        class {
          static connection = 'lite';
        },
      ),
    } as never);
    assert.deepEqual(uses(provider), [
      { tech: 'postgres', connection: 'auth', purpose: 'oidc state, sessions' },
      { tech: 'postgres', connection: 'pg', purpose: 'accounts' },
      { tech: 'postgres', connection: 'auth', purpose: 'auth tables' },
      { tech: 'postgres', connection: 'pg', purpose: 'access tokens' },
      { tech: 'sqlite', connection: 'lite', purpose: 'audit log' },
      { tech: 'postgres', connection: 'auth', purpose: 'key store' },
    ]);
  });

  test('keystores without a connection carry no secret', ({ assert }) => {
    const keystore = (store: unknown) =>
      (
        uses(
          defineConfig({
            issuer: 'https://auth.example.com',
            adapter: adapters.redis({ connection: 'main' }),
            jwks: { source: 'managed', store } as never,
            accountStore: accountStore(),
          } as never),
        ) as unknown[]
      ).at(-1);
    assert.deepEqual(
      keystore({
        driver: 'hashicorp-vault',
        endpoint: 'https://vault.example.com:8200',
        path: 'authkit',
        token: 's.secret',
      }),
      {
        tech: 'vault',
        label: 'hashicorp-vault',
        host: 'vault.example.com:8200',
        purpose: 'key store',
      },
    );
    assert.deepEqual(
      keystore({ driver: 'aws-secrets-manager', secretId: 'arn:x', region: 'us-east-1' }),
      {
        tech: 'aws-secrets-manager',
        label: 'us-east-1',
        purpose: 'key store',
      },
    );
    assert.deepEqual(keystore({ driver: 'redis' }), {
      tech: 'redis',
      connection: 'cache',
      purpose: 'key store',
    });
    assert.deepEqual(keystore('tmp/jwks.json'), {
      tech: 'fs',
      label: 'tmp/jwks.json',
      purpose: 'key store',
    });
  });

  test('lucidAccountStore names the model connection (the default when unset)', ({ assert }) => {
    assert.deepEqual(uses(lucidAccountStore(class {})), [
      { tech: 'postgres', connection: 'pg', purpose: 'accounts' },
    ]);
    assert.deepEqual(
      uses(
        lucidAccountStore(
          class {
            static connection = 'lite';
          },
        ),
      ),
      [{ tech: 'sqlite', connection: 'lite', purpose: 'accounts' }],
    );
  });

  test('a crypto.kms that describes itself is forwarded', ({ assert }) => {
    const kms = { wrap: async () => new Uint8Array(), unwrap: async () => new Uint8Array() };
    Object.defineProperty(kms, STACK_DESCRIPTOR, {
      value: [{ tech: 'kms', label: 'agora-crypto', purpose: 'root key' }],
    });
    const provider = defineConfig({
      issuer: 'https://auth.example.com',
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'jwks', keys: [] },
      accountStore: accountStore(),
      crypto: { kms },
    } as never);
    assert.deepEqual(uses(provider), [
      { tech: 'redis', connection: 'main', purpose: 'oidc state, sessions' },
      { tech: 'postgres', connection: 'pg', purpose: 'accounts' },
      { tech: 'kms', label: 'agora-crypto', purpose: 'root key' },
    ]);
  });
});
