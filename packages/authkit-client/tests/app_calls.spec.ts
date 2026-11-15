import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { test } from '@japa/runner';
import { resolveAppCalls } from '../src/app_calls/config.js';
import { appForOrigin, DISCOVERY_SLOT } from '../src/app_calls/discovery.js';
import { authkitService, getAgoraCaller } from '../src/app_calls/inbound.js';
import { composeGlobalDispatcher, hasAuthorization } from '../src/app_calls/outbound.js';
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

    // What telescope does: publish discovery on the shared slot and rewrite
    // `http://<app>/…` to the app's origin in an interceptor that runs BEFORE authkit's
    // (composed later = outer).
    discovered.set(s.origin, 'shipping');
    discovered.set(b.origin, 'shipping'); // the static `apps` map must win over this
    const names = new Map([['shipping', s.origin]]);
    (globalThis as any)[DISCOVERY_SLOT] = {
      resolve: (name: string) => names.get(name),
      appOf: (origin: string) => discovered.get(origin),
      subscribe: () => () => {},
    };
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

  test('node:http requests get the cached token (opt-in hook)', async ({ assert }) => {
    // The token for billing is cached by the previous calls.
    const body = await new Promise<WhoAmI>((resolve, reject) => {
      const req = httpRequest(`${b.origin}/internal/invoices`, (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => resolve(JSON.parse(raw)));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(body.caller?.app, 'orders');

    // Not for another origin.
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
