import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import type { AuditEvent } from '../src/audit/audit_sink.js';
import { isClientIdUrl } from '../src/cimd/client_id_url.js';
import {
  type FetchedJson,
  isBlockedAddress,
  SafeFetchError,
  safeFetchJson,
} from '../src/cimd/safe_fetch.js';
import { adapters, defineConfig, type ResolvedServerConfig } from '../src/define_config.js';
import {
  resetLockedSettingKeys,
  SettingLockedError,
  setLockedSettingKeys,
} from '../src/host/config_locks.js';
import type { SettingsCapability } from '../src/host/runtime_settings.js';
import {
  describeMcpClientsState,
  MCP_CLIENTS_SETTING_DEFAULT,
  McpMetadataDocumentResolver,
  mcpClientFromMetadataDocument,
  mcpClientsState,
  mcpClientsStateFrom,
  resolveMcpClients,
  setMcpClientsSettingsSource,
  validateMcpClientsSetting,
} from '../src/mcp/mcp_clients.js';
import { McpClientsSettingError, writeMcpClientsSetting } from '../src/mcp/mcp_clients_setting.js';
import { registerOAuthResource } from '../src/mcp/mcp_oauth.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { RegistrationPolicyError } from '../src/provider/registration_policy.js';
import { fakeAccountStore } from './bootstrap.js';
import { isolatedOAuthRegistry } from './helpers/oauth_registry.js';

/** `SettingsCapability` em memória. */
function memorySettings(initial: Record<string, unknown> = {}): SettingsCapability {
  const rows = new Map<string, unknown>(Object.entries(initial));
  return {
    getSetting: async (key) => (rows.has(key) ? rows.get(key) : null),
    setSetting: async (key, value) => {
      rows.set(key, value);
    },
    deleteSetting: async (key) => {
      rows.delete(key);
    },
    listSettings: async () => [],
    getEffective: async (key) => (rows.has(key) ? rows.get(key) : null),
  };
}

function memoryAudit() {
  const events: AuditEvent[] = [];
  return { events, record: async (e: AuditEvent) => void events.push(e) };
}

const CLAUDE_CODE = 'https://claude.ai/oauth/claude-code-client-metadata';
const claudeDoc = (overrides: Record<string, unknown> = {}) => ({
  client_id: CLAUDE_CODE,
  client_name: 'Claude Code',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  ...overrides,
});

test.group('mcpClients: config', () => {
  test('automatic by default: allowed, MCP dynamic registration, metadata documents on', ({
    assert,
  }) => {
    const cfg = resolveMcpClients(undefined);
    assert.isTrue(cfg.allowed);
    assert.equal(cfg.dynamicRegistration, 'mcp');
    assert.deepEqual(cfg.metadataDocuments, { allowHosts: null, ttl: { min: 60, max: 86_400 } });
  });

  test('mcpClients: false turns everything off', ({ assert }) => {
    const cfg = resolveMcpClients(false);
    assert.isFalse(cfg.allowed);
    assert.equal(cfg.dynamicRegistration, 'off');
    assert.isNull(cfg.metadataDocuments);
  });

  test('per-feature switches, allowHosts/ttl, and an app-declared dynamicRegistration', ({
    assert,
  }) => {
    const cfg = resolveMcpClients({
      dynamicRegistration: false,
      metadataDocuments: { allowHosts: ['claude.ai'], ttl: { min: 10, max: 600 } },
      resources: ['https://app.example.com/mcp'],
    });
    assert.equal(cfg.dynamicRegistration, 'off');
    assert.deepEqual(cfg.metadataDocuments, {
      allowHosts: ['claude.ai'],
      ttl: { min: 10, max: 600 },
    });
    assert.deepEqual(cfg.resources, ['https://app.example.com/mcp']);
    assert.isNull(resolveMcpClients({ metadataDocuments: false }).metadataDocuments);
    assert.equal(resolveMcpClients({}, true).dynamicRegistration, 'app');
  });

  test('the removed `mcp` key fails at defineConfig, pointing to mcpClients', ({ assert }) => {
    assert.throws(
      () =>
        defineConfig({
          issuer: 'https://idp.example.com',
          adapter: adapters.redis({ connection: 'main' }),
          jwks: { source: 'managed', algorithm: 'RS256' },
          accountStore: fakeAccountStore(),
          mcp: true,
        } as any),
      /mcpClients/,
    );
  });
});

test.group('mcpClients: live state', (group) => {
  isolatedOAuthRegistry(group);
  group.each.setup(() => () => setMcpClientsSettingsSource(null));

  test('no resource → off; a registered resource → on; the doctor line says why', ({ assert }) => {
    const cfg = resolveMcpClients(undefined);
    const off = mcpClientsStateFrom(cfg, MCP_CLIENTS_SETTING_DEFAULT);
    assert.isFalse(off.enabled);
    assert.equal(off.off, 'no-resource');
    assert.isFalse(off.dynamicRegistration);
    assert.isFalse(off.metadataDocuments);
    assert.equal(describeMcpClientsState(off), 'off (no MCP resource registered)');

    registerOAuthResource({ path: '/mcp/agora' });
    const on = mcpClientsStateFrom(cfg, MCP_CLIENTS_SETTING_DEFAULT);
    assert.isTrue(on.enabled);
    assert.deepEqual(on.resources, ['/mcp/agora']);
    assert.isTrue(on.dynamicRegistration);
    assert.isTrue(on.metadataDocuments);
    assert.equal(
      describeMcpClientsState(on),
      'on (automatic — resources: /mcp/agora; disable with `mcpClients: false`)',
    );
  });

  test('a guard resource and mcpClients.resources count too', ({ assert }) => {
    registerOAuthResource({ path: '/api', metadata: true });
    assert.isTrue(
      mcpClientsStateFrom(resolveMcpClients(undefined), MCP_CLIENTS_SETTING_DEFAULT).enabled,
    );
    (globalThis as any)[Symbol.for('@adonis-agora/oauth:resources')] = [];
    const cfg = resolveMcpClients({ resources: ['https://app.example.com/mcp'] });
    assert.deepEqual(mcpClientsStateFrom(cfg, MCP_CLIENTS_SETTING_DEFAULT).resources, [
      'https://app.example.com/mcp',
    ]);
  });

  test('mcpClients: false with a registered resource → off (config), setting false → off', async ({
    assert,
  }) => {
    registerOAuthResource({ path: '/mcp/agora' });
    const locked = await mcpClientsState(resolveMcpClients(false));
    assert.equal(locked.off, 'config');
    assert.isTrue(locked.lockedByConfig);
    assert.equal(describeMcpClientsState(locked), 'off (mcpClients: false)');

    setMcpClientsSettingsSource(async () => memorySettings({ mcp_clients: { enabled: false } }));
    const bySetting = await mcpClientsState(resolveMcpClients(undefined));
    assert.equal(bySetting.off, 'setting');
  });

  test('the agent hub not mounted (devTools: false) registers nothing → off', async ({
    assert,
  }) => {
    // What an app-like boot leaves in the registry when `@adonis-agora/agent` has `devTools: false`.
    const state = await mcpClientsState(resolveMcpClients(undefined));
    assert.isFalse(state.enabled);
    assert.equal(state.off, 'no-resource');
  });
});

test.group('mcp_clients setting', (group) => {
  group.each.setup(() => () => resetLockedSettingKeys());

  test('shape validation', ({ assert }) => {
    assert.isNull(validateMcpClientsSetting({ enabled: false }));
    assert.isNull(validateMcpClientsSetting({ enabled: 'auto', dynamicRegistration: false }));
    assert.match(validateMcpClientsSetting({ enabled: true })!, /"auto" or false/);
    assert.match(validateMcpClientsSetting({ metadataDocuments: 'no' })!, /boolean/);
    assert.match(validateMcpClientsSetting({ other: 1 })!, /unknown field/);
    assert.match(validateMcpClientsSetting([])!, /object/);
  });

  test('a write records mcp_clients.updated with who and from → to', async ({ assert }) => {
    const settings = memorySettings();
    const audit = memoryAudit();
    const change = await writeMcpClientsSetting(
      settings,
      { enabled: false },
      {
        actorId: 'admin-1',
        source: 'admin-console',
        audit: audit as any,
      },
    );
    assert.equal(change.from.enabled, 'auto');
    assert.equal(change.to.enabled, false);
    assert.deepEqual(await settings.getSetting('mcp_clients'), { enabled: false });
    assert.lengthOf(audit.events, 1);
    assert.equal(audit.events[0].type, 'mcp_clients.updated');
    assert.equal(audit.events[0].actorId, 'admin-1');
    assert.deepEqual((audit.events[0].metadata as any).from.enabled, 'auto');
    assert.deepEqual((audit.events[0].metadata as any).to.enabled, false);

    await writeMcpClientsSetting(settings, null, {
      actorId: 'cli',
      source: 'cli',
      audit: audit as any,
    });
    assert.isNull(await settings.getSetting('mcp_clients'));
  });

  test('invalid value → McpClientsSettingError; config lock → SettingLockedError', async ({
    assert,
  }) => {
    const settings = memorySettings();
    await assert.rejects(
      () =>
        writeMcpClientsSetting(
          settings,
          { enabled: 'yes' },
          { actorId: null, source: 'admin-api' },
        ),
      McpClientsSettingError as any,
    );
    setLockedSettingKeys(['mcp_clients']);
    await assert.rejects(
      () =>
        writeMcpClientsSetting(
          settings,
          { enabled: false },
          { actorId: null, source: 'admin-api' },
        ),
      SettingLockedError as any,
    );
  });
});

test.group('Client ID Metadata Documents', () => {
  const policy = resolveMcpClients(undefined).redirectUriPolicy;

  test('a valid document becomes a public, code-flow client with refresh tokens', ({ assert }) => {
    const client = mcpClientFromMetadataDocument(CLAUDE_CODE, claudeDoc(), policy);
    assert.equal(client.client_id, CLAUDE_CODE);
    assert.equal(client.client_name, 'Claude Code');
    assert.equal(client.token_endpoint_auth_method, 'none');
    assert.equal(client.application_type, 'native');
    assert.deepEqual(client.grant_types, ['authorization_code', 'refresh_token']);
  });

  test('refused: mismatched client_id, redirect outside the policy, secret, bad name', ({
    assert,
  }) => {
    const refuse = (doc: unknown, why: RegExp) =>
      assert.throws(() => mcpClientFromMetadataDocument(CLAUDE_CODE, doc, policy), why);
    refuse(claudeDoc({ client_id: 'https://evil.example/doc' }), /client_id must equal/);
    refuse(
      claudeDoc({ redirect_uris: ['https://evil.example/callback'] }),
      /redirect_uri not allowed/,
    );
    refuse(claudeDoc({ token_endpoint_auth_method: 'client_secret_basic' }), /public clients/);
    refuse(claudeDoc({ client_secret: 'x' }), /client_secret/);
    refuse(claudeDoc({ client_name: 'a\nb' }), /client_name/);
    refuse(claudeDoc({ grant_types: ['client_credentials'] }), /authorization_code/);
    refuse([], /JSON object/);
  });

  test('client_id URL shape', ({ assert }) => {
    assert.isTrue(isClientIdUrl(CLAUDE_CODE));
    assert.isFalse(isClientIdUrl('http://claude.ai/doc'));
    assert.isFalse(isClientIdUrl('https://claude.ai/'));
    assert.isFalse(isClientIdUrl('https://claude.ai/a/../b'));
    assert.isFalse(isClientIdUrl('https://u:p@claude.ai/doc'));
    assert.isFalse(isClientIdUrl('https://claude.ai/doc#x'));
    assert.isFalse(isClientIdUrl('my-client'));
  });

  test('resolver: cache hit, failures, allowHosts, 5 KB / timeout limits', async ({ assert }) => {
    const fetched: string[] = [];
    let respond: (url: string) => Promise<FetchedJson> = async () => ({
      status: 200,
      body: claudeDoc(),
      maxAge: null,
    });
    const rejected: string[] = [];
    const resolver = new McpMetadataDocumentResolver(resolveMcpClients(undefined), {
      fetchJson: async (url) => {
        fetched.push(url);
        return respond(url);
      },
      onReject: (_id, reason) => rejected.push(reason),
    });
    assert.equal((await resolver.find(CLAUDE_CODE))?.client_name, 'Claude Code');
    assert.equal((await resolver.find(CLAUDE_CODE))?.client_name, 'Claude Code');
    assert.lengthOf(fetched, 1, 'second lookup is a cache hit');
    assert.isTrue(resolver.has(CLAUDE_CODE));
    assert.deepEqual(resolver.cached(), [{ clientId: CLAUDE_CODE, clientName: 'Claude Code' }]);

    for (const why of ['blocked address', 'response too large', 'timeout']) {
      respond = async () => {
        throw new SafeFetchError(why);
      };
      const id = `https://agent.example/${why.replace(/ /g, '-')}`;
      assert.isUndefined(await resolver.find(id));
      assert.match(rejected.at(-1)!, new RegExp(why));
    }
    // a failure stays cached: no second outbound fetch for the same bad client_id
    const before = fetched.length;
    assert.isUndefined(await resolver.find('https://agent.example/timeout'));
    assert.equal(fetched.length, before);

    const onlyClaude = new McpMetadataDocumentResolver(
      resolveMcpClients({ metadataDocuments: { allowHosts: ['claude.ai'] } }),
      {
        fetchJson: async (url) => {
          fetched.push(url);
          return { status: 200, body: {}, maxAge: null };
        },
      },
    );
    const count = fetched.length;
    assert.isUndefined(await onlyClaude.find('https://evil.example/doc'));
    assert.equal(fetched.length, count, 'host outside allowHosts is never fetched');
    assert.isFalse(onlyClaude.accepts('not-a-url'));
  });

  test('safe fetch: https only, private/reserved IPs and DNS rebinding blocked', async ({
    assert,
  }) => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '192.168.0.1',
      '::1',
      'fd00::1',
    ]) {
      assert.isTrue(isBlockedAddress(ip), ip);
    }
    assert.isFalse(isBlockedAddress('93.184.216.34'));
    await assert.rejects(() => safeFetchJson('http://claude.ai/doc'), /only https/);
    await assert.rejects(() => safeFetchJson('https://127.0.0.1/doc'), /blocked/);
    await assert.rejects(
      () =>
        safeFetchJson('https://rebind.example/doc', {
          lookup: (_h, _o, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }]),
        }),
      /blocked/,
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP: per-request decision on a real provider
// ---------------------------------------------------------------------------

async function startService(
  port: number,
  extra: Record<string, unknown> = {},
  fetchMetadataDocument?: (url: string) => Promise<FetchedJson>,
) {
  const issuer = `http://localhost:${port}`;
  const fakeApp = {
    container: { make: async () => ({ connection: () => new RedisMock() }) },
  } as any;
  const cfg = (await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer,
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed', algorithm: 'RS256' },
      accountStore: fakeAccountStore(),
      ...extra,
    } as any),
  )) as ResolvedServerConfig;
  const service = new OidcService(cfg, 'a'.repeat(32), undefined, { fetchMetadataDocument });
  const server: Server = createServer(service.callback);
  await new Promise<void>((r) => server.listen(port, r));
  return { issuer, service, server };
}

const register = (issuer: string) =>
  fetch(`${issuer}/reg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude Code',
      redirect_uris: ['http://127.0.0.1:33418/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });

const discovery = (issuer: string) =>
  fetch(`${issuer}/.well-known/openid-configuration`).then((r) => r.json() as Promise<any>);

function authorize(issuer: string, clientId: string, redirectUri: string) {
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL(`${issuer}/auth`);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }).toString();
  return fetch(url, { redirect: 'manual' });
}

/** The provider sent the browser to the login interaction: the client was accepted. */
function reachedInteraction(res: Response): boolean {
  return (
    [302, 303].includes(res.status) && (res.headers.get('location') ?? '').includes('/interaction/')
  );
}

test.group('mcpClients: per-request decision (HTTP)', (group) => {
  isolatedOAuthRegistry(group);
  // Each test boots a provider (key generation) and makes several HTTP round trips.
  group.each.timeout(15_000);
  group.each.setup(() => () => {
    setMcpClientsSettingsSource(null);
    resetLockedSettingKeys();
  });

  test('no resource → /reg refused, no registration_endpoint, CIMD client_id refused', async ({
    assert,
    cleanup,
  }) => {
    const fetched: string[] = [];
    const { issuer, server } = await startService(9881, {}, async (url) => {
      fetched.push(url);
      return { status: 200, body: claudeDoc(), maxAge: null };
    });
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const reg = await register(issuer);
    assert.equal(reg.status, 403);
    assert.equal(((await reg.json()) as any).error, 'access_denied');
    const disco = await discovery(issuer);
    assert.notProperty(disco, 'registration_endpoint');
    assert.notProperty(disco, 'client_id_metadata_document_supported');
    const res = await authorize(issuer, CLAUDE_CODE, 'http://127.0.0.1:5555/callback');
    assert.isFalse(reachedInteraction(res));
    assert.lengthOf(fetched, 0, 'nothing fetched while off');
  });

  test('a resource registered AFTER the provider was built turns it on at the next request', async ({
    assert,
    cleanup,
  }) => {
    const { issuer, server } = await startService(9882, {}, async () => ({
      status: 200,
      body: claudeDoc(),
      maxAge: null,
    }));
    cleanup(() => new Promise<void>((r) => server.close(() => r())));
    assert.equal((await register(issuer)).status, 403);

    // the agent hub registers during boot, possibly after authkit built its provider
    registerOAuthResource({ path: '/mcp/agora' });

    const reg = await register(issuer);
    assert.equal(reg.status, 201, await reg.clone().text());
    const disco = await discovery(issuer);
    assert.equal(disco.registration_endpoint, `${issuer}/reg`);
    assert.isTrue(disco.client_id_metadata_document_supported);

    // the registered (DCR) client keeps working
    const { client_id: clientId } = (await reg.json()) as { client_id: string };
    assert.isTrue(
      reachedInteraction(await authorize(issuer, clientId, 'http://127.0.0.1:40000/callback')),
    );
    // and a CIMD client signs in with no stored record (loopback port is free)
    assert.isTrue(
      reachedInteraction(await authorize(issuer, CLAUDE_CODE, 'http://127.0.0.1:5555/callback')),
    );
  });

  test('mcpClients: false with a registered resource → off', async ({ assert, cleanup }) => {
    registerOAuthResource({ path: '/mcp/agora' });
    const { issuer, server } = await startService(9883, { mcpClients: false }, async () => ({
      status: 200,
      body: claudeDoc(),
      maxAge: null,
    }));
    cleanup(() => new Promise<void>((r) => server.close(() => r())));
    assert.oneOf((await register(issuer)).status, [400, 404]);
    const disco = await discovery(issuer);
    assert.notProperty(disco, 'registration_endpoint');
    assert.notProperty(disco, 'client_id_metadata_document_supported');
    assert.isFalse(
      reachedInteraction(await authorize(issuer, CLAUDE_CODE, 'http://127.0.0.1:5555/callback')),
    );
  });

  test('turning the setting off refuses /reg and CIMD on the next request; on again works', async ({
    assert,
    cleanup,
  }) => {
    registerOAuthResource({ path: '/mcp/agora' });
    const settings = memorySettings();
    setMcpClientsSettingsSource(async () => settings);
    const { issuer, server } = await startService(9884, {}, async () => ({
      status: 200,
      body: claudeDoc(),
      maxAge: null,
    }));
    cleanup(() => new Promise<void>((r) => server.close(() => r())));
    assert.equal((await register(issuer)).status, 201);

    await writeMcpClientsSetting(
      settings,
      { enabled: false },
      { actorId: 'a', source: 'admin-console' },
    );
    assert.equal((await register(issuer)).status, 403);
    assert.isFalse(
      reachedInteraction(await authorize(issuer, CLAUDE_CODE, 'http://127.0.0.1:5555/callback')),
    );
    assert.notProperty(await discovery(issuer), 'registration_endpoint');

    await writeMcpClientsSetting(
      settings,
      { enabled: 'auto', dynamicRegistration: false },
      {
        actorId: 'a',
        source: 'admin-console',
      },
    );
    assert.equal((await register(issuer)).status, 403, 'DCR alone still off');
    assert.isTrue(
      reachedInteraction(await authorize(issuer, CLAUDE_CODE, 'http://127.0.0.1:5555/callback')),
    );
  });

  test('metadataDocuments: false → a client_id URL never resolves', async ({ assert, cleanup }) => {
    registerOAuthResource({ path: '/mcp/agora' });
    const fetched: string[] = [];
    const { issuer, server } = await startService(
      9885,
      { mcpClients: { metadataDocuments: false } },
      async (url) => {
        fetched.push(url);
        return { status: 200, body: claudeDoc(), maxAge: null };
      },
    );
    cleanup(() => new Promise<void>((r) => server.close(() => r())));
    assert.isFalse(
      reachedInteraction(await authorize(issuer, CLAUDE_CODE, 'http://127.0.0.1:5555/callback')),
    );
    assert.lengthOf(fetched, 0);
    assert.notProperty(await discovery(issuer), 'client_id_metadata_document_supported');
    assert.equal((await register(issuer)).status, 201, 'DCR still on');
  });

  test('a CIMD document with a redirect outside the policy is refused', async ({
    assert,
    cleanup,
  }) => {
    registerOAuthResource({ path: '/mcp/agora' });
    const { issuer, server } = await startService(9886, {}, async () => ({
      status: 200,
      body: claudeDoc({ redirect_uris: ['https://evil.example/cb'] }),
      maxAge: null,
    }));
    cleanup(() => new Promise<void>((r) => server.close(() => r())));
    assert.isFalse(
      reachedInteraction(await authorize(issuer, CLAUDE_CODE, 'https://evil.example/cb')),
    );
  });

  test('a document that cannot be fetched (SSRF guard) is refused, never thrown', async ({
    assert,
    cleanup,
  }) => {
    registerOAuthResource({ path: '/mcp/agora' });
    const { issuer, server } = await startService(9887, {}, async () => {
      throw new SafeFetchError('blocked address');
    });
    cleanup(() => new Promise<void>((r) => server.close(() => r())));
    const res = await authorize(issuer, 'https://internal.example/doc', 'http://127.0.0.1:1/cb');
    assert.isFalse(reachedInteraction(res));
    assert.isBelow(res.status, 500);
  });

  test('RegistrationPolicyError is what refuses a document', ({ assert }) => {
    assert.throws(
      () =>
        mcpClientFromMetadataDocument(
          CLAUDE_CODE,
          {},
          resolveMcpClients(undefined).redirectUriPolicy,
        ),
      RegistrationPolicyError as any,
    );
  });
});
