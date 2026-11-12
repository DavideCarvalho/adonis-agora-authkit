import {
  ACCOUNT_EXTENSIONS_MANIFEST_SUBJECT,
  ACCOUNT_EXTENSIONS_SCOPE,
  ACCOUNT_EXTENSIONS_TOKEN_TYP,
  type AccountExtension,
  accountExtensionsBodyHash,
} from '@adonis-agora/authkit-core';
import { Container } from '@adonisjs/core/container';
import { test } from '@japa/runner';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import AuthkitClientProvider from '../providers/authkit_client_provider.js';
import {
  ACCOUNT_EXTENSIONS_BINDING,
  ClientAccountExtensionRegistry,
  serveAccountExtensions,
} from '../src/account_extensions.js';

const ISSUER = 'https://idp.test/oidc';

const keysPromise = (async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const pub = { ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'k1' };
  return { privateKey, keys: createLocalJWKSet({ keys: [pub] } as never) };
})();

async function token(
  claims: {
    sub?: string;
    aud?: string;
    iss?: string;
    scope?: string;
    bh?: string;
    typ?: string;
    ttl?: number;
  } = {},
) {
  const { privateKey } = await keysPromise;
  const iat = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { scope: claims.scope ?? ACCOUNT_EXTENSIONS_SCOPE };
  if (claims.bh) payload.bh = claims.bh;
  return new SignJWT(payload)
    .setProtectedHeader({
      alg: 'ES256',
      kid: 'k1',
      typ: claims.typ ?? ACCOUNT_EXTENSIONS_TOKEN_TYP,
    })
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? 'app')
    .setSubject(claims.sub ?? ACCOUNT_EXTENSIONS_MANIFEST_SUBJECT)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (claims.ttl ?? 60))
    .sign(privateKey);
}

function extension(seen: string[] = []): AccountExtension {
  return {
    id: 'files',
    contract: 1,
    pages: [
      {
        id: 'files.mine',
        segment: 'files',
        title: 'My files',
        load: async (ctx) => {
          seen.push(`${ctx.subject.type}:${ctx.subject.id}:${ctx.query.cursor ?? ''}`);
          return { blocks: [{ kind: 'notice', tone: 'info', text: `hi ${ctx.account.id}` }] };
        },
        actions: {
          remove: {
            label: 'Remove',
            fields: [{ name: 'why', label: 'Why', kind: 'text' }],
            handle: async (_ctx, input) => ({
              ok: true,
              flash: `removed ${input.target} (${input.fields.why}) ${Object.keys(input.fields).join(',')}`,
            }),
          },
        },
      },
    ],
  };
}

async function serve(
  init: { method?: string; authorization?: string; body?: unknown },
  config: Parameters<typeof serveAccountExtensions>[0]['config'] = { remote: true },
  seen: string[] = [],
) {
  const { keys } = await keysPromise;
  const rawBody = init.body === undefined ? null : JSON.stringify(init.body);
  return serveAccountExtensions({
    method: init.method ?? (rawBody === null ? 'GET' : 'POST'),
    authorization: init.authorization,
    rawBody,
    extensions: [extension(seen)],
    contract: 1,
    verifier: { issuer: ISSUER, clientId: 'app', keys },
    config,
    make: async () => null,
    log: () => {},
  });
}

const loadCall = {
  op: 'load',
  pageId: 'files.mine',
  account: { id: 'acc-1', email: 'a@x.test', name: 'A', roles: [] },
  activeOrg: null,
  tenant: { id: 'org-1', kind: 'organization', source: 'authkit' },
  impersonatedBy: null,
  locale: 'en',
  urls: {},
  query: { cursor: 'c2' },
};

const signed = async (call: unknown, sub = 'acc-1') =>
  `Bearer ${await token({ sub, bh: accountExtensionsBodyHash(JSON.stringify(call)) })}`;

test.group('account extensions (remote app) | endpoint auth', () => {
  test('no token → 401 with the scope in WWW-Authenticate', async ({ assert }) => {
    const answer = await serve({});
    assert.equal(answer.status, 401);
    assert.include(answer.headers?.['WWW-Authenticate'] ?? '', ACCOUNT_EXTENSIONS_SCOPE);
  });

  test('a token for another audience, issuer or typ, or too long-lived → 401', async ({
    assert,
  }) => {
    for (const bad of [
      { aud: 'other-app' },
      { iss: 'https://evil.test' },
      { typ: 'at+jwt' },
      { ttl: 3600 },
    ]) {
      const answer = await serve({ authorization: `Bearer ${await token(bad)}` });
      assert.equal(answer.status, 401, JSON.stringify(bad));
    }
    const garbage = await serve({ authorization: 'Bearer not.a.jwt' });
    assert.equal(garbage.status, 401);
  });

  test('a token without the scope → 403', async ({ assert }) => {
    const answer = await serve({ authorization: `Bearer ${await token({ scope: 'openid' })}` });
    assert.equal(answer.status, 403);
  });

  test('the manifest needs the manifest subject', async ({ assert }) => {
    const ok = await serve({ authorization: `Bearer ${await token()}` });
    assert.equal(ok.status, 200);
    const manifest = ok.body as any;
    assert.equal(manifest.version, 1);
    assert.equal(manifest.extensions[0].pages[0].segment, 'files');
    assert.deepEqual(Object.keys(manifest.extensions[0].pages[0].actions), ['remove']);
    const account = await serve({ authorization: `Bearer ${await token({ sub: 'acc-1' })}` });
    assert.equal(account.status, 403);
  });

  test('a call must match the signed body hash and account', async ({ assert }) => {
    const mismatch = await serve({
      authorization: `Bearer ${await token({ sub: 'acc-1', bh: 'x' })}`,
      body: loadCall,
    });
    assert.equal(mismatch.status, 403);
    const otherAccount = await serve({
      authorization: await signed(loadCall, 'acc-2'),
      body: loadCall,
    });
    assert.equal(otherAccount.status, 403);
  });
});

test.group('account extensions (remote app) | calls', () => {
  test('load runs with the subject hook, tenant and query', async ({ assert }) => {
    const seen: string[] = [];
    const answer = await serve(
      { authorization: await signed(loadCall), body: loadCall },
      {
        remote: true,
        subject: (account, { tenant }) => ({ type: 'Member', id: `${tenant?.id}/${account.id}` }),
      },
      seen,
    );
    assert.equal(answer.status, 200);
    assert.deepEqual(seen, ['Member:org-1/acc-1:c2']);
    assert.equal((answer.body as any).view.blocks[0].text, 'hi acc-1');
  });

  test('default subject is the account as a User', async ({ assert }) => {
    const seen: string[] = [];
    await serve({ authorization: await signed(loadCall), body: loadCall }, { remote: true }, seen);
    assert.deepEqual(seen, ['User:acc-1:c2']);
  });

  test('actions only receive declared fields', async ({ assert }) => {
    const call = {
      ...loadCall,
      op: 'action',
      action: 'remove',
      input: { target: 'f-1', fields: { why: 'old', admin: 'true' } },
    };
    const answer = await serve({ authorization: await signed(call), body: call });
    assert.equal(answer.status, 200);
    assert.equal((answer.body as any).result.flash, 'removed f-1 (old) why');
  });

  test('an unknown page or action is a 404', async ({ assert }) => {
    for (const call of [
      { ...loadCall, pageId: 'files.nope' },
      { ...loadCall, op: 'action', action: 'nope', input: { target: null, fields: {} } },
    ]) {
      const answer = await serve({ authorization: await signed(call), body: call });
      assert.equal(answer.status, 404);
    }
  });
});

test.group('account extensions (remote app) | registry binding', () => {
  function fakeApp() {
    return {
      container: new Container(),
      inProduction: false,
      config: { get: () => undefined },
    } as any;
  }

  test('authkit-client binds the registry when nothing else did', async ({ assert }) => {
    const app = fakeApp();
    new AuthkitClientProvider(app).register();
    const registry = await app.container.make(ACCOUNT_EXTENSIONS_BINDING);
    assert.instanceOf(registry, ClientAccountExtensionRegistry);
    assert.equal(registry.contract, 1);
    registry.register(extension());
    assert.lengthOf(registry.extensions(), 1);
  });

  test('an existing binding (authkit-server registered first) is kept', async ({ assert }) => {
    const app = fakeApp();
    const server = { contract: 1, blockKinds: [], register() {}, extensions: () => [] };
    app.container.singleton(ACCOUNT_EXTENSIONS_BINDING, async () => server);
    new AuthkitClientProvider(app).register();
    assert.strictEqual(await app.container.make(ACCOUNT_EXTENSIONS_BINDING), server);
  });

  test('a binding made after authkit-client (authkit-server registered second) wins', async ({
    assert,
  }) => {
    const app = fakeApp();
    new AuthkitClientProvider(app).register();
    const server = { contract: 1, blockKinds: [], register() {}, extensions: () => [] };
    app.container.singleton(ACCOUNT_EXTENSIONS_BINDING, async () => server);
    assert.strictEqual(await app.container.make(ACCOUNT_EXTENSIONS_BINDING), server);
  });
});
