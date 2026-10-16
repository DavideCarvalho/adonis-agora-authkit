import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { AuthkitClientManager } from '../providers/authkit_client_provider.js';
import { defineConfig, type ResolvedClientConfig, resolvers } from '../src/define_config.js';
import { registerOidcClient } from '../src/register_oidc_client.js';
import type { TokenSet } from '../src/types.js';

/**
 * Real third-party IdPs (testcontainers). The unit specs fake the IdP, so they
 * cannot see what only bites against a real one: its own route layout, its
 * login form, what it puts in the id_token (nonce, azp, sid), whether it echoes
 * RFC 9207 `iss`, how it re-issues id_tokens on refresh, and what its
 * end_session endpoint accepts. Each backend below runs the SAME contract
 * through the real `registerOidcClient` routes and `AuthkitClientManager`, with
 * nothing configured but the issuer.
 *
 * With Docker the contract runs once per IdP; without it (a laptop with no
 * daemon) the file skips — the default suite never hard-depends on containers.
 * CI ubuntu runners have Docker, so this is where the IdP matrix executes.
 */

function dockerAvailable(): boolean {
  if (process.env.AUTHKIT_SKIP_CONTAINERS) return false;
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const DOCKER = dockerAvailable();
const BOOT_TIMEOUT_MS = 240_000;
const FLOW_TIMEOUT_MS = 60_000;
const REDIRECT_URI = 'http://localhost:9999/auth/callback';
const POST_LOGOUT = 'http://localhost:9999/';
const fixture = (name: string) => new URL(`./fixtures/idp/${name}`, import.meta.url).pathname;

interface StartedIdp {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Drives the IdP's login UI from the authorize URL to the callback redirect. */
  login(authorizeUrl: string): Promise<URL>;
  /** The `sub` the IdP issues for the test user. */
  expectedSub?: string;
  stop(): Promise<void>;
}

interface Idp {
  label: string;
  /** The IdP's own authorize path — not the authkit-server `/auth` (proves discovery was used). */
  authorizePath: RegExp;
  start(): Promise<StartedIdp>;
}

// --- a minimal cookie-jar browser -------------------------------------------

function browser() {
  const jar = new Map<string, string>();
  const remember = (res: Response) => {
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
    }
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return {
    async get(url: string) {
      const res = await fetch(url, { redirect: 'manual', headers: { cookie: cookie() } });
      remember(res);
      return res;
    },
    async postForm(url: string, form: Record<string, string>) {
      const res = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form),
      });
      remember(res);
      return res;
    },
  };
}

function locationOf(res: Response): URL {
  const location = res.headers.get('location');
  if (!location) throw new Error(`expected a redirect, got ${res.status}`);
  return new URL(location);
}

// --- the IdPs ---------------------------------------------------------------

const keycloak: Idp = {
  label: 'Keycloak',
  authorizePath: /\/realms\/authkit\/protocol\/openid-connect\/auth$/,
  async start() {
    const container: StartedTestContainer = await new GenericContainer(
      'quay.io/keycloak/keycloak:26.4.2',
    )
      .withExposedPorts(8080)
      .withEnvironment({
        KC_BOOTSTRAP_ADMIN_USERNAME: 'admin',
        KC_BOOTSTRAP_ADMIN_PASSWORD: 'admin',
      })
      .withCopyFilesToContainer([
        { source: fixture('keycloak-realm.json'), target: '/opt/keycloak/data/import/realm.json' },
      ])
      .withCommand(['start-dev', '--import-realm'])
      .withWaitStrategy(
        Wait.forHttp('/realms/authkit/.well-known/openid-configuration', 8080).forStatusCode(200),
      )
      .withStartupTimeout(BOOT_TIMEOUT_MS)
      .start();
    const base = `http://${container.getHost()}:${container.getMappedPort(8080)}`;
    return {
      issuer: `${base}/realms/authkit`,
      clientId: 'authkit-app',
      clientSecret: 'authkit-app-secret',
      async login(authorizeUrl) {
        const b = browser();
        const page = await b.get(authorizeUrl);
        const html = await page.text();
        const action = html
          .match(/<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/)?.[1]
          ?.replaceAll('&amp;', '&');
        if (!action) throw new Error(`Keycloak login form not found (status ${page.status})`);
        return locationOf(
          await b.postForm(action, { username: 'ada', password: 'secret-password' }),
        );
      },
      stop: async () => {
        await container.stop({ timeout: 10_000 });
      },
    };
  },
};

const mockOAuth2Server: Idp = {
  label: 'mock-oauth2-server',
  authorizePath: /\/default\/authorize$/,
  async start() {
    const container = await new GenericContainer('ghcr.io/navikt/mock-oauth2-server:2.3.0')
      .withExposedPorts(8080)
      .withEnvironment({ JSON_CONFIG: readFileSync(fixture('mock-oauth2-server.json'), 'utf8') })
      .withWaitStrategy(
        Wait.forHttp('/default/.well-known/openid-configuration', 8080).forStatusCode(200),
      )
      .withStartupTimeout(BOOT_TIMEOUT_MS)
      .start();
    const base = `http://${container.getHost()}:${container.getMappedPort(8080)}`;
    return {
      issuer: `${base}/default`,
      clientId: 'mock-app',
      clientSecret: 'mock-secret',
      expectedSub: 'ada',
      // Non-interactive: authorize redirects straight back with a code.
      login: async (authorizeUrl) => locationOf(await browser().get(authorizeUrl)),
      stop: async () => {
        await container.stop({ timeout: 10_000 });
      },
    };
  },
};

const IDPS: Idp[] = [keycloak, mockOAuth2Server];

// --- the app side: real routes, fake HTTP objects ----------------------------

function fakeSession() {
  const store = new Map<string, unknown>();
  return {
    sessionId: 'sess-1',
    get: (k: string) => store.get(k),
    put: (k: string, v: unknown) => void store.set(k, v),
    forget: (k: string) => void store.delete(k),
    pull: (k: string) => {
      const v = store.get(k);
      store.delete(k);
      return v;
    },
  };
}

function fakeCtx(
  manager: AuthkitClientManager,
  session: ReturnType<typeof fakeSession>,
  qs: Record<string, string> = {},
) {
  const redirects: string[] = [];
  const builder = {
    withQs: () => builder,
    toPath: (url: string) => void redirects.push(url),
  };
  const ctx = {
    containerResolver: { make: async () => manager },
    request: { qs: () => qs, input: (k: string) => qs[k] },
    session,
    response: { redirect: () => builder, header: () => {} },
  } as any;
  return { ctx, redirects };
}

function routes() {
  const table = new Map<string, (ctx: any) => Promise<unknown>>();
  const add = (pattern: string, handler: (ctx: any) => Promise<unknown>) => {
    table.set(pattern, handler);
    const chain = { use: () => chain, as: () => chain };
    return chain;
  };
  registerOidcClient({ get: add, post: add } as any, { postLogoutRedirect: POST_LOGOUT });
  return (pattern: string) => table.get(pattern)!;
}

async function managerFor(idp: StartedIdp) {
  const config = await configProvider.resolve<ResolvedClientConfig>(
    {} as any,
    defineConfig({
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      redirectUri: REDIRECT_URI,
      resolver: resolvers.jwt(),
    }),
  );
  return new AuthkitClientManager(config!);
}

// --- the contract -------------------------------------------------------------

for (const spec of IDPS) {
  test.group(`third-party IdP | ${spec.label}`, (group) => {
    let idp: StartedIdp;
    let manager: AuthkitClientManager;
    const route = routes();
    const session = fakeSession();

    group.setup(async () => {
      if (!DOCKER) return;
      idp = await spec.start();
      manager = await managerFor(idp);
    });
    group.teardown(async () => {
      await idp?.stop();
    });

    /** Full browser round trip through /auth/login and /auth/callback. */
    async function signIn(): Promise<TokenSet> {
      const login = fakeCtx(manager, session);
      await route('/auth/login')(login.ctx);
      const callbackUrl = await idp.login(login.redirects[0]);
      ensure(callbackUrl.href.startsWith(REDIRECT_URI), `IdP redirected to ${callbackUrl}`);

      const callback = fakeCtx(manager, session, Object.fromEntries(callbackUrl.searchParams));
      await route('/auth/callback')(callback.ctx);
      ensure(callback.redirects[0] === '/', `callback redirected to ${callback.redirects[0]}`);
      return session.get('authkit') as TokenSet;
    }

    test('discovers the IdP endpoints from the issuer alone', async ({ assert }) => {
      const endpoints = await manager.endpoints();
      assert.match(new URL(endpoints.authorizationEndpoint).pathname, spec.authorizePath);
      assert.equal(endpoints.issuer, idp.issuer);
      assert.isString(endpoints.endSessionEndpoint);
    })
      .skip(!DOCKER, 'Docker not available')
      .timeout(FLOW_TIMEOUT_MS);

    test('login: authorize carries state, nonce and S256 PKCE', async ({ assert }) => {
      const login = fakeCtx(manager, fakeSession());
      await route('/auth/login')(login.ctx);
      const params = new URL(login.redirects[0]).searchParams;
      assert.isString(params.get('state'));
      assert.isString(params.get('nonce'));
      assert.equal(params.get('code_challenge_method'), 'S256');
    })
      .skip(!DOCKER, 'Docker not available')
      .timeout(FLOW_TIMEOUT_MS);

    test('callback validates the real id_token and starts the session', async ({ assert }) => {
      const tokens = await signIn();
      assert.isString(tokens.idToken);
      assert.isString(tokens.refreshToken);

      const claims = await manager.validateIdToken(tokens.idToken);
      assert.equal(claims.email, 'ada@example.com');
      if (idp.expectedSub) assert.equal(claims.sub, idp.expectedSub);

      // resolvers.jwt() verified the session id_token against the discovered JWKS.
      const identity = await (
        await manager.createAuthenticator(fakeCtx(manager, session).ctx)
      ).getIdentity();
      assert.equal(identity?.userId, claims.sub);
    })
      .skip(!DOCKER, 'Docker not available')
      .timeout(FLOW_TIMEOUT_MS);

    test('a replayed callback is not accepted twice', async ({ assert }) => {
      const replaySession = fakeSession();
      const login = fakeCtx(manager, replaySession);
      await route('/auth/login')(login.ctx);
      const callbackUrl = await idp.login(login.redirects[0]);
      const qs = Object.fromEntries(callbackUrl.searchParams);

      await route('/auth/callback')(fakeCtx(manager, replaySession, qs).ctx);
      replaySession.forget('authkit');
      const replay = fakeCtx(manager, replaySession, qs);
      await route('/auth/callback')(replay.ctx);
      assert.equal(replay.redirects[0], '/auth/login');
      assert.isUndefined(replaySession.get('authkit'));
    })
      .skip(!DOCKER, 'Docker not available')
      .timeout(FLOW_TIMEOUT_MS);

    test('refresh hits the discovered token endpoint and keeps the same user', async ({
      assert,
    }) => {
      const before = (session.get('authkit') as TokenSet) ?? (await signIn());
      const beforeSub = (await manager.validateIdToken(before.idToken)).sub;
      // Pretend the access token is about to expire.
      session.put('authkit', { ...before, expiresAt: Date.now() + 1_000 });

      await manager.maybeRefresh(fakeCtx(manager, session).ctx);
      const after = session.get('authkit') as TokenSet;
      assert.notEqual(after.accessToken, before.accessToken);
      assert.isAbove(after.expiresAt ?? 0, Date.now() + 1_000);
      assert.equal((await manager.validateIdToken(after.idToken)).sub, beforeSub);
    })
      .skip(!DOCKER, 'Docker not available')
      .timeout(FLOW_TIMEOUT_MS);

    test('logout ends the local session and the IdP accepts the end-session URL', async ({
      assert,
    }) => {
      if (!session.get('authkit')) await signIn();
      const logout = fakeCtx(manager, session);
      await route('/auth/logout')(logout.ctx);
      assert.isUndefined(session.get('authkit'));

      const endSession = new URL(logout.redirects[0]);
      const { endSessionEndpoint } = await manager.endpoints();
      assert.equal(`${endSession.origin}${endSession.pathname}`, endSessionEndpoint);
      assert.equal(endSession.searchParams.get('post_logout_redirect_uri'), POST_LOGOUT);

      const res = await fetch(endSession, { redirect: 'manual' });
      assert.isBelow(res.status, 400, `end-session answered ${res.status}`);
    })
      .skip(!DOCKER, 'Docker not available')
      .timeout(FLOW_TIMEOUT_MS);
  });
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
