import { test } from '@japa/runner';
import type { AccountStore } from '../src/accounts/account_store.js';
import { verifyActiveOrgMembership } from '../src/host/active_org_cookie.js';
import {
  authenticateLabelsClient,
  ORG_LABELS_MAX_IDS,
  orgLabelsHandler,
  parseLabelIds,
} from '../src/host/org_labels.js';
import { normalizeServiceTenant, serviceTenantOf } from '../src/service_tenants/client_metadata.js';

const CLIENTS: Record<string, Record<string, unknown>> = {
  web: { client_id: 'web', client_secret: 'web-secret' },
  'web:2': { client_id: 'web:2', client_secret: 's:2' },
  disabled: { client_id: 'disabled', client_secret: 'x', authkit_disabled: true },
  mcp: { client_id: 'mcp', client_secret: 'x', client_id_issued_at: 1 },
  worker: {
    client_id: 'worker',
    client_secret: 'x',
    authkit_service_tenant: { partition: 'acme', capabilities: [] },
  },
  public: { client_id: 'public' },
};

class MemoryAdapter {
  constructor(readonly model: string) {}
  async find(id: string) {
    return this.model === 'Client' ? CLIENTS[id] : undefined;
  }
}

const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

const ORGS = [
  { id: 'org-1', name: 'Acme', slug: 'acme', createdAt: '' },
  { id: 'org-2', name: 'Globex', slug: 'globex', createdAt: '' },
];

const orgStore = {
  createOrg: async () => {
    throw new Error('not used');
  },
  findOrgById: async (id: string) => ORGS.find((o) => o.id === id) ?? null,
  findOrgsByIds: async (ids: readonly string[]) => ORGS.filter((o) => ids.includes(o.id)),
  getOrgMembership: async () => ({ role: 'owner' }),
} as unknown as AccountStore;

const deps = (firstPartyClients?: string[]) => ({
  AdapterClass: MemoryAdapter as any,
  accountStore: orgStore,
  ...(firstPartyClients ? { firstPartyClients } : {}),
});

function fakeCtx(authorization: string | undefined, ids: unknown) {
  const reply: { status?: number; body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  return {
    reply,
    ctx: {
      containerResolver: { make: async () => ({ config: deps() }) },
      request: {
        header: (name: string) => (name === 'authorization' ? authorization : undefined),
        qs: () => ({ ids }),
      },
      response: {
        header: (k: string, v: string) => void (reply.headers[k] = v),
        unauthorized: (body: unknown) => {
          reply.status = 401;
          reply.body = body;
          return reply;
        },
      },
    },
  };
}

test.group('org labels endpoint', () => {
  test('authenticates a confidential first-party client by its secret', async ({ assert }) => {
    assert.equal(await authenticateLabelsClient(deps(), basic('web', 'web-secret')), 'web');
    assert.equal(await authenticateLabelsClient(deps(), basic('web:2', 's:2')), 'web:2');
    for (const [id, secret] of [
      ['web', 'wrong'],
      ['nobody', 'x'],
      ['disabled', 'x'],
      ['mcp', 'x'],
      ['worker', 'x'],
      ['public', ''],
    ]) {
      assert.isNull(await authenticateLabelsClient(deps(), basic(id, secret)), id);
    }
    assert.isNull(await authenticateLabelsClient(deps(), undefined));
    assert.isNull(await authenticateLabelsClient(deps(), 'Bearer web-secret'));
    // An allowlist of first-party clients is honoured.
    assert.isNull(await authenticateLabelsClient(deps(['other']), basic('web', 'web-secret')));
  });

  test('parses comma-separated and repeated ids, capped', ({ assert }) => {
    assert.deepEqual(parseLabelIds('a, b,,a'), ['a', 'b']);
    assert.deepEqual(parseLabelIds(['a', 'b,c']), ['a', 'b', 'c']);
    assert.deepEqual(parseLabelIds(undefined), []);
    const many = Array.from({ length: 150 }, (_, i) => `id-${i}`).join(',');
    assert.lengthOf(parseLabelIds(many), ORG_LABELS_MAX_IDS);
  });

  test('answers labels for known orgs only', async ({ assert }) => {
    const { ctx } = fakeCtx(basic('web', 'web-secret'), 'org-1,org-2,user-1');
    assert.deepEqual(await orgLabelsHandler(ctx), {
      labels: { 'org-1': 'Acme', 'org-2': 'Globex' },
    });
  });

  test('401 without valid client credentials', async ({ assert }) => {
    const { ctx, reply } = fakeCtx(basic('web', 'nope'), 'org-1');
    await orgLabelsHandler(ctx);
    assert.equal(reply.status, 401);
    assert.deepEqual(reply.body, { error: 'invalid_client' });
  });

  test('the active org carries its name (org_name claim)', async ({ assert }) => {
    const info = await verifyActiveOrgMembership(orgStore, 'u1', {
      orgId: 'org-1',
      orgSlug: 'acme',
      orgRole: 'owner',
    });
    assert.deepEqual(info, { orgId: 'org-1', orgSlug: 'acme', orgRole: 'owner', orgName: 'Acme' });
  });
});

test.group('service tenant environment', () => {
  test('is normalized, optional and validated', ({ assert }) => {
    assert.deepEqual(normalizeServiceTenant({ partition: 'acme', environment: ' production ' }), {
      partition: 'acme',
      capabilities: [],
      environment: 'production',
    });
    assert.deepEqual(normalizeServiceTenant({ partition: 'acme', environment: null }), {
      partition: 'acme',
      capabilities: [],
    });
    assert.isString(normalizeServiceTenant({ partition: 'acme', environment: 'no spaces' }));
  });

  test('is read back from the client payload', ({ assert }) => {
    assert.deepEqual(
      serviceTenantOf({
        authkit_service_tenant: { partition: 'acme', capabilities: ['x'], environment: 'staging' },
      }),
      { partition: 'acme', capabilities: ['x'], environment: 'staging' },
    );
    assert.deepEqual(
      serviceTenantOf({ authkit_service_tenant: { partition: 'acme', environment: 'bad env' } }),
      { partition: 'acme', capabilities: [] },
    );
  });
});
