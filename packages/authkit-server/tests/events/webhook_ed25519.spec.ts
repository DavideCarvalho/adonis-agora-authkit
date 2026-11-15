import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import { generateKeyPair, toJwks, verify } from '../../src/crypto-kit/index.js';
import { adapters, defineConfig } from '../../src/define_config.js';
import {
  composeAuditSink,
  resolveWebhookSigningKeys,
  signWebhookBodyEd25519,
} from '../../src/events/dispatcher.js';
import { OidcService } from '../../src/provider/oidc_service.js';
import { createTestDatabase, fakeAccountStore } from '../bootstrap.js';

const APP_KEY = 'app-key-of-the-test-app-32-chars';

async function capture(fn: (url: string) => Promise<void>) {
  const captured: Array<{ body: string; headers: Record<string, unknown> }> = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      captured.push({ body, headers: req.headers });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as any).port}/hook`);
    const deadline = Date.now() + 3000;
    while (captured.length === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
  return captured;
}

test.group('webhooks signed with Ed25519', () => {
  test('every delivery carries x-authkit-signature-ed25519; the HMAC too when a secret is set', async ({
    assert,
  }) => {
    const [signingKey] = resolveWebhookSigningKeys(undefined, APP_KEY);
    const withSecret = await capture(async (url) => {
      const sink = composeAuditSink(undefined, {
        webhook: { url, secret: 's3cr3t' },
        signingKey,
      });
      await sink.record({ type: 'signup', email: 'x@y.z' });
    });
    const [delivery] = withSecret;
    const ed = delivery?.headers['x-authkit-signature-ed25519'] as string;
    assert.match(ed, /^agora:sig1:/);
    assert.isTrue(verify(signingKey!, delivery!.body, ed));
    assert.isFalse(verify(signingKey!, `${delivery!.body} `, ed));
    assert.equal(
      delivery?.headers['x-authkit-signature'],
      `sha256=${createHmac('sha256', 's3cr3t').update(delivery!.body).digest('hex')}`,
    );

    const noSecret = await capture(async (url) => {
      await composeAuditSink(undefined, { webhook: { url }, signingKey }).record({
        type: 'signup',
      });
    });
    assert.isUndefined(noSecret[0]?.headers['x-authkit-signature']);
    assert.match(noSecret[0]?.headers['x-authkit-signature-ed25519'] as string, /^agora:sig1:/);
  });

  test('the default key is derived from the app key: the same on every instance', ({ assert }) => {
    const [a] = resolveWebhookSigningKeys(undefined, APP_KEY);
    const [b] = resolveWebhookSigningKeys(undefined, APP_KEY);
    assert.deepEqual(a, b);
    assert.equal(a?.crv, 'Ed25519');
    assert.isString(a?.d);
    assert.notEqual(
      resolveWebhookSigningKeys(undefined, 'another-app-key-of-32-characters')[0]?.x,
      a?.x,
    );
    assert.deepEqual(resolveWebhookSigningKeys(false, APP_KEY), []);
    assert.deepEqual(resolveWebhookSigningKeys(undefined, undefined), []);
  });

  test('signing.keys: given keys (objects or JSON), newest first; a public key is refused', ({
    assert,
  }) => {
    const next = generateKeyPair('ed25519', { kid: 'wh-2' });
    const old = generateKeyPair('ed25519', { kid: 'wh-1' });
    const keys = resolveWebhookSigningKeys(
      { keys: [JSON.stringify(next.privateKey), old.privateKey] },
      APP_KEY,
    );
    assert.deepEqual(
      keys.map((k) => k.kid),
      ['wh-2', 'wh-1'],
    );
    const signature = signWebhookBodyEd25519('{"id":"1"}', keys[0]!);
    assert.isTrue(verify(toJwks(keys), '{"id":"1"}', signature));
    assert.throws(() => resolveWebhookSigningKeys({ keys: [next.publicKey] }, APP_KEY), /private/);
  });

  test('the discovery publishes the public keys as authkit_webhook_jwks', async ({ assert }) => {
    const PORT = 9791;
    const ISSUER = `http://localhost:${PORT}`;
    const db = createTestDatabase();
    const app = {
      container: { make: async () => db },
      config: { get: (key: string) => (key === 'app.appKey' ? APP_KEY : undefined) },
    } as any;
    const cfg: any = await configProvider.resolve(
      app,
      defineConfig({
        issuer: ISSUER,
        adapter: adapters.database({}),
        jwks: { source: 'managed' },
        accountStore: fakeAccountStore(),
        events: { webhook: { url: 'http://127.0.0.1:1/hook' } },
      }),
    );
    const service = new OidcService(cfg, APP_KEY);
    const server = createServer(service.callback);
    await new Promise<void>((r) => server.listen(PORT, r));
    try {
      const body: any = await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json();
      const [signingKey] = resolveWebhookSigningKeys(undefined, APP_KEY);
      assert.deepEqual(body.authkit_webhook_jwks, toJwks([signingKey!]));
      assert.isUndefined(body.authkit_webhook_jwks.keys[0].d);
      assert.deepEqual(body.claim_types_supported, ['normal']);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await db.manager.closeAll();
    }
  });
});
