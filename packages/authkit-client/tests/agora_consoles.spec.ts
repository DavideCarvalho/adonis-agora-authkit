import { test } from '@japa/runner';
import { AGORA_CONSOLES_BINDING, announceAgoraSignOut } from '../src/agora_consoles.js';
import { registerOidcClient } from '../src/register_oidc_client.js';

/** A container with just `hasBinding` / `bindValue` / `make`. */
function fakeApp(bindings: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(bindings));
  return {
    values,
    container: {
      hasBinding: (key: string) => values.has(key),
      bindValue: (key: string, value: unknown) => void values.set(key, value),
      make: async (key: string) => values.get(key),
    },
  };
}

/** A router that records nothing: registerOidcClient only needs the route builders. */
function fakeRouter() {
  const route = { as: () => route, use: () => route };
  return { get: () => route, post: () => route } as any;
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test.group('account.signOut on the agora.consoles registry', () => {
  test('creates the registry and announces a POST action', async ({ assert }) => {
    const app = fakeApp();
    assert.isTrue(await announceAgoraSignOut(app, '/auth/logout'));
    assert.deepEqual(app.values.get(AGORA_CONSOLES_BINDING), {
      version: 1,
      entries: [],
      account: { signOut: { action: '/auth/logout', method: 'POST' } },
    });
  });

  test('keeps a sign-out announced first and leaves other registries alone', async ({ assert }) => {
    const first = { version: 1, entries: [], account: { signOut: { href: '/bye' } } };
    assert.isFalse(await announceAgoraSignOut(fakeApp({ [AGORA_CONSOLES_BINDING]: first }), '/x'));
    assert.deepEqual(first.account, { signOut: { href: '/bye' } });

    const v2 = { version: 2, entries: [] };
    assert.isFalse(await announceAgoraSignOut(fakeApp({ [AGORA_CONSOLES_BINDING]: v2 }), '/x'));
    assert.notProperty(v2, 'account');
  });

  test('refuses a sign-out that is not a same-origin path', async ({ assert }) => {
    await assert.rejects(() => announceAgoraSignOut(fakeApp(), 'https://evil.example/logout'));
    await assert.rejects(() => announceAgoraSignOut(fakeApp(), '//evil.example/logout'));
    await assert.rejects(() => announceAgoraSignOut(fakeApp(), '/auth/logout\n'));
  });

  test('registerOidcClient announces its logout route', async ({ assert }) => {
    const app = fakeApp();
    registerOidcClient(fakeRouter(), { prefix: '/sso', app });
    await settle();
    const registry = app.values.get(AGORA_CONSOLES_BINDING) as any;
    assert.deepEqual(registry.account.signOut, { action: '/sso/logout', method: 'POST' });
  });

  test('registerOidcClient leaves the announcement to authkit-server in the same app', async ({
    assert,
  }) => {
    const app = fakeApp({ 'authkit.server': {} });
    registerOidcClient(fakeRouter(), { app });
    await settle();
    assert.isFalse(app.values.has(AGORA_CONSOLES_BINDING));
  });

  test('announceSignOut: false opts out', async ({ assert }) => {
    const app = fakeApp();
    registerOidcClient(fakeRouter(), { app, announceSignOut: false });
    await settle();
    assert.isFalse(app.values.has(AGORA_CONSOLES_BINDING));
  });
});
