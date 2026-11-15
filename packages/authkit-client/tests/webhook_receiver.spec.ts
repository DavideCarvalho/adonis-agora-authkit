import {
  buildWebhookBody,
  composeAuditSink,
  resolveWebhookSigningKeys,
  signWebhookBody,
  signWebhookBodyEd25519,
} from '@adonis-agora/authkit-server';
import { test } from '@japa/runner';
import {
  authkitWebhookHandler,
  memoryReplayStore,
  verifyAuthkitWebhook,
  webhookKeys,
} from '../src/webhook_receiver.js';

const SECRET = 'whsec-test';
const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');

/** Captures what reaches the diagnostics bus while `fn` runs. */
async function captureBus(fn: () => Promise<void>) {
  const previous = (globalThis as any)[EMIT_SLOT];
  const emitted: Array<{ lib: string; event: string; payload: unknown }> = [];
  (globalThis as any)[EMIT_SLOT] = (lib: string, event: string, payload: unknown) =>
    emitted.push({ lib, event, payload });
  try {
    await fn();
  } finally {
    (globalThis as any)[EMIT_SLOT] = previous;
  }
  return emitted;
}

function fakeCtx(body: string | null, signature?: string, ed25519?: string) {
  const reply: { status?: number; body?: unknown } = {};
  const respond = (status: number) => (b?: unknown) => {
    reply.status = status;
    reply.body = b;
    return reply;
  };
  return {
    reply,
    ctx: {
      request: {
        raw: () => body,
        header: (name: string) =>
          name === 'x-authkit-signature'
            ? signature
            : name === 'x-authkit-signature-ed25519'
              ? ed25519
              : undefined,
      },
      response: {
        noContent: respond(204),
        unauthorized: respond(401),
        badRequest: respond(400),
      },
    } as any,
  };
}

const event = {
  type: 'organization.created' as const,
  accountId: 'acc-1',
  actorId: 'admin-1',
  clientId: null,
  orgId: 'org-1',
  email: 'owner@acme.test',
  ip: '10.0.0.1',
  metadata: { name: 'Acme' },
};

test.group('authkit webhook receiver', () => {
  test('a delivery from authkit-server is re-emitted exactly like the in-process event', async ({
    assert,
  }) => {
    // What authkit-server emits in-process for this event.
    const inProcess = await captureBus(async () => {
      await composeAuditSink(undefined, {}).record(event as any);
    });

    const body = buildWebhookBody(event as any);
    const seen: unknown[] = [];
    const handler = authkitWebhookHandler({ secret: SECRET, onEvent: (e) => void seen.push(e) });
    const { ctx, reply } = fakeCtx(body, signWebhookBody(body, SECRET));
    const remote = await captureBus(async () => {
      await handler(ctx);
    });

    assert.equal(reply.status, 204);
    assert.deepEqual(remote, inProcess);
    assert.deepEqual(remote[0], {
      lib: 'authkit',
      event: 'organization.created',
      payload: {
        type: 'organization.created',
        accountId: 'acc-1',
        actorId: 'admin-1',
        clientId: null,
        orgId: 'org-1',
      },
    });
    assert.deepInclude(seen[0] as object, { email: 'owner@acme.test', metadata: { name: 'Acme' } });
  });

  test('a replayed id is accepted once and emitted once', async ({ assert }) => {
    const body = buildWebhookBody(event as any);
    const signature = signWebhookBody(body, SECRET);
    const handler = authkitWebhookHandler({ secret: SECRET });
    const emitted = await captureBus(async () => {
      const first = fakeCtx(body, signature);
      await handler(first.ctx);
      const second = fakeCtx(body, signature);
      await handler(second.ctx);
      assert.equal(first.reply.status, 204);
      assert.equal(second.reply.status, 204);
    });
    assert.lengthOf(emitted, 1);
  });

  test('refuses a bad signature, a tampered body, an old delivery and a missing body', async ({
    assert,
  }) => {
    const handler = authkitWebhookHandler({ secret: SECRET });
    const body = buildWebhookBody(event as any);
    const emitted = await captureBus(async () => {
      const wrong = fakeCtx(body, signWebhookBody(body, 'other-secret'));
      await handler(wrong.ctx);
      assert.equal(wrong.reply.status, 401);

      const tampered = fakeCtx(body.replace('org-1', 'org-2'), signWebhookBody(body, SECRET));
      await handler(tampered.ctx);
      assert.equal(tampered.reply.status, 401);

      const unsigned = fakeCtx(body);
      await handler(unsigned.ctx);
      assert.equal(unsigned.reply.status, 401);

      const old = JSON.stringify({
        ...JSON.parse(body),
        id: 'old-1',
        ts: new Date(Date.now() - 10 * 60_000).toISOString(),
      });
      const expired = fakeCtx(old, signWebhookBody(old, SECRET));
      await handler(expired.ctx);
      assert.equal(expired.reply.status, 400);
      assert.deepEqual(expired.reply.body, { error: 'expired' });

      const empty = fakeCtx(null);
      await handler(empty.ctx);
      assert.equal(empty.reply.status, 400);
    });
    assert.lengthOf(emitted, 0);
  });

  test('a delivery without an id is malformed', async ({ assert }) => {
    const body = JSON.stringify({ type: 'login.success', ts: new Date().toISOString() });
    const verdict = await verifyAuthkitWebhook(
      { body, signature: signWebhookBody(body, SECRET) },
      { secret: SECRET, replayStore: memoryReplayStore() },
    );
    assert.deepEqual(verdict, { ok: false, reason: 'malformed' });
  });

  test('memoryReplayStore forgets an id after its ttl', async ({ assert }) => {
    const store = memoryReplayStore();
    assert.isTrue(await store.claim('a', 20));
    assert.isFalse(await store.claim('a', 20));
    await new Promise((r) => setTimeout(r, 30));
    assert.isTrue(await store.claim('a', 20));
  });

  test('a failing onEvent does not suppress the bus emit', async ({ assert }) => {
    const body = buildWebhookBody(event as any);
    const handler = authkitWebhookHandler({
      secret: SECRET,
      onEvent: () => {
        throw new Error('listener bug');
      },
    });
    const { ctx, reply } = fakeCtx(body, signWebhookBody(body, SECRET));
    const emitted = await captureBus(async () => {
      await handler(ctx);
    });
    assert.equal(reply.status, 204);
    assert.lengthOf(emitted, 1);
  });

  test('requires a secret, an issuer or keys', ({ assert }) => {
    assert.throws(() => authkitWebhookHandler({ secret: '' }), /issuer/);
    assert.doesNotThrow(() => authkitWebhookHandler({ issuer: 'https://id.example.com/oidc' }));
    assert.doesNotThrow(() => authkitWebhookHandler({ jwks: { keys: [] } }));
  });
});

const APP_KEY = 'app-key-of-the-test-app-32-chars';

test.group('authkit webhook receiver — Ed25519 (no shared secret)', () => {
  const [signingKey] = resolveWebhookSigningKeys(undefined, APP_KEY);
  const publicJwks = { keys: [{ ...signingKey!, d: undefined }] };

  /** A discovery document server stand-in that counts its fetches. */
  function discovery(keys: () => unknown) {
    const calls: string[] = [];
    const fetchStub = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ issuer: 'x', authkit_webhook_jwks: keys() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { calls, fetch: fetchStub };
  }

  test('a delivery signed by authkit-server opens with the discovery keys', async ({ assert }) => {
    const d = discovery(() => publicJwks);
    const handler = authkitWebhookHandler({
      issuer: 'https://id.example.com/oidc/',
      fetch: d.fetch,
    });
    const body = buildWebhookBody(event as any);
    const { ctx, reply } = fakeCtx(body, undefined, signWebhookBodyEd25519(body, signingKey!));
    const emitted = await captureBus(async () => {
      await handler(ctx);
    });
    assert.equal(reply.status, 204);
    assert.lengthOf(emitted, 1);
    assert.deepEqual(d.calls, ['https://id.example.com/oidc/.well-known/openid-configuration']);
  });

  test('refuses a tampered body, another key, a missing signature', async ({ assert }) => {
    const handler = authkitWebhookHandler({ jwks: publicJwks });
    const body = buildWebhookBody(event as any);
    const signature = signWebhookBodyEd25519(body, signingKey!);
    const tampered = fakeCtx(body.replace('acc-1', 'acc-2'), undefined, signature);
    await handler(tampered.ctx);
    assert.equal(tampered.reply.status, 401);
    const stranger = resolveWebhookSigningKeys(undefined, 'another-app-key-of-32-characters')[0]!;
    const other = fakeCtx(body, undefined, signWebhookBodyEd25519(body, stranger));
    await handler(other.ctx);
    assert.equal(other.reply.status, 401);
    const none = fakeCtx(body);
    await handler(none.ctx);
    assert.equal(none.reply.status, 401);
  });

  test('a rotated key (unknown kid) refetches the discovery once, then waits', async ({
    assert,
  }) => {
    let published: unknown = publicJwks;
    const d = discovery(() => published);
    const keys = webhookKeys({ issuer: 'https://id.example.com', fetch: d.fetch })!;
    const verifyWith = (body: string, sig: string) =>
      verifyAuthkitWebhook(
        { body, signatureEd25519: sig },
        { keys, replayStore: memoryReplayStore() },
      );
    const first = buildWebhookBody(event as any);
    assert.isTrue((await verifyWith(first, signWebhookBodyEd25519(first, signingKey!))).ok);
    assert.lengthOf(d.calls, 1);

    // authkit rotated to a new key: the receiver fetches the discovery again and accepts.
    const rotated = resolveWebhookSigningKeys(undefined, 'rotated-app-key-of-32-characters!')[0]!;
    published = { keys: [{ ...rotated, d: undefined }] };
    const second = buildWebhookBody(event as any);
    // Within the 30 s cooldown the cache is reused: still refused, no extra fetch.
    assert.isFalse((await verifyWith(second, signWebhookBodyEd25519(second, rotated))).ok);
    assert.lengthOf(d.calls, 1);

    // Past the cooldown, an unknown kid fetches the discovery again and the delivery opens.
    const eager = webhookKeys({
      issuer: 'https://id.example.com',
      fetch: d.fetch,
      refreshCooldownMs: 0,
    })!;
    published = publicJwks;
    const third = buildWebhookBody(event as any);
    assert.isTrue(
      (
        await verifyAuthkitWebhook(
          { body: third, signatureEd25519: signWebhookBodyEd25519(third, signingKey!) },
          { keys: eager, replayStore: memoryReplayStore() },
        )
      ).ok,
    );
    published = { keys: [{ ...rotated, d: undefined }] };
    const fourth = buildWebhookBody(event as any);
    const before = d.calls.length;
    assert.isTrue(
      (
        await verifyAuthkitWebhook(
          { body: fourth, signatureEd25519: signWebhookBodyEd25519(fourth, rotated) },
          { keys: eager, replayStore: memoryReplayStore() },
        )
      ).ok,
    );
    assert.equal(d.calls.length, before + 1);
  });

  test('with a secret too, either signature is enough (HMAC alone still works)', async ({
    assert,
  }) => {
    const handler = authkitWebhookHandler({ jwks: publicJwks, secret: SECRET });
    const body = buildWebhookBody(event as any);
    const hmacOnly = fakeCtx(body, signWebhookBody(body, SECRET));
    await handler(hmacOnly.ctx);
    assert.equal(hmacOnly.reply.status, 204);
    const second = buildWebhookBody(event as any);
    const both = fakeCtx(second, 'sha256=bad', signWebhookBodyEd25519(second, signingKey!));
    await handler(both.ctx);
    assert.equal(both.reply.status, 204);
  });
});
