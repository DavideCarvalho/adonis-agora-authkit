import { execFile } from 'node:child_process';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { test } from '@japa/runner';
import { resolveAppCalls } from '../src/app_calls/config.js';
import { appForOrigin, DISCOVERY_SLOT } from '../src/app_calls/discovery.js';
import { authkitService, getAgoraCaller } from '../src/app_calls/inbound.js';
import {
  AppTokens,
  appCallsInterceptor,
  composeGlobalDispatcher,
  fetchPassesThroughAppCalls,
  hasAuthorization,
  installNodeHttpHook,
} from '../src/app_calls/outbound.js';
import { defineConfig, resolvers } from '../src/define_config.js';
import { __clearDiscoveryCacheForTests } from '../src/discovery.js';
import { type MemoryIssuer, startMemoryIssuer } from './helpers/memory_issuer.js';

/** A listening HTTP server whose handler is set later (its origin is known up front). */
async function listen(): Promise<{
  origin: string;
  server: Server;
  setHandler(h: Parameters<typeof createServer>[1]): void;
  close(): Promise<void>;
}> {
  let handler: any = (_req: any, res: any) => res.end();
  const server = createServer((req, res) => handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server,
    setHandler: (h) => {
      handler = h;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** Boots a real AdonisJS app with the authkit-client provider and serves it on `slot`. */
async function bootApp(
  slot: Awaited<ReturnType<typeof listen>>,
  config: Parameters<typeof defineConfig>[0],
  routes: (router: any) => void,
  beforeStart?: (app: ApplicationService) => void | Promise<void>,
): Promise<ApplicationService> {
  const app = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      config: { authkit_client: defineConfig(config) },
      rcFileContents: {
        providers: [() => import('../providers/authkit_client_provider.js')],
      },
    })
    .create(new URL('./tmp/app_calls/', import.meta.url))
    .createApp('web');
  await app.init();
  await app.boot();
  routes(await app.container.make('router'));
  await beforeStart?.(app);
  await app.start(async () => {});
  const server = await app.container.make('server');
  await server.boot();
  slot.setHandler((req, res) => server.handle(req, res));
  return app;
}

/** What B's `/whoami` answers: the caller and the Authorization header it received. */
interface WhoAmI {
  caller: ReturnType<typeof getAgoraCaller> | null;
  authorization: string | null;
}

const CLIENTS: Record<
  string,
  { secret: string; partition: string; apps: Record<string, string[]> }
> = {
  orders: {
    secret: 'orders-secret',
    partition: 'orders',
    apps: { billing: ['invoices:read'], shipping: ['labels:create'] },
  },
};

test.group('calls between apps (two AdonisJS apps, in-memory issuer)', (group) => {
  let idp: MemoryIssuer;
  let a: Awaited<ReturnType<typeof listen>>;
  let b: Awaited<ReturnType<typeof listen>>;
  let c: Awaited<ReturnType<typeof listen>>;
  let ghost: Awaited<ReturnType<typeof listen>>;
  let s: Awaited<ReturnType<typeof listen>>;
  let appA: ApplicationService;
  let appB: ApplicationService;
  let appS: ApplicationService;
  /** The discovery telescope would publish: only `shipping` (and a lie about B). */
  const discovered = new Map<string, string>();
  /** Who subscribed to the published discovery. */
  const listeners = new Set<(apps?: unknown) => void>();
  const resources = () => idp.tokenRequests.map((r) => r.body.get('resource'));
  async function until(check: () => boolean, ms = 2000) {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  /** A node:http GET; resolves with the parsed JSON body or rejects with the request error. */
  function nodeGet(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(url, (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve(raw ? JSON.parse(raw) : null));
      });
      req.on('error', reject);
      req.end();
    });
  }
  /** Requests the unknown origin C received. */
  const seenByC: IncomingHttpHeaders[] = [];

  group.setup(async () => {
    __clearDiscoveryCacheForTests();
    idp = await startMemoryIssuer();
    // client_credentials for `urn:agora:app:<name>`, like authkit-server issues them.
    idp.tokenResponse = async (body, authorization) => {
      const [id, secret] = Buffer.from((authorization ?? '').replace(/^Basic /, ''), 'base64')
        .toString()
        .split(':');
      const client = CLIENTS[decodeURIComponent(id ?? '')];
      if (!client || client.secret !== decodeURIComponent(secret ?? '')) {
        return { status: 401, body: { error: 'invalid_client' } };
      }
      const resource = body.get('resource') ?? '';
      const app = resource.replace(/^urn:agora:app:/, '');
      const capabilities = client.apps[app];
      if (!resource.startsWith('urn:agora:app:') || !capabilities) {
        return { status: 400, body: { error: 'invalid_target' } };
      }
      const token = await idp.sign({
        aud: resource,
        sub: id,
        client_id: id,
        partition: client.partition,
        ...(capabilities.length ? { capabilities } : {}),
      });
      return { status: 200, body: { access_token: token, token_type: 'Bearer', expires_in: 300 } };
    };

    [a, b, c, ghost, s] = await Promise.all([listen(), listen(), listen(), listen(), listen()]);
    c.setHandler((req, res) => {
      seenByC.push(req.headers);
      res.end('c');
    });

    const base = {
      issuer: idp.issuer,
      redirectUri: 'http://127.0.0.1/cb',
      resolver: resolvers.jwt({ tokenSource: 'session' }),
      orgLabels: false as const,
    };

    // B (billing): only accepts calls; needs no credentials.
    appB = await bootApp(
      b,
      { ...base, clientId: 'billing-web', service: { name: 'billing' } },
      (router) => {
        const whoami = (ctx: HttpContext): WhoAmI => ({
          caller: getAgoraCaller(ctx) ?? null,
          authorization: ctx.request.header('authorization') ?? null,
        });
        router.get('/whoami', whoami);
        router.get('/agora', (ctx: HttpContext) => ({
          type: typeof ctx.agora,
          caller: ctx.agora.caller ?? null,
        }));
        router.get('/internal/invoices', whoami).use(authkitService());
        router
          .get('/internal/invoices/write', whoami)
          .use(authkitService({ capabilities: ['invoices:write'] }));
        router.get('/internal/only-reports', whoami).use(authkitService({ apps: ['reports'] }));
        router.get('/redirect-to-c', ({ response }: HttpContext) =>
          response.redirect(`${c.origin}/landing`),
        );
        router.get('/redirect-to-self', ({ response }: HttpContext) =>
          response.redirect(`${b.origin}/internal/invoices`),
        );
      },
    );

    // S (shipping): reached only through discovery.
    appS = await bootApp(
      s,
      { ...base, clientId: 'shipping-web', service: { name: 'shipping' } },
      (router) => {
        router
          .get('/internal/labels', (ctx: HttpContext) => ({ caller: getAgoraCaller(ctx) ?? null }))
          .use(authkitService({ capabilities: ['labels:create'] }));
      },
    );

    // What telescope does: publish discovery on the shared slot and rewrite
    // `http://<app>/…` to the app's origin in an interceptor that runs BEFORE authkit's
    // (composed later = outer).
    discovered.set(s.origin, 'shipping');
    discovered.set(b.origin, 'shipping'); // the static `apps` map must win over this
    const names = new Map([['shipping', s.origin]]);
    (globalThis as any)[DISCOVERY_SLOT] = {
      resolve: (name: string) => names.get(name),
      appOf: (origin: string) => discovered.get(origin),
      subscribe: (fn: (apps?: unknown) => void) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };

    // A (orders): calls billing (B) and a "ghost" app it was never granted.
    appA = await bootApp(
      a,
      {
        ...base,
        clientId: 'orders-web',
        service: {
          name: 'orders',
          clientId: 'orders',
          clientSecret: 'orders-secret',
          nodeHttp: true,
        },
        apps: { billing: b.origin, ghost: ghost.origin },
      },
      (router) => {
        router.get('/invoices', async () => (await fetch(`${b.origin}/internal/invoices`)).json());
      },
    );

    // Composed after A's provider installed its interceptor: runs before it.
    const unrewrite = composeGlobalDispatcher((dispatch) => (opts: any, handler: any) => {
      const target = names.get(new URL(opts.origin).hostname);
      return dispatch(target ? { ...opts, origin: target } : opts, handler);
    });

    return async () => {
      unrewrite?.();
      delete (globalThis as any)[DISCOVERY_SLOT];
      await appA.terminate();
      await appB.terminate();
      await appS.terminate();
      await Promise.all([a.close(), b.close(), c.close(), ghost.close(), s.close(), idp.close()]);
    };
  });

  test('self-check: the global fetch goes through the interceptor (this Node, this undici)', async ({
    assert,
  }) => {
    assert.isTrue(await fetchPassesThroughAppCalls(), `Node ${process.version}`);
  });

  test('node:http: static apps are pre-warmed at boot, before any call', async ({ assert }) => {
    // No waiting: A's start (awaited in setup) only finished once the token was in.
    assert.include(resources(), 'urn:agora:app:billing');
    const body = await nodeGet(`${b.origin}/internal/invoices`);
    assert.equal(body.caller?.app, 'orders');
  });

  test('node:http: an app announced by discovery is pre-warmed through subscribe', async ({
    assert,
  }) => {
    assert.notInclude(resources(), 'urn:agora:app:shipping');
    assert.isAbove(listeners.size, 0);
    for (const fn of listeners) fn(new Map([['shipping', s.origin]]));
    await until(() => resources().includes('urn:agora:app:shipping'));
    // Joins the in-flight fetch subscribe started (single-flight): no new request, no sleep.
    const before = resources().length;
    const manager = await appA.container.make('authkit.client');
    await manager.appCallTokens()!.token('shipping');
    assert.lengthOf(resources(), before);
    const body = await nodeGet(`${s.origin}/internal/labels`);
    assert.equal(body.caller?.app, 'orders');
  });

  test('node:http: a known app with no token is failed, never sent bare', async ({ assert }) => {
    let reached = false;
    ghost.setHandler((_req, res) => {
      reached = true;
      res.end();
    });
    const error = await nodeGet(`${ghost.origin}/x`).catch((e) => e);
    assert.equal(error?.code, 'E_AGORA_APP_TOKEN_UNAVAILABLE');
    assert.equal(error?.app, 'ghost');
    assert.match(error.message, /was not sent/);
    assert.isFalse(reached);
  });

  test('ctx.agora is always an object; ctx.agora.caller only for apps', async ({ assert }) => {
    // With an Authorization of its own (any process fetch to B would get a token).
    const res = await fetch(`${b.origin}/agora`, { headers: { authorization: 'Basic eDp5' } });
    assert.deepEqual(await res.json(), { type: 'object', caller: null });
  });

  test('a plain fetch from A to B is authenticated; B sees caller A', async ({ assert }) => {
    // Through a route of A, the way app code calls another app.
    const res = await fetch(`${a.origin}/invoices`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as WhoAmI;
    assert.deepInclude(body.caller!, {
      app: 'orders',
      capabilities: ['invoices:read'],
      clientId: 'orders',
    });
    assert.match(body.authorization!, /^Bearer /);

    // One token, cached: a second call does not hit the token endpoint again.
    const before = idp.tokenRequests.length;
    await (await fetch(`${b.origin}/internal/invoices`)).json();
    assert.equal(idp.tokenRequests.length, before);
    assert.include(
      idp.tokenRequests.map((r) => r.body.get('resource')),
      'urn:agora:app:billing',
    );
  });

  test('discovery: fetch(`http://shipping/…`) is rewritten, then authenticated for shipping', async ({
    assert,
  }) => {
    const res = await fetch('http://shipping/internal/labels');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { caller: { app: string; capabilities: string[] } };
    assert.deepInclude(body.caller, { app: 'orders', capabilities: ['labels:create'] });
  });

  test('the static `apps` map overrides discovery for its origins', async ({ assert }) => {
    // Discovery claims B is `shipping`; the static map says `billing`, which wins: B
    // receives a billing token and accepts it.
    const res = await fetch(`${b.origin}/internal/invoices`);
    assert.equal(((await res.json()) as WhoAmI).caller?.app, 'orders');
  });

  test('without published discovery, only the static map counts', async ({ assert }) => {
    const slot = (globalThis as any)[DISCOVERY_SLOT];
    delete (globalThis as any)[DISCOVERY_SLOT];
    try {
      // Shipping is no longer a known app: no token, its protected route refuses.
      assert.equal((await fetch(`${s.origin}/internal/labels`)).status, 401);
      // Billing (static) still works.
      const res = await fetch(`${b.origin}/internal/invoices`);
      assert.equal(((await res.json()) as WhoAmI).caller?.app, 'orders');
    } finally {
      (globalThis as any)[DISCOVERY_SLOT] = slot;
    }
  });

  test('capabilities and allowed apps are enforced on protected routes (403)', async ({
    assert,
  }) => {
    const write = await fetch(`${b.origin}/internal/invoices/write`);
    assert.equal(write.status, 403);
    assert.equal(((await write.json()) as any).error, 'insufficient_capabilities');
    const reports = await fetch(`${b.origin}/internal/only-reports`);
    assert.equal(reports.status, 403);
  });

  test('wrong audience, expired, forged and missing tokens are refused on protected routes', async ({
    assert,
  }) => {
    const call = (authorization?: string) =>
      fetch(`${b.origin}/internal/invoices`, {
        headers: authorization ? { authorization } : {},
      });
    const claims = {
      sub: 'orders',
      client_id: 'orders',
      partition: 'orders',
    };
    // Wrong audience: not addressed to billing, so no caller → 401.
    const wrongAud = await call(
      `Bearer ${await idp.sign({ ...claims, aud: 'urn:agora:app:reports' })}`,
    );
    assert.equal(wrongAud.status, 401);
    // Expired.
    const now = Math.floor(Date.now() / 1000);
    const expired = await call(
      `Bearer ${await idp.sign({ ...claims, aud: 'urn:agora:app:billing', iat: now - 900, exp: now - 600 })}`,
    );
    assert.equal(expired.status, 401);
    assert.equal(((await expired.json()) as any).error, 'invalid_token');
    // Signed by an unknown key (an issuer B does not trust).
    const forged = await call(
      `Bearer ${await idp.sign({ ...claims, aud: 'urn:agora:app:billing' }, { key: 'foreign' })}`,
    );
    assert.equal(forged.status, 401);
    // Not a service token (no partition: an unknown app).
    const noPartition = await call(
      `Bearer ${await idp.sign({ sub: 'x', client_id: 'x', aud: 'urn:agora:app:billing' })}`,
    );
    assert.equal(noPartition.status, 401);
  });

  test('user requests and the app’s own Authorization are left untouched', async ({ assert }) => {
    // The app set its own header: the interceptor never overrides it.
    const own = (await (
      await fetch(`${b.origin}/whoami`, { headers: { authorization: 'Bearer user-token' } })
    ).json()) as WhoAmI;
    assert.equal(own.authorization, 'Bearer user-token');
    assert.isNull(own.caller);

    // A user's JWT (another audience) on B: no caller, no rejection on a public route.
    const userToken = await idp.sign({ sub: 'u1', aud: 'billing-web', email: 'u@x.com' });
    const user = await fetch(`${b.origin}/whoami`, {
      headers: { authorization: `Bearer ${userToken}` },
    });
    assert.equal(user.status, 200);
    assert.isNull(((await user.json()) as WhoAmI).caller);

    // A protected route refuses a user.
    const refused = await fetch(`${b.origin}/internal/invoices`, {
      headers: { authorization: `Bearer ${userToken}` },
    });
    assert.equal(refused.status, 401);
  });

  test('the token is never sent to another origin, nor across a redirect', async ({ assert }) => {
    seenByC.length = 0;
    await (await fetch(`${c.origin}/direct`)).text();
    // B redirects to C: the redirected request leaves without the token.
    const redirected = await fetch(`${b.origin}/redirect-to-c`);
    assert.equal(await redirected.text(), 'c');
    assert.lengthOf(seenByC, 2);
    for (const headers of seenByC) assert.notProperty(headers, 'authorization');

    // A redirect back to B itself is authenticated again (B is an app).
    const self = await fetch(`${b.origin}/redirect-to-self`);
    assert.equal(((await self.json()) as WhoAmI).caller?.app, 'orders');
  });

  test('a token that cannot be obtained fails the request instead of sending it bare', async ({
    assert,
  }) => {
    let reached = false;
    ghost.setHandler((_req, res) => {
      reached = true;
      res.end();
    });
    const error = await fetch(`${ghost.origin}/x`).catch((e) => e);
    assert.instanceOf(error, TypeError);
    assert.match(String(error.cause?.message), /invalid_target/);
    assert.isFalse(reached);
  });

  test('node:http requests get the cached token (opt-in hook), only for apps', async ({
    assert,
  }) => {
    const body = await nodeGet(`${b.origin}/internal/invoices`);
    assert.equal(body.caller?.app, 'orders');
    seenByC.length = 0;
    await new Promise<void>((resolve) => {
      httpRequest(`${c.origin}/node`, (res) => res.resume().on('end', resolve)).end();
    });
    assert.notProperty(seenByC[0]!, 'authorization');
  });
});

test.group('calls between apps: config and helpers', () => {
  test('resolveAppCalls validates names, origins and credentials', ({ assert }) => {
    // Credentials without a static map: targets come from discovery.
    assert.equal(
      resolveAppCalls({ name: 'orders', clientId: 'orders', clientSecret: 's' }, undefined)?.origins
        .size,
      0,
    );
    const ok = resolveAppCalls(
      { name: 'orders', clientId: 'orders', clientSecret: 's' },
      { billing: 'https://Billing.example.com/' },
    );
    assert.equal(ok?.origins.get('https://billing.example.com'), 'billing');
    assert.isUndefined(resolveAppCalls(undefined, undefined));
    assert.throws(() => resolveAppCalls(undefined, { billing: 'https://b' }), /needs `service/);
    assert.throws(() => resolveAppCalls({ name: 'bad name' }, {}), /service.name/);
    assert.throws(() => resolveAppCalls({ name: 'a' }, { billing: 'https://b' }), /clientSecret/);
    const creds = { name: 'a', clientId: 'a', clientSecret: 's' };
    assert.throws(() => resolveAppCalls(creds, { billing: 'ftp://b' }), /http\(s\) URL/);
    assert.throws(() => resolveAppCalls(creds, { billing: 'https://b/api' }), /origin only/);
    assert.throws(
      () => resolveAppCalls(creds, { billing: 'https://b', other: 'https://b:443' }),
      /share the origin/,
    );
  });

  test('appForOrigin: static first, then the slot; bad or throwing answers are ignored', ({
    assert,
  }) => {
    const statics = new Map([['https://billing.example.com', 'billing']]);
    const g = globalThis as any;
    const saved = g[DISCOVERY_SLOT];
    try {
      delete g[DISCOVERY_SLOT];
      assert.isUndefined(appForOrigin('https://shipping.example.com', statics));
      g[DISCOVERY_SLOT] = {
        resolve: () => undefined,
        appOf: (o: string) =>
          ({
            'https://shipping.example.com': 'shipping',
            'https://billing.example.com': 'other',
            'https://weird.example.com': 'bad name',
          })[o],
        subscribe: () => {},
      };
      assert.equal(appForOrigin('https://shipping.example.com', statics), 'shipping');
      assert.equal(appForOrigin('https://billing.example.com', statics), 'billing');
      assert.isUndefined(appForOrigin('https://weird.example.com', statics));
      g[DISCOVERY_SLOT] = {
        appOf: () => {
          throw new Error('boom');
        },
      };
      assert.isUndefined(appForOrigin('https://shipping.example.com', statics));
      g[DISCOVERY_SLOT] = { not: 'discovery' };
      assert.isUndefined(appForOrigin('https://shipping.example.com', statics));
    } finally {
      if (saved === undefined) delete g[DISCOVERY_SLOT];
      else g[DISCOVERY_SLOT] = saved;
    }
  });

  test('interceptor: keeps a Headers instance a Headers instance', async ({ assert }) => {
    let seen: any;
    const dispatch = appCallsInterceptor({
      origins: new Map([['https://billing.example.com', 'billing']]),
      token: async () => 'tok',
    })((opts) => {
      seen = opts;
      return true;
    });
    dispatch(
      { origin: 'https://billing.example.com', headers: new Headers({ accept: 'x' }) },
      { onResponseError: () => {} },
    );
    await new Promise((r) => setTimeout(r, 0));
    assert.instanceOf(seen.headers, Headers);
    assert.equal(seen.headers.get('authorization'), 'Bearer tok');
    assert.equal(seen.headers.get('accept'), 'x');
  });

  test('interceptor: also works composed outside a discovery rewrite (`http://<name>`)', async ({
    assert,
  }) => {
    const g = globalThis as any;
    const saved = g[DISCOVERY_SLOT];
    g[DISCOVERY_SLOT] = {
      resolve: (n: string) => (n === 'shipping' ? 'https://ship.internal:8443' : undefined),
      appOf: (o: string) => (o === 'https://ship.internal:8443' ? 'shipping' : undefined),
    };
    try {
      let seen: any;
      // Rewrite INSIDE authkit (authkit sees `http://shipping` first).
      const rewrite = (opts: any) => {
        seen = { ...opts, origin: 'https://ship.internal:8443' };
        return true;
      };
      const dispatch = appCallsInterceptor({
        origins: new Map(),
        token: async (app) => `tok-${app}`,
      })(rewrite);
      dispatch({ origin: 'http://shipping', headers: {} }, { onResponseError: () => {} });
      await new Promise((r) => setTimeout(r, 0));
      assert.equal(seen.headers.authorization, 'Bearer tok-shipping');
      assert.equal(seen.origin, 'https://ship.internal:8443');
      // A host discovery does not resolve gets nothing.
      assert.isUndefined(appForOrigin('http://unknown', new Map()));
      assert.equal(appForOrigin('http://shipping', new Map()), 'shipping');
      assert.isUndefined(appForOrigin('http://shipping:8080', new Map()));
    } finally {
      if (saved === undefined) delete g[DISCOVERY_SLOT];
      else g[DISCOVERY_SLOT] = saved;
    }
  });

  test('fresh process: composes before AND after a `.1` set ahead of the bundled undici', async ({
    assert,
  }) => {
    const outbound = fileURLToPath(new URL('../src/app_calls/outbound.ts', import.meta.url));
    const script = `
      const g = globalThis;
      const m = await import(${JSON.stringify(outbound)});
      const results = {};
      // 1. A clean process (nothing loaded): the bundled undici loads on the first fetch() call.
      const S = [Symbol.for('undici.globalDispatcher.2'), Symbol.for('undici.globalDispatcher.1')];
      const undo = m.composeGlobalDispatcher(m.appCallsInterceptor({ origins: new Map(), token: async () => 't' }));
      const installed = S.map((s) => g[s]);
      results.clean = await m.fetchPassesThroughAppCalls();
      undo();
      // Uninstalled: every slot is back to what it was (no network involved).
      results.uninstalled = S.every((s, i) => g[s] !== installed[i]);
      process.stdout.write(JSON.stringify(results));
    `;
    const clean = await new Promise<string>((resolve, reject) =>
      execFile(
        process.execPath,
        ['--import=@poppinss/ts-exec', '--input-type=module', '-e', script],
        { cwd: fileURLToPath(new URL('..', import.meta.url)) },
        (error, stdout, stderr) =>
          error ? reject(new Error(stderr || String(error))) : resolve(stdout),
      ),
    );
    assert.deepEqual(JSON.parse(clean), { clean: true, uninstalled: true });

    // 2. Only `.1` set before the bundled undici loads (an older npm undici, another lib).
    const preset = script.replace(
      'const results = {};',
      `const results = {};
       const fake = { dispatch() { return true }, compose(i) { return { dispatch: i(this.dispatch.bind(this)), compose: this.compose } } };
       g[Symbol.for('undici.globalDispatcher.1')] = fake;`,
    );
    const out = await new Promise<string>((resolve, reject) =>
      execFile(
        process.execPath,
        ['--import=@poppinss/ts-exec', '--input-type=module', '-e', preset],
        { cwd: fileURLToPath(new URL('..', import.meta.url)) },
        (error, stdout, stderr) =>
          error ? reject(new Error(stderr || String(error))) : resolve(stdout),
      ),
    );
    assert.isTrue(JSON.parse(out).clean, process.version);
  }).timeout(20_000);

  test('pre-warm: a stalled issuer delays the start at most prewarmTimeoutMs, then warns', async ({
    assert,
  }) => {
    const stalled = await startMemoryIssuer();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    stalled.tokenResponse = async () => {
      await gate;
      return { status: 503, body: { error: 'temporarily_unavailable' } };
    };
    const slot = await listen();
    const warnings: string[] = [];
    let app: ApplicationService | undefined;
    try {
      const started = Date.now();
      app = await bootApp(
        slot,
        {
          issuer: stalled.issuer,
          clientId: 'x',
          redirectUri: 'http://127.0.0.1/cb',
          resolver: resolvers.jwt({ tokenSource: 'session' }),
          orgLabels: false,
          service: {
            name: 'late',
            clientId: 'orders',
            clientSecret: 'orders-secret',
            nodeHttp: true,
            prewarmTimeoutMs: 100,
          },
          apps: { invoicing: 'http://invoicing.example.test' },
        },
        () => {},
        async (booted) => {
          const logger = await booted.container.make('logger');
          const warn = logger.warn.bind(logger);
          (logger as any).warn = (...args: any[]) => {
            warnings.push(String(args.at(-1)));
            return (warn as any)(...args);
          };
        },
      );
      const elapsed = Date.now() - started;
      assert.isAtLeast(elapsed, 100);
      assert.isBelow(elapsed, 3000);
      const warning = warnings.find((w) => w.includes('no service token after 100 ms'));
      assert.match(warning ?? '', /invoicing/);
      assert.notMatch(warning ?? '', /orders-secret/);
    } finally {
      release();
      await app?.terminate();
      await slot.close();
      await stalled.close();
    }
  }).timeout(10_000);

  test('self-check: a global dispatcher replaced behind authkit fails the start loudly', async ({
    assert,
  }) => {
    const slots = [
      Symbol.for('undici.globalDispatcher.2'),
      Symbol.for('undici.globalDispatcher.1'),
    ];
    const g = globalThis as any;
    const saved = slots.map((slot) => g[slot]);
    // A dispatcher that drops every interceptor composed onto it (what a replacement does).
    const rogue: any = {
      dispatch: (_opts: any, handler: any) => {
        const error = new Error('rogue');
        if (typeof handler.onResponseError === 'function') handler.onResponseError(null, error);
        else handler.onError?.(error);
        return true;
      },
      compose: () => rogue,
    };
    const slot = await listen();
    try {
      for (const s of slots) if (g[s]) g[s] = rogue;
      assert.isFalse(await fetchPassesThroughAppCalls());
      await assert.rejects(
        () =>
          bootApp(
            slot,
            {
              issuer: 'http://127.0.0.1:1',
              clientId: 'x',
              redirectUri: 'http://127.0.0.1/cb',
              resolver: resolvers.jwt({ tokenSource: 'session' }),
              orgLabels: false,
              service: { name: 'orders', clientId: 'orders', clientSecret: 's' },
            },
            () => {},
          ),
        /does not go through the calls-between-apps interceptor/,
      );
    } finally {
      slots.forEach((s, i) => {
        if (saved[i] !== undefined) g[s] = saved[i];
      });
      await slot.close();
    }
  });

  test('a wrong `service`/`apps` fails the boot instead of being swallowed', async ({ assert }) => {
    const slot = await listen();
    try {
      await assert.rejects(
        () =>
          bootApp(
            slot,
            {
              issuer: 'http://127.0.0.1:1',
              clientId: 'x',
              redirectUri: 'http://127.0.0.1/cb',
              resolver: resolvers.jwt({ tokenSource: 'session' }),
              service: { name: 'orders', clientId: 'orders', clientSecret: 's' },
              apps: { billing: 'https://billing.example.com/api' },
            },
            () => {},
          ),
        /origin only/,
      );
    } finally {
      await slot.close();
    }
  });

  test('the node:http hook refreshes tokens on every tick', async ({ assert }) => {
    let calls = 0;
    const tokens = {
      token: async () => {
        calls += 1;
        return 't';
      },
      peek: () => 't',
    } as unknown as AppTokens;
    const stop = installNodeHttpHook({
      origins: new Map([['https://billing.example.com', 'billing']]),
      tokens,
      refreshEveryMs: 10,
    });
    await new Promise((r) => setTimeout(r, 60));
    stop();
    assert.isAtLeast(calls, 3);
  });

  test('hasAuthorization reads every undici header shape', ({ assert }) => {
    assert.isTrue(hasAuthorization({ Authorization: 'x' }));
    assert.isTrue(hasAuthorization(['accept', '*/*', 'authorization', 'x']));
    assert.isTrue(hasAuthorization([['authorization', 'x']]));
    assert.isTrue(hasAuthorization(new Headers({ authorization: 'x' })));
    assert.isFalse(hasAuthorization({ accept: '*/*' }));
    assert.isFalse(hasAuthorization(['accept', 'authorization-like']));
    assert.isFalse(hasAuthorization(undefined));
  });
});
