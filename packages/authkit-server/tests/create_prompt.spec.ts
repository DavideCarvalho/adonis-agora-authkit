/**
 * `prompt=create` (OpenID Connect "Initiating User Registration") and the identity pages
 * the discovery document publishes for relying parties.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { adapters, defineConfig, resolveLogin, resolvePasswordless } from '../src/define_config.js';
import { resetAccountPaths, setAccountPaths } from '../src/host/account_paths.js';
import { resetAdminPrefix, setAdminPrefix } from '../src/host/admin_prefix.js';
import InteractionController from '../src/host/controllers/interaction_controller.js';
import { requestsCreate } from '../src/provider/create_prompt.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { fakeAccountStore } from './bootstrap.js';
import { withClients } from './helpers/seed_clients.js';

const PORT = 9867;
const ISSUER = `http://localhost:${PORT}/oidc`;
const ORIGIN = `http://localhost:${PORT}`;

function authorizeUrl(extra: Record<string, string>) {
  const challenge = createHash('sha256')
    .update(randomBytes(32).toString('base64url'))
    .digest('base64url');
  const params = new URLSearchParams({
    client_id: 'app1',
    response_type: 'code',
    scope: 'openid',
    redirect_uri: `${ORIGIN}/cb`,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    ...extra,
  });
  return `${ISSUER}/auth?${params.toString()}`;
}

test.group('prompt=create and identity pages (provider)', (group) => {
  let server: Server;

  group.setup(async () => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      withClients(
        [
          {
            clientId: 'app1',
            clientSecret: 's',
            redirectUris: [`${ORIGIN}/cb`],
            grants: ['authorization_code'],
          },
        ],
        defineConfig({
          issuer: ISSUER,
          adapter: adapters.redis({ connection: 'main' }),
          jwks: { source: 'managed' },
          accountStore: fakeAccountStore(),
          admin: { enabled: true },
        }),
      ),
    );
    const service = new OidcService(cfg as any, 'a'.repeat(32));
    server = createServer(service.callback);
    await new Promise<void>((r) => server.listen(PORT, r));
    return async () => {
      resetAccountPaths();
      resetAdminPrefix();
      await new Promise<void>((r) => server.close(() => r()));
    };
  });

  group.each.teardown(() => {
    resetAccountPaths();
    resetAdminPrefix();
  });

  const discovery = async () =>
    (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json() as Promise<any>;

  test('discovery advertises prompt=create', async ({ assert }) => {
    const body = await discovery();
    assert.includeMembers(body.prompt_values_supported, ['none', 'login', 'consent', 'create']);
  });

  test('authorize with prompt=create opens the login interaction', async ({ assert }) => {
    const res = await fetch(authorizeUrl({ prompt: 'create' }), { redirect: 'manual' });
    assert.oneOf(res.status, [302, 303]);
    assert.include(res.headers.get('location') ?? '', '/auth/interaction/');
  });

  test('an unknown prompt is still rejected', async ({ assert }) => {
    const res = await fetch(authorizeUrl({ prompt: 'bogus' }), { redirect: 'manual' });
    const location = res.headers.get('location') ?? '';
    assert.isTrue(res.status === 400 || location.includes('error=invalid_request'));
  });

  test('discovery publishes the identity pages with the server defaults', async ({ assert }) => {
    const body = await discovery();
    assert.equal(body.authkit_account_uri, `${ORIGIN}/account`);
    assert.equal(body.authkit_account_home_uri, `${ORIGIN}/account/security`);
    assert.equal(body.authkit_forgot_password_uri, `${ORIGIN}/auth/forgot-password`);
    assert.equal(body.authkit_reset_password_uri, `${ORIGIN}/auth/reset-password`);
    assert.notProperty(body, 'authkit_admin_uri', 'admin console not mounted');
  });

  test('discovery follows the mounted account and admin prefixes', async ({ assert }) => {
    setAccountPaths({ prefix: '/conta', paths: { security: 'seguranca' } });
    setAdminPrefix('/auth/admin');
    const body = await discovery();
    assert.equal(body.authkit_account_uri, `${ORIGIN}/conta`);
    assert.equal(body.authkit_account_home_uri, `${ORIGIN}/conta/seguranca`);
    assert.equal(body.authkit_admin_uri, `${ORIGIN}/auth/admin`);
  });
});

test.group('prompt=create (interaction screen)', () => {
  function noTableDb() {
    return {
      from() {
        return (this as any).table();
      },
      table() {
        throw new Error('no table');
      },
    };
  }

  function setup(opts: { prompt?: string; registration?: boolean; email?: string } = {}) {
    const rendered: Array<{ view: string; props: Record<string, any> }> = [];
    const redirects: string[] = [];
    const session = new Map<string, unknown>(
      opts.email ? [['authkit_login_email', opts.email]] : [],
    );
    const service = {
      config: {
        render: async (_ctx: any, view: string, props: Record<string, any>) => {
          rendered.push({ view, props });
        },
        messages: {},
        branding: { default: { appName: 'Acme', logoUrl: null }, clients: {}, firstParty: [] },
        passwordless: resolvePasswordless({ magicLink: false, passkeyFirst: false }),
        login: resolveLogin(),
        registration: { enabled: opts.registration ?? true },
        accountStore: {
          findByEmail: async () => null,
          findById: async () => null,
          verifyCredentials: async () => null,
        },
      },
      interactions: {
        details: async () => ({
          uid: 'u1',
          params: { client_id: 'web', ...(opts.prompt ? { prompt: opts.prompt } : {}) },
          prompt: { name: 'login' },
        }),
      },
    };
    const ctx = {
      containerResolver: {
        make: async (key: string) => (key === 'authkit.server' ? service : noTableDb()),
      },
      request: {
        csrfToken: 'csrf',
        param: () => 'u1',
        input: (_k: string, def?: any) => def,
        qs: () => ({}),
        ip: () => '1.2.3.4',
        plainCookie: () => undefined,
      },
      session: {
        get: (key: string) => session.get(key),
        put: (key: string, value: unknown) => void session.set(key, value),
      },
      response: {
        redirect: (url?: string) => {
          if (url) redirects.push(url);
          return undefined;
        },
      },
    } as any;
    return { ctx, rendered, redirects };
  }

  test('opens on the sign-up screen', async ({ assert }) => {
    const { ctx, rendered, redirects } = setup({ prompt: 'create' });
    await new InteractionController().show(ctx);
    assert.deepEqual(redirects, ['/auth/interaction/u1/signup']);
    assert.lengthOf(rendered, 0);
  });

  test('only once per interaction: "I already have an account" shows the login', async ({
    assert,
  }) => {
    const { ctx, rendered, redirects } = setup({ prompt: 'create' });
    const controller = new InteractionController();
    await controller.show(ctx);
    await controller.show(ctx);
    assert.lengthOf(redirects, 1);
    assert.equal(rendered[0].view, 'login');
    assert.equal(rendered[0].props.step, 'identifier');
  });

  test('with signup closed, the login screen as usual', async ({ assert }) => {
    const { ctx, rendered, redirects } = setup({ prompt: 'create', registration: false });
    await new InteractionController().show(ctx);
    assert.lengthOf(redirects, 0);
    assert.equal(rendered[0].view, 'login');
    assert.isFalse(rendered[0].props.registrationEnabled);
  });

  test('without prompt=create, the login screen', async ({ assert }) => {
    const { ctx, rendered, redirects } = setup({ prompt: 'login' });
    await new InteractionController().show(ctx);
    assert.lengthOf(redirects, 0);
    assert.equal(rendered[0].view, 'login');
  });

  test('requestsCreate reads the space-separated prompt list', ({ assert }) => {
    assert.isTrue(requestsCreate({ prompt: 'create' }));
    assert.isTrue(requestsCreate({ prompt: 'consent create' }));
    assert.isFalse(requestsCreate({ prompt: 'login' }));
    assert.isFalse(requestsCreate({}));
  });
});
