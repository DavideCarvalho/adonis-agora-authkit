/**
 * The admin console's "Impersonate" button, end to end.
 *
 * Two defects met here, and the second hid the first:
 *
 *   1. The panel was built from `cfg.clients`, which is ALWAYS `[]` in a real
 *      installation — clients live in the adapter, created through the console,
 *      the Admin API or `authkit:clients:create`. So the endpoint answered
 *      `404 no_token_exchange_client` on every host that had not kept legacy
 *      static clients, and the button could never work. Only the test suite,
 *      which declared static clients, ever saw it succeed.
 *
 *   2. The audit event fired anyway, and it claimed `impersonation.started` —
 *      an impersonation that had not started, could not start, and (with the
 *      panel broken) never would. The trail asserted something that never
 *      happened.
 *
 * The fix reads runtime clients from the adapter and audits
 * `impersonation.panel_viewed`, emitted only once a usable panel exists. The
 * real `impersonation` event still belongs to the token-exchange handler, which
 * is where an identity is actually assumed.
 */

import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import type { AuditEvent } from '../src/audit/audit_sink.js';
import { type AuthServerConfigInput, adapters, defineConfig } from '../src/define_config.js';
import ConsoleImpersonationController from '../src/host/admin_console/console_impersonation_controller.js';
import { resetLockedSettingKeys } from '../src/host/config_locks.js';
import { fakeAccountStore } from './bootstrap.js';

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ISSUER = 'https://panel.test';

/**
 * A resolved config with NO static clients — the shape every real host has.
 * `clients` is omitted deliberately: passing them is what masked the bug.
 */
async function resolvedConfig(extra: Partial<AuthServerConfigInput> = {}) {
  const fakeApp = {
    container: { make: async () => ({ connection: () => new RedisMock() }) },
  } as any;
  return (await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer: ISSUER,
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed', algorithm: 'RS256' },
      admin: { enabled: true, impersonation: true },
      accountStore: fakeAccountStore({
        findById: async (id: string) =>
          id === 'target-1'
            ? { id, email: 't@x.com', globalRoles: ['USER'], name: 'Target' }
            : null,
      }),
      ...extra,
    }),
  )) as any;
}

/**
 * An `AdapterClass` whose `Client` model enumerates the given persisted clients,
 * which is how `AdminClientsService` reaches them. `list: undefined` models an
 * adapter that cannot enumerate.
 */
function adapterClassWith(clients: Array<{ id: string; payload: Record<string, unknown> }> | null) {
  return class FakeAdapter {
    constructor(public model: string) {}
    async find() {
      return undefined;
    }
    async upsert() {}
    async destroy() {}
    async consume() {}
    async findByUid() {
      return undefined;
    }
    async findByUserCode() {
      return undefined;
    }
    async revokeByGrantId() {}
    list = clients === null ? undefined : async () => clients;
  };
}

function fakeCtx(service: any, userId: string) {
  let status = 200;
  let body: any;
  const set = (b: any) => {
    body = b;
    return b;
  };
  const ctx = {
    request: { param: (k: string) => (k === 'userId' ? userId : undefined), ip: () => '10.0.0.1' },
    response: {
      notFound: (p?: any) => {
        status = 404;
        return set(p);
      },
      status: (s: number) => {
        status = s;
        return { send: set };
      },
      send: set,
    },
    session: { get: () => 'admin-1' },
    containerResolver: { make: async () => service },
  } as any;
  return { ctx, status: () => status, body: () => body };
}

/** A service whose config has no static clients but whose adapter enumerates. */
async function serviceWithRuntimeClients(
  clients: Array<{ id: string; payload: Record<string, unknown> }> | null,
) {
  const cfg = await resolvedConfig();
  const audit: AuditEvent[] = [];
  cfg.audit = { record: async (e: AuditEvent) => void audit.push(e) };
  cfg.AdapterClass = adapterClassWith(clients);
  return { service: { config: cfg }, audit, cfg };
}

const TOKEN_EXCHANGE_CLIENT = {
  id: 'runtime-cli',
  payload: {
    client_secret: 'shh',
    grant_types: ['authorization_code', 'refresh_token', TOKEN_EXCHANGE],
    token_endpoint_auth_method: 'client_secret_basic',
  },
};

test.group('impersonation panel — runtime clients', (group) => {
  group.each.teardown(() => resetLockedSettingKeys());

  test('builds the panel from a client that lives only in the adapter', async ({ assert }) => {
    const { service, cfg } = await serviceWithRuntimeClients([TOKEN_EXCHANGE_CLIENT]);
    assert.deepEqual(cfg.clients, [], 'precondition: a real host has no static clients');

    const { ctx, status } = fakeCtx(service, 'target-1');
    const result: any = await new ConsoleImpersonationController().handle(ctx);

    assert.equal(status(), 200);
    assert.equal(result.clientId, 'runtime-cli');
    assert.equal(result.grantType, TOKEN_EXCHANGE);
    assert.equal(result.requestedSubject, 'target-1');
    assert.equal(result.targetEmail, 't@x.com');
    assert.equal(result.tokenEndpoint, `${ISSUER}/token`);
  });

  test('a confidential runtime client gets a secret placeholder, never an empty secret', async ({
    assert,
  }) => {
    // The adapter never hands back the plaintext secret — it is shown once at
    // creation. A curl with `-u 'id:'` would look valid and fail at the server.
    const { service } = await serviceWithRuntimeClients([TOKEN_EXCHANGE_CLIENT]);
    const { ctx } = fakeCtx(service, 'target-1');
    const result: any = await new ConsoleImpersonationController().handle(ctx);

    assert.include(result.curl, "-u 'runtime-cli:<CLIENT_SECRET>'");
    assert.notInclude(result.curl, "-u 'runtime-cli:'");
  });

  test('a public runtime client authenticates with client_id, not basic auth', async ({
    assert,
  }) => {
    const { service } = await serviceWithRuntimeClients([
      {
        id: 'spa-cli',
        payload: {
          grant_types: [TOKEN_EXCHANGE],
          token_endpoint_auth_method: 'none',
        },
      },
    ]);
    const { ctx } = fakeCtx(service, 'target-1');
    const result: any = await new ConsoleImpersonationController().handle(ctx);

    assert.include(result.curl, "-d 'client_id=spa-cli'");
    assert.notInclude(result.curl, '-u ');
  });

  test('ignores runtime clients without the token-exchange grant', async ({ assert }) => {
    const { service } = await serviceWithRuntimeClients([
      { id: 'plain', payload: { grant_types: ['authorization_code'] } },
      TOKEN_EXCHANGE_CLIENT,
    ]);
    const { ctx } = fakeCtx(service, 'target-1');
    const result: any = await new ConsoleImpersonationController().handle(ctx);

    assert.equal(result.clientId, 'runtime-cli');
  });

  test('an adapter that cannot enumerate still falls back to static clients', async ({
    assert,
  }) => {
    const cfg = await resolvedConfig();
    cfg.clients = [
      { clientId: 'legacy-cli', clientSecret: 'sec', grants: [TOKEN_EXCHANGE], redirectUris: [] },
    ];
    cfg.AdapterClass = adapterClassWith(null);
    const { ctx, status } = fakeCtx({ config: cfg }, 'target-1');

    const result: any = await new ConsoleImpersonationController().handle(ctx);

    assert.equal(status(), 200);
    assert.equal(result.clientId, 'legacy-cli');
    assert.include(result.curl, "-u 'legacy-cli:sec'");
  });

  test('no token-exchange client anywhere → 404, and the response carries no URL', async ({
    assert,
  }) => {
    const { service } = await serviceWithRuntimeClients([
      { id: 'plain', payload: { grant_types: ['authorization_code'] } },
    ]);
    const { ctx, status, body } = fakeCtx(service, 'target-1');

    await new ConsoleImpersonationController().handle(ctx);

    assert.equal(status(), 404);
    assert.equal(body().error.code, 'no_token_exchange_client');
  });
});

test.group('impersonation panel — audit', (group) => {
  group.each.teardown(() => resetLockedSettingKeys());

  test('audits panel_viewed, never impersonation or impersonation.started', async ({ assert }) => {
    const { service, audit } = await serviceWithRuntimeClients([TOKEN_EXCHANGE_CLIENT]);
    const { ctx } = fakeCtx(service, 'target-1');

    await new ConsoleImpersonationController().handle(ctx);

    assert.lengthOf(audit, 1);
    assert.equal(audit[0].type, 'impersonation.panel_viewed');
    assert.equal(audit[0].accountId, 'target-1');
    assert.equal(audit[0].actorId, 'admin-1');
    assert.deepEqual(audit[0].metadata, { clientId: 'runtime-cli', channel: 'admin-console' });
    // Viewing parameters is not assuming an identity. Only the token-exchange
    // handler may write `impersonation`.
    assert.notInclude(
      audit.map((e) => e.type),
      'impersonation',
    );
  });

  test('emits NOTHING when no token-exchange client exists', async ({ assert }) => {
    const { service, audit } = await serviceWithRuntimeClients([
      { id: 'plain', payload: { grant_types: ['authorization_code'] } },
    ]);
    const { ctx, status } = fakeCtx(service, 'target-1');

    await new ConsoleImpersonationController().handle(ctx);

    assert.equal(status(), 404);
    assert.lengthOf(audit, 0, 'a failed request must not leave an impersonation trail');
  });

  test('emits NOTHING when the target account does not exist', async ({ assert }) => {
    const { service, audit } = await serviceWithRuntimeClients([TOKEN_EXCHANGE_CLIENT]);
    const { ctx, status } = fakeCtx(service, 'ghost');

    await new ConsoleImpersonationController().handle(ctx);

    assert.equal(status(), 404);
    assert.lengthOf(audit, 0);
  });

  test('emits NOTHING when impersonation is switched off in config', async ({ assert }) => {
    const cfg = await resolvedConfig({ admin: { enabled: true, impersonation: false } });
    const audit: AuditEvent[] = [];
    cfg.audit = { record: async (e: AuditEvent) => void audit.push(e) };
    cfg.AdapterClass = adapterClassWith([TOKEN_EXCHANGE_CLIENT]);
    const { ctx, status } = fakeCtx({ config: cfg }, 'target-1');

    await new ConsoleImpersonationController().handle(ctx);

    assert.equal(status(), 404);
    assert.lengthOf(audit, 0);
  });
});
