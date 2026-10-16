import { test } from '@japa/runner';
import { AuthkitClientManager } from '../providers/authkit_client_provider.js';
import type { ResolvedClientConfig } from '../src/define_config.js';
import { refreshTokens } from '../src/oidc_login.js';
import { signIdToken, testKeys } from './helpers/id_tokens.js';

const NEW_ID_TOKEN = await signIdToken({ sub: 'u1' });

function fakeConfig(over: Partial<ResolvedClientConfig> = {}): ResolvedClientConfig {
  return {
    issuer: 'http://idp',
    clientId: 'app1',
    clientSecret: 's',
    redirectUri: 'http://app/cb',
    resolverFactory: { resolver: async () => ({ resolve: async () => null }) },
    sessionKey: 'authkit',
    scopes: ['openid'],
    globalRolesClaim: 'roles',
    discovery: false,
    ...over,
  };
}

/** Sessão fake (Map) com get/put. */
function fakeCtxWithSession(initial?: any) {
  const store = new Map<string, any>();
  if (initial) store.set('authkit', initial);
  return {
    session: { get: (k: string) => store.get(k), put: (k: string, v: any) => store.set(k, v) },
    _store: store,
  } as any;
}

/** Sessão fake COM sessionId — necessário pra testar o dedup de `maybeRefresh`. */
function fakeCtxWithSessionId(initial?: any, sid = 'sess_1') {
  const store = new Map<string, any>();
  if (initial) store.set('authkit', initial);
  return {
    session: {
      get sessionId() {
        return sid;
      },
      get: (k: string) => store.get(k),
      put: (k: string, v: any) => store.set(k, v),
    },
    _store: store,
  } as any;
}

test.group('refreshTokens (primitive)', () => {
  test('POST grant_type=refresh_token e mapeia a resposta', async ({ assert }) => {
    let captured = '';
    const ts = await refreshTokens({
      issuer: 'http://idp',
      clientId: 'app1',
      clientSecret: 's',
      refreshToken: 'rt_old',
      fetchImpl: (async (_url: string, init: any) => {
        captured = init.body;
        return {
          ok: true,
          json: async () => ({
            id_token: 'idt_new',
            access_token: 'at_new',
            refresh_token: 'rt_new',
            expires_in: 3600,
          }),
        };
      }) as any,
    });
    assert.include(captured, 'grant_type=refresh_token');
    assert.include(captured, 'refresh_token=rt_old');
    assert.equal(ts.accessToken, 'at_new');
    assert.equal(ts.refreshToken, 'rt_new');
    assert.equal(ts.idToken, 'idt_new');
    assert.isNumber(ts.expiresAt);
  });

  test('resposta não-ok lança', async ({ assert }) => {
    await assert.rejects(() =>
      refreshTokens({
        issuer: 'http://idp',
        clientId: 'app1',
        refreshToken: 'rt',
        fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as any,
      }),
    );
  });
});

test.group('AuthkitClientManager.maybeRefresh', () => {
  test('sem refresh token → no-op (não chama fetch)', async ({ assert }) => {
    let called = false;
    const m = new AuthkitClientManager(fakeConfig(), { keys: testKeys });
    const ctx = fakeCtxWithSession({ idToken: 'i', accessToken: 'a', expiresAt: 0 });
    await m.maybeRefresh(ctx, {
      now: () => 1_000_000,
      fetchImpl: (async () => ((called = true), { ok: true, json: async () => ({}) })) as any,
    });
    assert.isFalse(called);
  });

  test('token ainda fresco → no-op', async ({ assert }) => {
    let called = false;
    const m = new AuthkitClientManager(fakeConfig(), { keys: testKeys });
    const now = 1_000_000;
    const ctx = fakeCtxWithSession({
      idToken: 'i',
      accessToken: 'a',
      refreshToken: 'rt',
      expiresAt: now + 10 * 60_000, // 10 min no futuro
    });
    await m.maybeRefresh(ctx, {
      now: () => now,
      fetchImpl: (async () => ((called = true), { ok: true, json: async () => ({}) })) as any,
    });
    assert.isFalse(called);
  });

  test('perto de expirar → renova e ROTACIONA o refresh token na sessão', async ({ assert }) => {
    const m = new AuthkitClientManager(fakeConfig(), { keys: testKeys });
    const now = 1_000_000;
    const ctx = fakeCtxWithSession({
      idToken: 'idt_old',
      accessToken: 'at_old',
      refreshToken: 'rt_old',
      expiresAt: now + 10_000, // dentro da margem de 60s
    });
    await m.maybeRefresh(ctx, {
      now: () => now,
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({
          id_token: NEW_ID_TOKEN,
          access_token: 'at_new',
          refresh_token: 'rt_new',
          expires_in: 3600,
        }),
      })) as any,
    });
    const stored = ctx._store.get('authkit');
    assert.equal(stored.accessToken, 'at_new');
    assert.equal(stored.refreshToken, 'rt_new');
    assert.equal(stored.idToken, NEW_ID_TOKEN);
  });

  test('preserva id_token e refresh_token anteriores quando o IdP não os reemite', async ({
    assert,
  }) => {
    const m = new AuthkitClientManager(fakeConfig(), { keys: testKeys });
    const now = 1_000_000;
    const ctx = fakeCtxWithSession({
      idToken: 'idt_old',
      accessToken: 'at_old',
      refreshToken: 'rt_old',
      expiresAt: now,
    });
    await m.maybeRefresh(ctx, {
      now: () => now,
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ access_token: 'at_new', expires_in: 3600 }),
      })) as any,
    });
    const stored = ctx._store.get('authkit');
    assert.equal(stored.accessToken, 'at_new');
    assert.equal(stored.idToken, 'idt_old'); // preservado
    assert.equal(stored.refreshToken, 'rt_old'); // preservado (sem rotação)
  });

  test('falha na renovação é silenciosa e mantém o TokenSet', async ({ assert }) => {
    const m = new AuthkitClientManager(fakeConfig(), { keys: testKeys });
    const now = 1_000_000;
    const original = { idToken: 'i', accessToken: 'a', refreshToken: 'rt', expiresAt: now };
    const ctx = fakeCtxWithSession({ ...original });
    await m.maybeRefresh(ctx, {
      now: () => now,
      fetchImpl: (async () => ({ ok: false, json: async () => ({}) })) as any,
    });
    assert.deepEqual(ctx._store.get('authkit'), original);
  });
});

test.group('AuthkitClientManager.maybeRefresh — dedup', () => {
  test('duas chamadas concorrentes pra mesma sessão → só 1 refresh de verdade', async ({
    assert,
  }) => {
    const m = new AuthkitClientManager(fakeConfig(), { keys: testKeys });
    const now = 1_000_000;
    let callCount = 0;

    const fetchImpl = (async () => {
      callCount++;
      // Delay pra garantir concorrência real
      await new Promise((r) => setTimeout(r, 50));
      return {
        ok: true,
        json: async () => ({
          id_token: NEW_ID_TOKEN,
          access_token: 'at_new',
          refresh_token: 'rt_new',
          expires_in: 3600,
        }),
      };
    }) as any;

    const ctx = fakeCtxWithSessionId(
      { idToken: 'i', accessToken: 'a', refreshToken: 'rt', expiresAt: now },
      'sess_abc',
    );

    // Dispara duas em paralelo
    await Promise.all([
      m.maybeRefresh(ctx, { now: () => now, fetchImpl }),
      m.maybeRefresh(ctx, { now: () => now, fetchImpl }),
    ]);

    assert.equal(callCount, 1, 'refreshTokens deve ser chamado só 1 vez');
    const stored = ctx._store.get('authkit');
    assert.equal(stored.accessToken, 'at_new');
  });

  test('sessões diferentes → N refreshes independentes', async ({ assert }) => {
    const m = new AuthkitClientManager(fakeConfig(), { keys: testKeys });
    const now = 1_000_000;
    let callCount = 0;

    const fetchImpl = (async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 30));
      return {
        ok: true,
        json: async () => ({
          access_token: `at_new_${callCount}`,
          refresh_token: 'rt_new',
          expires_in: 3600,
        }),
      };
    }) as any;

    const ctx1 = fakeCtxWithSessionId(
      { idToken: 'i', accessToken: 'a1', refreshToken: 'rt1', expiresAt: now },
      'sess_a',
    );
    const ctx2 = fakeCtxWithSessionId(
      { idToken: 'i', accessToken: 'a2', refreshToken: 'rt2', expiresAt: now },
      'sess_b',
    );

    await Promise.all([
      m.maybeRefresh(ctx1, { now: () => now, fetchImpl }),
      m.maybeRefresh(ctx2, { now: () => now, fetchImpl }),
    ]);

    assert.equal(callCount, 2, 'cada sessão faz seu próprio refresh');
  });

  test('sem sessionId no ctx → fallback: faz refresh normal sem dedup', async ({ assert }) => {
    const m = new AuthkitClientManager(fakeConfig(), { keys: testKeys });
    const now = 1_000_000;
    let callCount = 0;

    // Sessão SEM sessionId (igual aos outros testes)
    const store = new Map<string, any>();
    store.set('authkit', { idToken: 'i', accessToken: 'a', refreshToken: 'rt', expiresAt: now });
    const ctx = {
      session: {
        get: (k: string) => store.get(k),
        put: (k: string, v: any) => store.set(k, v),
      },
      _store: store,
    } as any;

    const fetchImpl = (async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 20));
      return {
        ok: true,
        json: async () => ({
          access_token: 'at_new',
          refresh_token: 'rt_new',
          expires_in: 3600,
        }),
      };
    }) as any;

    await Promise.all([
      m.maybeRefresh(ctx, { now: () => now, fetchImpl }),
      m.maybeRefresh(ctx, { now: () => now, fetchImpl }),
    ]);

    assert.equal(callCount, 2, 'sem sessionId, ambas as chamadas batem no IdP');
  });
});

test.group('AuthkitClientManager.maybeRefresh — dedup entre requests', () => {
  /** Um "tick" de rede: resolve depois de um setTimeout. */
  const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

  test('requests concorrentes da mesma sessão → 1 refresh e TODAS as sessões ficam com o token novo', async ({
    assert,
  }) => {
    const m = new AuthkitClientManager(fakeConfig(), { keys: testKeys });
    const now = 1_000_000;
    let callCount = 0;
    const fetchImpl = (async () => {
      callCount++;
      await tick();
      return {
        ok: true,
        json: async () => ({
          id_token: NEW_ID_TOKEN,
          access_token: 'at_new',
          refresh_token: 'rt_new',
          expires_in: 3600,
        }),
      };
    }) as any;

    // Dois requests HTTP = dois objetos de sessão distintos, carregados do mesmo store.
    const original = {
      idToken: 'idt_old',
      accessToken: 'at_old',
      refreshToken: 'rt_old',
      expiresAt: now + 10_000,
      impersonationBinding: 'bind_1',
    };
    const ctxA = fakeCtxWithSessionId({ ...original }, 'sess_shared');
    const ctxB = fakeCtxWithSessionId({ ...original }, 'sess_shared');

    await Promise.all([
      m.maybeRefresh(ctxA, { now: () => now, fetchImpl }),
      m.maybeRefresh(ctxB, { now: () => now, fetchImpl }),
    ]);

    assert.equal(callCount, 1, 'refreshTokens deve ser chamado só 1 vez');
    for (const ctx of [ctxA, ctxB]) {
      const stored = ctx._store.get('authkit');
      assert.equal(stored.accessToken, 'at_new');
      assert.equal(stored.refreshToken, 'rt_new'); // rotacionado nas DUAS sessões
      assert.equal(stored.idToken, NEW_ID_TOKEN);
      assert.equal(stored.impersonationBinding, 'bind_1');
    }
  });

  test('refresh que falha deixa as duas sessões intactas e libera o in-flight', async ({
    assert,
  }) => {
    const m = new AuthkitClientManager(fakeConfig(), { keys: testKeys });
    const now = 1_000_000;
    let callCount = 0;
    const failing = (async () => {
      callCount++;
      await tick();
      return { ok: false, json: async () => ({}) };
    }) as any;

    const original = {
      idToken: 'i',
      accessToken: 'at_old',
      refreshToken: 'rt_old',
      expiresAt: now,
    };
    const ctxA = fakeCtxWithSessionId({ ...original }, 'sess_fail');
    const ctxB = fakeCtxWithSessionId({ ...original }, 'sess_fail');

    await Promise.all([
      m.maybeRefresh(ctxA, { now: () => now, fetchImpl: failing }),
      m.maybeRefresh(ctxB, { now: () => now, fetchImpl: failing }),
    ]);

    assert.equal(callCount, 1);
    assert.deepEqual(ctxA._store.get('authkit'), original);
    assert.deepEqual(ctxB._store.get('authkit'), original);

    // A entrada in-flight foi removida: uma chamada posterior tenta de novo.
    const ok = (async () => {
      callCount++;
      await tick();
      return {
        ok: true,
        json: async () => ({ access_token: 'at_new', refresh_token: 'rt_new', expires_in: 3600 }),
      };
    }) as any;
    await m.maybeRefresh(ctxA, { now: () => now, fetchImpl: ok });
    assert.equal(callCount, 2);
    assert.equal(ctxA._store.get('authkit').accessToken, 'at_new');
    assert.equal(ctxA._store.get('authkit').refreshToken, 'rt_new');
  });
});
