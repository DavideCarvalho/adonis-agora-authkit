import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { resolvePersonalAgentsConfig } from '../../src/agents/config.js';
import type {
  PersonalAgentExtension,
  PersonalAgentHost,
  PersonalAgentProtocolRuntime,
} from '../../src/agents/extension.js';
import {
  buildPersonalAgentsRuntime,
  personalAgentExtensionRuntime,
} from '../../src/agents/runtime.js';
import { adapters, defineConfig, type ResolvedServerConfig } from '../../src/define_config.js';
import ConsolePersonalAgentsController from '../../src/host/admin_console/console_personal_agents_controller.js';
import { resetAuthHostConfig, setAuthHostConfig } from '../../src/host/auth_host_config.js';
import { authkitCsrfExceptions } from '../../src/host/csrf.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/middleware/account_auth.js';
import { OidcService } from '../../src/provider/oidc_service.js';
import { ensureAuthkitSchema } from '../../src/schema/ensure.js';
import { createTestDatabase } from '../bootstrap.js';

const ISSUER = 'https://shop.example/oidc';

/**
 * Uma extension mínima, só sobre a superfície estável: grava conexões no ledger (`fake_`), conta
 * as revogações e expõe o host que recebeu.
 */
function fakeExtension(
  overrides: Partial<{ id: string; prefix: string; grantIdPrefix: string }> = {},
) {
  const state: { host: PersonalAgentHost | null; revoked: string[] } = { host: null, revoked: [] };
  const id = overrides.id ?? 'fake';
  const grantIdPrefix = overrides.grantIdPrefix ?? 'fake_';
  const extension: PersonalAgentExtension<PersonalAgentProtocolRuntime & { connect: any }> = {
    id,
    resolve: (context) => ({
      label: 'Fake',
      grantIdPrefix,
      prefix: overrides.prefix ?? '/fake',
      csrfExemptPaths: ['/fake/token'],
      tables: [
        {
          name: 'fake_sessions',
          create: (t) => t.string('id').primary(),
          columns: {},
        },
      ],
      isAgentBrowser: (ctx: any) => ctx.session?.get?.('fake_browser') === true,
      async setup(host) {
        state.host = host;
        const runtime = {
          async connect(accountId: string, clientId: string) {
            const now = host.now();
            const grant = {
              id: `${grantIdPrefix}${Math.random().toString(36).slice(2)}`,
              accountId,
              clientId,
              agentSub: '',
              scope: 'a b',
              expiresAt: new Date(now.getTime() + 3600_000),
              createdAt: now,
              updatedAt: now,
            };
            await host.grants.insertGrant(grant);
            return grant.id;
          },
          async listAccountGrants(accountId: string) {
            return (await host.grants.listGrants(accountId)).map((g) => ({
              id: g.id,
              clientId: g.clientId,
              scopes: g.scope.split(' ').map((s) => ({ id: s, description: s.toUpperCase() })),
              createdAt: g.createdAt,
              updatedAt: g.updatedAt,
              expiresAt: g.expiresAt,
            }));
          },
          async revokeAccountGrant(accountId: string, grantId: string) {
            const grant = await host.grants.findGrant(grantId);
            if (!grant || grant.accountId !== accountId || grant.revokedAt) return false;
            await runtime.revokeGrant(grantId);
            return true;
          },
          async revokeAllAccountGrants(accountId: string) {
            const live = await host.grants.listGrants(accountId);
            for (const g of live) await runtime.revokeGrant(g.id);
            return live.length;
          },
          async revokeGrant(grantId: string) {
            state.revoked.push(grantId);
            await host.grants.revokeGrantById(grantId, host.now());
          },
          async disconnectAgent(identifier: string) {
            const ids = await host.grants.unrevokedGrantIdsOfClient(identifier);
            for (const g of ids) await runtime.revokeGrant(g);
            return ids.length;
          },
          async displayName(identifier: string) {
            return `Fake ${new URL(identifier).host}`;
          },
          consoleSummary() {
            return {
              requireRegistration: false,
              hostResolver: false,
              allowHttpIdentifiers: false,
              configured: { allowed: [], blocked: ['https://blocked.example'] },
              identifierLabel: 'Agent URL',
            };
          },
          context,
        };
        return runtime;
      },
    }),
  };
  return { extension, state };
}

async function setup(personalAgents: Record<string, unknown>) {
  const fakeApp = {
    container: { make: async () => ({ connection: () => new RedisMock() }) },
  } as any;
  const cfg = await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer: ISSUER,
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed', algorithm: 'ES256' },
      accountStore: {
        findById: async (id: string) => ({ id, email: `${id}@example.com`, globalRoles: [] }),
      } as any,
      render: (async () => {}) as any,
      trustedDevices: { enabled: false },
      personalAgents: personalAgents as any,
    }),
  );
  const service = new OidcService(cfg as ResolvedServerConfig, 'a'.repeat(32));
  const db = createTestDatabase();
  await ensureAuthkitSchema(db, {
    tables: (cfg as ResolvedServerConfig).personalAgents?.extensions.flatMap((e) => e.tables ?? []),
  });
  return { service, db, cfg: cfg as ResolvedServerConfig };
}

test.group('personal agents — extensions (superfície estável)', (group) => {
  group.each.teardown(() => resetAuthHostConfig());

  test('config: só extensions dispensa audience; ids, prefixos e o `poppy` legado', ({
    assert,
  }) => {
    const { extension } = fakeExtension();
    const only = resolvePersonalAgentsConfig({ extensions: [extension] }, ISSUER)!;
    assert.isFalse(only.pact);
    assert.lengthOf(only.extensions, 1);
    assert.include(only.extensions[0], { id: 'fake', prefix: '/fake', grantIdPrefix: 'fake_' });

    assert.throws(() => resolvePersonalAgentsConfig({}), /audience/);
    assert.throws(
      () => resolvePersonalAgentsConfig({ poppy: {} } as any),
      /@adonis-agora\/authkit-poppy/,
    );
    assert.throws(
      () => resolvePersonalAgentsConfig({ extensions: [fakeExtension({ id: 'pact' }).extension] }),
      /invalid id/,
    );
    assert.throws(
      () => resolvePersonalAgentsConfig({ extensions: [extension, extension] }),
      /twice/,
    );
    assert.throws(
      () =>
        resolvePersonalAgentsConfig({
          extensions: [fakeExtension({ grantIdPrefix: 'agrant_' }).extension],
        }),
      /grantIdPrefix/,
    );
    assert.throws(
      () =>
        resolvePersonalAgentsConfig({
          extensions: [
            extension,
            fakeExtension({ id: 'other', grantIdPrefix: 'other_', prefix: '/fake/x' }).extension,
          ],
        }),
      /overlaps/,
    );
    assert.throws(
      () =>
        resolvePersonalAgentsConfig({
          audience: 'aud',
          prefix: '/agents',
          extensions: [fakeExtension({ prefix: '/agents/fake' }).extension],
        }),
      /debaixo/,
    );
  });

  test('defineConfig recusa uma extension debaixo do mountPath do OIDC', async ({ assert }) => {
    await assert.rejects(
      () => setup({ extensions: [fakeExtension({ prefix: '/oidc/fake' }).extension] }),
      /mountPath/,
    );
  });

  test('runtime: host, ledger com escopo, revogações e console', async ({ assert, cleanup }) => {
    const { extension, state } = fakeExtension();
    const { service, db } = await setup({ extensions: [extension] });
    cleanup(() => db.manager.closeAll());
    const runtime = (await buildPersonalAgentsRuntime(service, async () => db))!;
    const fake = (await personalAgentExtensionRuntime<any>('fake', {
      service,
      db: async () => db,
    }))!;
    assert.strictEqual(fake, runtime.extensions.get('fake')!.runtime);
    assert.equal(state.host!.protocol, 'fake');
    assert.equal(state.host!.issuer, ISSUER);
    assert.deepEqual(fake.context.delegationScopes, null);
    assert.equal(state.host!.deriveSecret('x').length, 32);
    assert.isTrue(await state.host!.isAccountActive('acct-1'));

    // O ledger não aceita nem enxerga ids fora do prefixo.
    await assert.rejects(
      () =>
        state.host!.grants.insertGrant({
          id: 'agrant_x',
          accountId: 'acct-1',
          clientId: 'https://agent.example',
          agentSub: '',
          scope: 'a',
          expiresAt: new Date(Date.now() + 1000),
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      /prefixo/,
    );
    const one = await fake.connect('acct-1', 'https://agent.example');
    const two = await fake.connect('acct-1', 'https://agent.example');
    await fake.connect('acct-2', 'https://agent.example');
    await db.table('auth_agent_grants').insert({
      id: 'agrant_pact',
      account_id: 'acct-1',
      client_id: 'https://agent.example',
      agent_sub: 's',
      scope: 'a',
      expires_at: new Date(Date.now() + 3600_000),
      created_at: new Date(),
      updated_at: new Date(),
    });
    assert.lengthOf(await state.host!.grants.listGrants('acct-1'), 2);
    assert.isNull(await state.host!.grants.findGrant('agrant_pact'));

    // Revogação pela conta: o grant da extension vai para ela; o do PACT nunca.
    assert.isTrue(await runtime.revokeAgentGrant('acct-1', one));
    assert.isFalse(await runtime.revokeAgentGrant('acct-2', two));
    assert.deepEqual(state.revoked, [one]);

    // Admin: revoga qualquer conta pelo id; bloquear desconecta de todas.
    assert.equal((await runtime.revokeGrantById(two))?.id, two);
    assert.equal(await runtime.disconnectAgent('fake', 'https://agent.example'), 1);
    assert.equal(await runtime.revokeAllAgentGrants('acct-1'), 0);

    // O registro do console vale por protocolo.
    await runtime.registry!.upsert({
      protocol: 'fake',
      identifier: 'https://agent.example',
      status: 'blocked',
      name: null,
      jwksUri: null,
      updatedBy: null,
    });
    assert.equal(await state.host!.registryStatus('https://agent.example'), 'blocked');
    assert.isNull(await state.host!.registryStatus('https://other.example'));
  });

  test('console admin: protocolo da extension na visão geral, conexões e validação', async ({
    assert,
    cleanup,
  }) => {
    const { extension } = fakeExtension();
    const { service, db } = await setup({ extensions: [extension] });
    cleanup(() => db.manager.closeAll());
    const fake = (await personalAgentExtensionRuntime<any>('fake', {
      service,
      db: async () => db,
    }))!;
    await fake.connect('acct-1', 'https://agent.example');
    let status = 200;
    const ctx = (body?: unknown, qs?: Record<string, string>) =>
      ({
        request: {
          body: () => body ?? {},
          param: () => undefined,
          qs: () => qs ?? {},
          ip: () => '127.0.0.1',
          url: () => '/admin/api/personal-agents',
          parsedUrl: { search: '' },
        },
        response: {
          status: (s: number) => ({ send: (b: unknown) => ((status = s), b) }),
          notFound: (b: unknown) => ((status = 404), b),
          unprocessableEntity: (b: unknown) => ((status = 422), b),
        },
        session: { get: (k: string) => (k === ACCOUNT_SESSION_KEY ? 'admin' : undefined) },
        containerResolver: {
          make: async (k: string) => (k === 'lucid.db' ? db : service),
        },
      }) as any;
    const controller = new ConsolePersonalAgentsController();
    const overview: any = await controller.index(ctx());
    assert.isNull(overview.protocols.pact);
    assert.deepEqual(overview.protocols.fake, {
      label: 'Fake',
      requireRegistration: false,
      hostResolver: false,
      allowHttpIdentifiers: false,
      identifierLabel: 'Agent URL',
      identifierPlaceholder: null,
    });
    const agents = Object.fromEntries(overview.agents.map((a: any) => [a.identifier, a]));
    assert.include(agents['https://agent.example'], {
      protocol: 'fake',
      name: 'Fake agent.example',
      connections: 1,
    });
    assert.include(agents['https://blocked.example'], { config: 'blocked', effective: 'blocked' });

    const page: any = await controller.connections(ctx(undefined, { protocol: 'fake' }));
    assert.equal(page.meta.total, 1);
    assert.include(page.data[0], { protocol: 'fake', agentName: 'Fake agent.example' });

    await controller.upsert(ctx({ protocol: 'other', identifier: 'https://a.example' }));
    assert.equal(status, 422);
    await controller.upsert(
      ctx({ protocol: 'fake', identifier: 'http://a.example', status: 'blocked' }),
    );
    assert.equal(status, 422);
  });

  test('CSRF: os `csrfExemptPaths` das extensions do config', ({ assert }) => {
    const resolved = resolvePersonalAgentsConfig({ extensions: [fakeExtension().extension] })!;
    setAuthHostConfig({
      mountPath: '/oidc',
      rateLimit: false as any,
      adminEnabled: false,
      adminApiEnabled: false,
      personalAgents: { prefix: resolved.prefix, extensions: resolved.extensions },
    });
    assert.isTrue(authkitCsrfExceptions('/fake/token?x=1'));
    assert.isFalse(authkitCsrfExceptions('/fake/consent'));
    assert.isFalse(authkitCsrfExceptions('/fake/token', { personalAgentExtensions: false }));
  });
});
