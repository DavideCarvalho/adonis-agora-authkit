import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import type { AuditEvent } from '../../../src/audit/audit_sink.js';
import { settingsSet, settingsUnset } from '../../../src/commands/settings_commands.js';
import { adapters, defineConfig, type ResolvedServerConfig } from '../../../src/define_config.js';
import { checkMcpClients } from '../../../src/doctor/checks.js';
import ApiSettingsController from '../../../src/host/admin_api/api_settings_controller.js';
import ConsoleClientsController from '../../../src/host/admin_console/console_clients_controller.js';
import ConsoleMcpClientsController from '../../../src/host/admin_console/console_mcp_clients_controller.js';
import ConsoleSettingsController from '../../../src/host/admin_console/console_settings_controller.js';
import { resetLockedSettingKeys, setLockedSettingKeys } from '../../../src/host/config_locks.js';
import { ACCOUNT_SESSION_KEY } from '../../../src/host/middleware/account_auth.js';
import { SUDO_ACCOUNT_SESSION_KEY, SUDO_SESSION_KEY } from '../../../src/host/sudo_mode.js';
import { setMcpClientsSettingsSource } from '../../../src/mcp/mcp_clients.js';
import { registerOAuthResource } from '../../../src/mcp/mcp_oauth.js';
import { OidcService } from '../../../src/provider/oidc_service.js';
import { ensureAuthkitSchema } from '../../../src/schema/ensure.js';
import { createTestDatabase, fakeAccountStore } from '../../bootstrap.js';
import { isolatedOAuthRegistry } from '../../helpers/oauth_registry.js';

function fakeCtx(opts: {
  service: OidcService;
  db: any;
  body?: any;
  params?: Record<string, string>;
  sudo?: boolean;
}) {
  let status = 200;
  let body: any;
  const setBody = (b: any) => {
    body = b;
    return b;
  };
  const ctx = {
    request: {
      body: () => opts.body ?? {},
      ip: () => '127.0.0.1',
      url: () => '/admin/api/mcp-clients',
      param: (k: string) => opts.params?.[k],
      qs: () => ({}),
      parsedUrl: { search: '' },
    },
    response: {
      status: (s: number) => {
        status = s;
        return { send: setBody };
      },
      send: setBody,
      notFound: (b: any) => {
        status = 404;
        return setBody(b);
      },
      badRequest: (b: any) => {
        status = 400;
        return setBody(b);
      },
      redirect: () => {
        status = 302;
      },
    },
    session: {
      get: (k: string) => {
        if (k === ACCOUNT_SESSION_KEY) return 'admin-1';
        if (!opts.sudo) return undefined;
        if (k === SUDO_SESSION_KEY) return Date.now();
        if (k === SUDO_ACCOUNT_SESSION_KEY) return 'admin-1';
        return undefined;
      },
    },
    containerResolver: {
      make: async (key: string) => {
        if (key === 'authkit.server') return opts.service;
        if (key === 'lucid.db') return opts.db;
        throw new Error(`no binding for ${key}`);
      },
    },
  } as any;
  return { ctx, status: () => status, body: () => body };
}

test.group('admin console: MCP client login card', (group) => {
  isolatedOAuthRegistry(group);
  let db: any;
  let service: OidcService;
  let audit: AuditEvent[];

  group.each.setup(async () => {
    db = createTestDatabase();
    await ensureAuthkitSchema(db);
    audit = [];
    const cfg = (await configProvider.resolve(
      { container: { make: async () => db } } as any,
      defineConfig({
        issuer: 'http://localhost:1',
        adapter: adapters.database({}),
        jwks: { source: 'managed', algorithm: 'RS256' },
        accountStore: fakeAccountStore(),
        audit: { record: async (e: AuditEvent) => void audit.push(e) },
      }),
    )) as ResolvedServerConfig;
    service = new OidcService(cfg, 'a'.repeat(32));
    const { RuntimeSettings } = await import('../../../src/host/runtime_settings.js');
    setMcpClientsSettingsSource(async () => new RuntimeSettings(db));
    return async () => {
      setMcpClientsSettingsSource(null);
      resetLockedSettingKeys();
      await db.manager.closeAll();
    };
  });

  test('GET shows the live state: off with no resource, on with the hub registered', async ({
    assert,
  }) => {
    const off = await new ConsoleMcpClientsController().show(fakeCtx({ service, db }).ctx);
    assert.isFalse(off.enabled);
    assert.equal(off.off, 'no-resource');
    assert.equal(off.clients.dynamic, 0);

    registerOAuthResource({ path: '/mcp/agora' });
    const on = await new ConsoleMcpClientsController().show(fakeCtx({ service, db }).ctx);
    assert.isTrue(on.enabled);
    assert.deepEqual(on.resources, ['/mcp/agora']);
    assert.match(on.summary, /^on \(automatic/);
  });

  test('PUT needs sudo; with it, turns login off and audits who, from → to', async ({ assert }) => {
    registerOAuthResource({ path: '/mcp/agora' });
    const denied = fakeCtx({ service, db, body: { enabled: false } });
    await new ConsoleMcpClientsController().update(denied.ctx);
    assert.equal(denied.status(), 403);
    assert.equal(denied.body().error.code, 'sudo_required');

    const ok = fakeCtx({ service, db, body: { enabled: false }, sudo: true });
    const status = await new ConsoleMcpClientsController().update(ok.ctx);
    assert.isFalse((status as any).enabled);
    assert.equal((status as any).off, 'setting');
    const event = audit.find((e) => e.type === 'mcp_clients.updated');
    assert.equal(event?.actorId, 'admin-1');
    assert.equal((event!.metadata as any).from.enabled, 'auto');
    assert.equal((event!.metadata as any).to.enabled, false);
    assert.equal((event!.metadata as any).source, 'admin-console');

    const bad = fakeCtx({ service, db, body: { enabled: 'maybe' }, sudo: true });
    await new ConsoleMcpClientsController().update(bad.ctx);
    assert.equal(bad.status(), 400);
  });

  test('config lock (mcpClients: false) → 423, from the card and from the settings API', async ({
    assert,
  }) => {
    setLockedSettingKeys(['mcp_clients']);
    const card = fakeCtx({ service, db, body: { enabled: 'auto' }, sudo: true });
    await new ConsoleMcpClientsController().update(card.ctx);
    assert.equal(card.status(), 423);
    assert.equal(card.body().error.code, 'setting_locked');

    const api = fakeCtx({
      service,
      db,
      body: { value: { enabled: 'auto' } },
      params: { key: 'mcp_clients' },
    });
    await new ApiSettingsController().upsert(api.ctx);
    assert.equal(api.status(), 423);
    assert.isFalse(audit.some((e) => e.type === 'mcp_clients.updated'));
  });

  test('the generic settings routes go through the same path (sudo + audit)', async ({
    assert,
  }) => {
    const noSudo = fakeCtx({
      service,
      db,
      body: { value: { enabled: false } },
      params: { key: 'mcp_clients' },
    });
    await new ConsoleSettingsController().upsert(noSudo.ctx);
    assert.equal(noSudo.status(), 403);

    const viaApi = fakeCtx({
      service,
      db,
      body: { value: { enabled: false } },
      params: { key: 'mcp_clients' },
    });
    await new ApiSettingsController().upsert(viaApi.ctx);
    const event = audit.find((e) => e.type === 'mcp_clients.updated');
    assert.equal((event!.metadata as any).source, 'admin-api');
  });

  test('revoke a client from the console needs sudo', async ({ assert }) => {
    const denied = fakeCtx({ service, db, params: { id: 'x' } });
    await new ConsoleClientsController().revoke(denied.ctx);
    assert.equal(denied.status(), 403);
    const ok = fakeCtx({ service, db, params: { id: 'x' }, sudo: true });
    const result = (await new ConsoleClientsController().revoke(ok.ctx)) as any;
    assert.equal(result.clientId, 'x');
    assert.isFalse(result.stored);
    assert.equal(audit.at(-1)?.type, 'client.revoked');
  });

  test('authkit:settings:set mcp_clients validates the shape and honours the config lock', async ({
    assert,
  }) => {
    const app = {
      container: { make: async (k: string) => (k === 'lucid.db' ? db : undefined) },
      config: { get: () => null },
    } as any;
    const lines: string[] = [];
    const logger = {
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
    };
    assert.isFalse(await settingsSet(app, 'mcp_clients', '{"enabled":true}', { logger }));
    assert.isTrue(await settingsSet(app, 'mcp_clients', '{"enabled":false}', { logger }));
    assert.isTrue(lines.some((l) => l.includes('mcp_clients:') && l.includes('→')));
    await settingsUnset(app, 'mcp_clients', { logger });
    setLockedSettingKeys(['mcp_clients']);
    assert.isFalse(await settingsSet(app, 'mcp_clients', '{"enabled":false}', { logger }));
  });

  test('doctor: MCP login line', ({ assert }) => {
    const input = (mcpClients: unknown, setting?: any) =>
      checkMcpClients({
        authkitConfig: { mcpClients },
        sessionConfig: null,
        peers: { session: true, shield: true, ally: true, limiter: true },
        ...(setting ? { mcpClientsSetting: setting } : {}),
      });
    assert.equal(
      input(service.config.mcpClients)?.message,
      'MCP login: off (no MCP resource registered)',
    );
    registerOAuthResource({ path: '/mcp/agora' });
    assert.equal(
      input(service.config.mcpClients)?.message,
      'MCP login: on (automatic — resources: /mcp/agora; disable with `mcpClients: false`)',
    );
    assert.equal(
      input({ ...service.config.mcpClients, allowed: false })?.message,
      'MCP login: off (mcpClients: false)',
    );
    assert.match(
      input(service.config.mcpClients, {
        enabled: false,
        dynamicRegistration: true,
        metadataDocuments: true,
      })!.message,
      /off \(turned off/,
    );
    assert.isNull(input(undefined));
  });
});
