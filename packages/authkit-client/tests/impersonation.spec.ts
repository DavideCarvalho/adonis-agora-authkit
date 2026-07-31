import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import { AuthkitClientManager } from '../providers/authkit_client_provider.js';
import { type ResolvedClientConfig, defineConfig, resolvers } from '../src/define_config.js';
import type { TokenSet } from '../src/types.js';

const ISSUER = 'http://idp.test';
const IMPERSONATOR_KEY = 'authkit_impersonator';

/** Sessão de mentira com a mesma superfície que o manager usa (get/put/forget). */
function fakeSession() {
  const store = new Map<string, unknown>();
  return {
    store,
    get(key: string) {
      return store.get(key);
    },
    put(key: string, value: unknown) {
      store.set(key, value);
    },
    forget(key: string) {
      store.delete(key);
    },
  };
}

function ctxWith(session: ReturnType<typeof fakeSession>) {
  return { session } as any;
}

async function makeManager(): Promise<AuthkitClientManager> {
  const resolved = await configProvider.resolve<ResolvedClientConfig>(
    {} as any,
    defineConfig({
      issuer: ISSUER,
      clientId: 'app1',
      clientSecret: 's',
      redirectUri: `${ISSUER}/cb`,
      resolver: resolvers.jwt({ tokenSource: 'session' }),
    }),
  );
  return new AuthkitClientManager(resolved!);
}

/** Stub do token endpoint: token-exchange e refresh devolvem tokens do ALVO. */
function stubTokenEndpoint(payload: Record<string, unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  })) as any;
  return () => {
    globalThis.fetch = original;
  };
}

const ADMIN: TokenSet = {
  idToken: 'admin-id',
  accessToken: 'admin-at',
  refreshToken: 'admin-rt',
};

test.group('impersonation | atribuição do restore', () => {
  test('NÃO devolve o TokenSet do ator para uma sessão que virou de outra identidade', async ({
    assert,
  }) => {
    const restore = stubTokenEndpoint({
      id_token: 'target-id',
      access_token: 'target-at',
      expires_in: 3600,
    });
    try {
      const manager = await makeManager();
      const session = fakeSession();
      const ctx = ctxWith(session);

      // 1) admin logado, impersona o alvo — o TokenSet do admin fica parqueado.
      session.put('authkit', ADMIN);
      await manager.impersonate(ctx, 'target-1');
      assert.isDefined(session.get(IMPERSONATOR_KEY), 'a credencial do ator foi parqueada');

      // 2) logout como um consumidor faz (é o que a rota /auth/logout da lib fazia).
      session.forget('authkit');

      // 3) OUTRA identidade loga no mesmo cookie jar.
      session.put('authkit', {
        idToken: 'mallory-id',
        accessToken: 'mallory-at',
      } satisfies TokenSet);

      // 4) essa identidade chama o endpoint de stop.
      const ok = await manager.stopImpersonating(ctx);

      assert.isFalse(ok, 'o restore precisa ser recusado');
      const live = session.get('authkit') as TokenSet | undefined;
      assert.notEqual(
        live?.accessToken,
        ADMIN.accessToken,
        'não pode receber o access token do ator',
      );
      assert.notEqual(
        live?.refreshToken,
        ADMIN.refreshToken,
        'não pode receber o refresh token do ator',
      );
      assert.isUndefined(
        session.get(IMPERSONATOR_KEY),
        'a credencial recusada é DESCARTADA, não fica para uma nova tentativa',
      );
    } finally {
      restore();
    }
  });

  test('um stop legítimo durante impersonação ativa continua restaurando o ator', async ({
    assert,
  }) => {
    const restore = stubTokenEndpoint({
      id_token: 'target-id',
      access_token: 'target-at',
      expires_in: 3600,
    });
    try {
      const manager = await makeManager();
      const session = fakeSession();
      const ctx = ctxWith(session);

      session.put('authkit', ADMIN);
      await manager.impersonate(ctx, 'target-1');
      assert.isTrue(manager.isImpersonating(ctx));

      const ok = await manager.stopImpersonating(ctx);

      assert.isTrue(ok, 'o ator legítimo tem que sair da impersonação');
      const live = session.get('authkit') as TokenSet;
      assert.equal(live.accessToken, ADMIN.accessToken);
      assert.equal(live.refreshToken, ADMIN.refreshToken);
      assert.isUndefined(session.get(IMPERSONATOR_KEY));
      assert.isFalse(manager.isImpersonating(ctx));
    } finally {
      restore();
    }
  });

  test('o vínculo sobrevive ao maybeRefresh proativo do middleware', async ({ assert }) => {
    const restore = stubTokenEndpoint({
      id_token: 'target-id-2',
      access_token: 'target-at-2',
      refresh_token: 'target-rt-2',
      expires_in: 3600,
    });
    try {
      const manager = await makeManager();
      const session = fakeSession();
      const ctx = ctxWith(session);

      session.put('authkit', ADMIN);
      await manager.impersonate(ctx, 'target-1');

      // O token do alvo está a expirar → o authkit_middleware renova a cada request.
      const current = session.get('authkit') as TokenSet;
      session.put('authkit', { ...current, refreshToken: 'target-rt', expiresAt: Date.now() });
      await manager.maybeRefresh(ctx);
      assert.equal((session.get('authkit') as TokenSet).accessToken, 'target-at-2');

      const ok = await manager.stopImpersonating(ctx);
      assert.isTrue(ok, 'renovar o token do alvo não pode trancar o ator na impersonação');
      assert.equal((session.get('authkit') as TokenSet).accessToken, ADMIN.accessToken);
    } finally {
      restore();
    }
  });

  test('credencial parqueada por uma versão antiga (sem vínculo) é recusada e descartada', async ({
    assert,
  }) => {
    const manager = await makeManager();
    const session = fakeSession();
    const ctx = ctxWith(session);

    // Formato pré-0.15: o TokenSet do ator cru, sem vínculo nenhum.
    session.put(IMPERSONATOR_KEY, ADMIN);
    session.put('authkit', { idToken: 'target-id', accessToken: 'target-at' } satisfies TokenSet);

    const ok = await manager.stopImpersonating(ctx);

    assert.isFalse(ok);
    assert.isUndefined(session.get(IMPERSONATOR_KEY));
    assert.isUndefined(
      session.get('authkit'),
      'fail-closed: não restaura e não deixa impersonando',
    );
  });
});

test.group('impersonation | caminhos que encerram a sessão', () => {
  test('endSession limpa o token set E a credencial parqueada', async ({ assert }) => {
    const restore = stubTokenEndpoint({
      id_token: 'target-id',
      access_token: 'target-at',
      expires_in: 3600,
    });
    try {
      const manager = await makeManager();
      const session = fakeSession();
      const ctx = ctxWith(session);

      session.put('authkit', ADMIN);
      await manager.impersonate(ctx, 'target-1');

      manager.endSession(ctx);

      assert.isUndefined(session.get('authkit'));
      assert.isUndefined(
        session.get(IMPERSONATOR_KEY),
        'a revogação não pode deixar o refresh token do ator parqueado',
      );
    } finally {
      restore();
    }
  });

  test('o middleware de revogação back-channel não deixa a credencial do ator parqueada', async ({
    assert,
  }) => {
    const restore = stubTokenEndpoint({
      id_token: 'target-id',
      access_token: 'target-at',
      expires_in: 3600,
    });
    try {
      const { default: BackchannelRevocationMiddleware } = await import(
        '../src/middleware/backchannel_revocation_middleware.js'
      );
      const resolved = await configProvider.resolve<ResolvedClientConfig>(
        {} as any,
        defineConfig({
          issuer: ISSUER,
          clientId: 'app1',
          clientSecret: 's',
          redirectUri: `${ISSUER}/cb`,
          resolver: resolvers.jwt({ tokenSource: 'session' }),
          backchannelLogout: {
            store: {
              isRevoked: async () => true,
              revoke: async () => {},
              prune: async () => {},
            },
          },
        }),
      );
      const manager = new AuthkitClientManager(resolved!);
      const session = fakeSession();

      // id_token decodificável com sid — o middleware precisa dele para consultar o store.
      const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sid: 's1', sub: 'admin', iat: 1 })).toString(
        'base64url',
      );
      const idToken = `${header}.${payload}.x`;

      const ctx = {
        session,
        containerResolver: { make: async () => manager },
      } as any;

      session.put('authkit', { ...ADMIN, idToken });
      await manager.impersonate(ctx, 'target-1');
      // Mantém um id_token legível na sessão impersonada p/ o middleware chegar no store.
      const impersonated = session.get('authkit') as TokenSet;
      session.put('authkit', { ...impersonated, idToken });

      await new BackchannelRevocationMiddleware().handle(ctx, async () => {});

      assert.isUndefined(session.get('authkit'), 'a sessão revogada foi limpa');
      assert.isUndefined(
        session.get(IMPERSONATOR_KEY),
        'a revogação central tem que levar a credencial parqueada junto',
      );
    } finally {
      restore();
    }
  });
});
