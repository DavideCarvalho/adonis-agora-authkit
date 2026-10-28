/**
 * Uma fonte só para os papéis de uma conta.
 *
 * Quando o host configura `resolveTokenRoles` (ex.: papéis no
 * `@adonis-agora/authz`), o claim `roles` e o console já liam por ele, mas outros
 * gates liam `account.globalRoles` direto — uma coluna que esse host não usa:
 *  - o bypass de admin do modo manutenção trancava o admin fora;
 *  - a introspecção de PAT e de access token devolvia papéis desatualizados.
 *
 * Sem o hook, todos continuam lendo `globalRoles` (comportamento de sempre).
 */

import { test } from '@japa/runner';
import { resolveLockout, resolveLogin, resolvePasswordless } from '../../src/define_config.js';
import { TokenVerifyService } from '../../src/host/admin_api/token_verify_service.js';
import InteractionController from '../../src/host/controllers/interaction_controller.js';
import PatIntrospectionController from '../../src/host/controllers/pat_introspection_controller.js';

const EMAIL = 'admin@example.com';
const PASSWORD = 'correct horse battery staple';
const ACCOUNT_ID = 'acc-1';
/** O que a coluna guarda: nada de administrativo. */
const STORED_ROLES = ['USER'];
/** O que a autoridade do host diz. */
const HOST_ROLES = ['ADMIN'];

const account = { id: ACCOUNT_ID, email: EMAIL, name: 'Admin', globalRoles: STORED_ROLES };

/** `lucid.db` mínimo servindo `auth_settings` (mesmo padrão de account_status_gate_social). */
function settingsDb(rows: Record<string, unknown>) {
  const store = new Map(Object.entries(rows).map(([k, v]) => [k, JSON.stringify(v)]));
  function chain(filters: Array<{ col: string; val: string | null }>) {
    return {
      where: (col: string, val: string) => chain([...filters, { col, val }]),
      whereNull: (col: string) => chain([...filters, { col, val: null }]),
      async first() {
        const key = filters.find((f) => f.col === 'key')?.val;
        const value = key ? store.get(key) : undefined;
        return value === undefined ? null : { key, value };
      },
    };
  }
  return {
    from(...args: any[]) {
      return (this as any).table(...args);
    },
    table() {
      return {
        select: () => ({ limit: () => Promise.resolve([]) }),
        where: (col: string, val: string) => chain([{ col, val }]),
        whereNull: (col: string) => chain([{ col, val: null }]),
      };
    },
  };
}

function loginService(resolveTokenRoles?: () => Promise<string[]>) {
  const rendered: Array<{ view: string }> = [];
  const config: any = {
    render: async (_ctx: any, view: string) => {
      rendered.push({ view });
      return { view };
    },
    messages: {},
    branding: { default: { appName: 'Acme', logoUrl: null }, clients: {}, firstParty: [] },
    passwordless: resolvePasswordless({}),
    login: resolveLogin({}),
    registration: { enabled: true },
    accountStore: {
      findById: async (id: string) => (id === ACCOUNT_ID ? account : null),
      findByEmail: async (email: string) => (email === EMAIL ? account : null),
      verifyCredentials: async (email: string, password: string) =>
        email === EMAIL && password === PASSWORD ? account : null,
    },
    audit: { record: async () => {} },
    notifications: { newLoginEmail: false, newDeviceEmail: false },
    trustedDevices: { enabled: false, days: 30 },
    lockout: resolveLockout(),
    resolveTokenRoles,
  };
  const interactions = {
    details: async () => ({
      uid: 'test-uid',
      params: { client_id: 'web' },
      prompt: { name: 'login' },
    }),
    completeLogin: async () => {},
  };
  return { service: { config, interactions }, rendered };
}

function loginCtx(service: any) {
  const session: Record<string, unknown> = { authkit_login_email: EMAIL };
  const inputs: Record<string, unknown> = { password: PASSWORD };
  return {
    containerResolver: {
      make: async (key: string) => {
        if (key === 'authkit.server') return service;
        if (key === 'lucid.db') return settingsDb({ maintenance_mode: { enabled: true } });
        throw new Error(`unknown: ${key}`);
      },
    },
    request: {
      csrfToken: 'csrf',
      param: () => 'test-uid',
      only: (keys: string[]) => Object.fromEntries(keys.map((k) => [k, inputs[k]])),
      input: (k: string, def?: any) => inputs[k] ?? def,
      qs: () => ({}),
      ip: () => '1.2.3.4',
      header: () => undefined,
      encryptedCookie: () => undefined,
    },
    session: {
      get: (k: string) => session[k],
      put: (k: string, v: unknown) => {
        session[k] = v;
      },
      forget: (k: string) => {
        delete session[k];
      },
    },
    response: {
      redirect: () => undefined,
      encryptedCookie: () => undefined,
      cookie: () => undefined,
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  } as any;
}

test.group('papéis — bypass de admin do modo manutenção', () => {
  test('admin pela autoridade do host (resolveTokenRoles) entra durante a manutenção', async ({
    assert,
  }) => {
    const { service, rendered } = loginService(async () => HOST_ROLES);

    await new InteractionController().login(loginCtx(service));

    assert.notInclude(
      rendered.map((r) => r.view),
      'maintenance',
    );
  });

  test('sem o hook, vale o globalRoles: conta comum vê a manutenção', async ({ assert }) => {
    const { service, rendered } = loginService();

    await new InteractionController().login(loginCtx(service));

    assert.deepEqual(
      rendered.map((r) => r.view),
      ['maintenance'],
    );
  });
});

function patCtx(cfg: Record<string, unknown>) {
  return {
    request: {
      header: (name: string) => (name === 'authorization' ? 'Bearer segredo' : undefined),
      input: (key: string) => (key === 'token' ? 'pat_x' : undefined),
      ip: () => '203.0.113.1',
    },
    response: { unauthorized: (b: unknown) => b, notFound: () => null },
    containerResolver: {
      make: async () => ({
        config: {
          patIntrospectionSecret: 'segredo',
          accountStore: { findById: async () => account },
          patStore: {
            findActiveByToken: async () => ({
              accountId: ACCOUNT_ID,
              scopes: [],
              audience: 'api',
              exp: 1,
            }),
          },
          ...cfg,
        },
      }),
    },
  } as any;
}

test.group('papéis — introspecção de tokens', () => {
  test('PAT introspection devolve os papéis do resolveTokenRoles', async ({ assert }) => {
    const result: any = await new PatIntrospectionController().handle(
      patCtx({ resolveTokenRoles: async () => HOST_ROLES }),
    );
    assert.deepEqual(result.roles, HOST_ROLES);
  });

  test('PAT introspection sem o hook devolve o globalRoles', async ({ assert }) => {
    const result: any = await new PatIntrospectionController().handle(patCtx({}));
    assert.deepEqual(result.roles, STORED_ROLES);
  });

  test('Admin API: PAT e access token usam o hook; o access token passa o clientId', async ({
    assert,
  }) => {
    const contexts: Array<{ clientId?: string }> = [];
    const cfg: any = {
      accountStore: { findById: async () => account },
      patStore: {
        findActiveByToken: async () => ({
          accountId: ACCOUNT_ID,
          scopes: [],
          audience: 'api',
          exp: 1,
        }),
      },
      resolveTokenRoles: async (_a: unknown, ctx: { clientId?: string }) => {
        contexts.push(ctx);
        return HOST_ROLES;
      },
    };
    const provider = {
      AccessToken: {
        find: async () => ({ accountId: ACCOUNT_ID, clientId: 'web', scope: 'openid', exp: 1 }),
      },
    };
    const service = new TokenVerifyService(cfg, provider);

    const pat: any = await service.verify('pat_x');
    const at: any = await service.verify('opaque-at');

    assert.deepEqual(pat.roles, HOST_ROLES);
    assert.deepEqual(at.roles, HOST_ROLES);
    assert.deepEqual(
      contexts.map((c) => c.clientId),
      [undefined, 'web'],
    );
  });
});
