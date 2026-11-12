import { test } from '@japa/runner';
import { AGORA_DEV_SCOPE, resolvePoppyConfig } from '../src/config.js';
import { ACCOUNT_ID, CLIENT_ID, pkce, REDIRECT_URI, setupPoppy } from './poppy_helpers.js';

const BASE = {
  organization: { name: 'Shop', domain: 'shop.example' },
  scopes: { 'orders:read': 'See your orders' },
};

/** A hub bound at `'agora.devTools'`, as `@adonis-agora/agent` binds it. */
const withHub = async (binding: string) => {
  if (binding === 'agora.devTools') return { version: 1, register() {} };
  throw new Error(`no binding ${binding}`);
};

async function consent(env: Awaited<ReturnType<typeof setupPoppy>>, scope: string) {
  const { challenge } = pkce();
  return env.poppy.startAuthorization(
    {
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    },
    ACCOUNT_ID,
  );
}

test.group('Poppy — agora:dev scope (config)', () => {
  test('devTools: true offers it to Direct and Device sign-in, with hints', ({ assert }) => {
    const cfg = resolvePoppyConfig({ ...BASE, devTools: true }, undefined)!;
    assert.property(cfg.scopes, AGORA_DEV_SCOPE);
    assert.include(cfg.signIn.direct!.scopes, AGORA_DEV_SCOPE);
    assert.include(cfg.signIn.device!.scopes, AGORA_DEV_SCOPE);
    assert.deepEqual(cfg.scopeHints[AGORA_DEV_SCOPE], {
      changes: 'irreversible',
      personal_data: true,
    });
  });

  test('a sign-in type with an explicit scope list keeps its list', ({ assert }) => {
    const cfg = resolvePoppyConfig(
      { ...BASE, devTools: true, signIn: { direct: { scopes: ['orders:read'] } } },
      undefined,
    )!;
    assert.notInclude(cfg.signIn.direct!.scopes, AGORA_DEV_SCOPE);
    assert.include(cfg.signIn.device!.scopes, AGORA_DEV_SCOPE);
  });

  test('not offered by default or with devTools: false', ({ assert }) => {
    assert.notProperty(resolvePoppyConfig(BASE, undefined)!.scopes, AGORA_DEV_SCOPE);
    assert.notProperty(
      resolvePoppyConfig({ ...BASE, devTools: false }, undefined)!.scopes,
      AGORA_DEV_SCOPE,
    );
  });

  test('Mediated Sign-In can never grant it', ({ assert }) => {
    assert.throws(
      () =>
        resolvePoppyConfig(
          {
            ...BASE,
            scopes: { ...BASE.scopes, [AGORA_DEV_SCOPE]: 'Dev tools' },
            signIn: {
              mediated: {
                fields: [{ name: 'email', label: 'Email', secret: false }],
                verify: async () => null,
                scopes: [AGORA_DEV_SCOPE],
              },
            },
          } as any,
          undefined,
        ),
      /Mediated Sign-In cannot grant it/,
    );
  });
});

test.group('Poppy — agora:dev scope (consent)', () => {
  test('without dev tools in the app, asking for it is invalid_scope', async ({ assert }) => {
    const env = await setupPoppy();
    const start = await consent(env, `orders:read ${AGORA_DEV_SCOPE}`);
    assert.equal(start.kind, 'redirect');
    if (start.kind === 'redirect') assert.match(start.url, /error=invalid_scope/);
    await env.close();
  });

  test('offered when the app serves dev tools; unticked and translated on the consent screen', async ({
    assert,
  }) => {
    const env = await setupPoppy({}, { make: withHub });
    const start = await consent(env, `orders:read ${AGORA_DEV_SCOPE}`);
    if (start.kind !== 'consent') throw new Error(`unexpected ${start.kind}`);
    const dev = start.request.scopes.find((s) => s.id === AGORA_DEV_SCOPE)!;
    assert.isTrue(dev.optIn);
    assert.equal(dev.descriptionKey, 'poppy.scope.agora_dev');
    const orders = start.request.scopes.find((s) => s.id === 'orders:read')!;
    assert.notProperty(orders, 'optIn');
    await env.close();
  });

  test('granted only when the person ticks it', async ({ assert }) => {
    const env = await setupPoppy({}, { make: withHub });
    const first = await consent(env, `orders:read ${AGORA_DEV_SCOPE}`);
    if (first.kind !== 'consent') throw new Error('consent');
    // The form posts only what is ticked: the default leaves agora:dev out.
    const untouched = await env.poppy.decideAuthorization({
      requestId: first.request.id,
      accountId: ACCOUNT_ID,
      allow: true,
      scopes: ['orders:read'],
    });
    assert.deepEqual(untouched!.approved, ['orders:read']);

    const second = await consent(env, `orders:read ${AGORA_DEV_SCOPE}`);
    if (second.kind !== 'consent') throw new Error('consent');
    const ticked = await env.poppy.decideAuthorization({
      requestId: second.request.id,
      accountId: ACCOUNT_ID,
      allow: true,
      scopes: ['orders:read', AGORA_DEV_SCOPE],
    });
    assert.deepEqual(ticked!.approved, ['orders:read', AGORA_DEV_SCOPE]);
    await env.close();
  });

  test('devTools: false never offers it, even with dev tools in the app', async ({ assert }) => {
    const env = await setupPoppy({ devTools: false }, { make: withHub });
    const start = await consent(env, `orders:read ${AGORA_DEV_SCOPE}`);
    assert.equal(start.kind, 'redirect');
    await env.close();
  });

  test('an app-written description is kept as is', async ({ assert }) => {
    const env = await setupPoppy(
      {
        scopes: { 'orders:read': 'See your orders', [AGORA_DEV_SCOPE]: 'Ferramentas de dev' },
        devTools: true,
      },
      {},
    );
    const start = await consent(env, AGORA_DEV_SCOPE);
    if (start.kind !== 'consent') throw new Error('consent');
    assert.equal(start.request.scopes[0]!.description, 'Ferramentas de dev');
    assert.notProperty(start.request.scopes[0]!, 'descriptionKey');
    assert.isTrue(start.request.scopes[0]!.optIn);
    await env.close();
  });
});
