import type { Identity } from '@adonis-agora/authkit-core';
import { errors as authErrors, Authenticator as FrameworkAuthenticator } from '@adonisjs/auth';
import type { HttpContext } from '@adonisjs/core/http';
import { test } from '@japa/runner';
import { Authenticator } from '../src/authenticator.js';
import { authkitClientGuard } from '../src/host/authkit_client_guard.js';
import AuthkitContextMiddleware from '../src/middleware/authkit_context_middleware.js';
import AuthkitMiddleware from '../src/middleware/authkit_middleware.js';

const SET_SLOT = Symbol.for('@agora/context:set');

const identity: Identity = {
  userId: 'u1',
  email: 'ana@example.com',
  globalRoles: ['ADMIN'],
  profile: { name: 'Ana' },
  issuedAt: 0,
  expiresAt: 0,
  raw: {},
};

type ResolveUser = (identity: Identity) => Promise<unknown>;

/**
 * Dublê do `AuthkitClientManager`: expõe as MESMAS três APIs que o guard usa
 * (`maybeRefresh` + `createAuthenticator`), montando um `Authenticator` de
 * verdade sobre um `SessionResolver` fake.
 */
function fakeManager(options: { identity: Identity | null; resolveUser?: ResolveUser }) {
  const calls = { maybeRefresh: 0, createAuthenticator: 0 };
  return {
    calls,
    async maybeRefresh() {
      calls.maybeRefresh++;
    },
    async createAuthenticator(ctx: HttpContext) {
      calls.createAuthenticator++;
      return new Authenticator(ctx, {
        resolver: { resolve: async () => options.identity },
        resolveUser: options.resolveUser,
        getAccessToken: () => 'access-token',
      });
    },
  };
}

function fakeCtx(manager: unknown) {
  const resolved: string[] = [];
  const ctx = {
    containerResolver: {
      make: async (binding: string) => {
        resolved.push(binding);
        return manager;
      },
    },
  } as unknown as HttpContext;
  return { ctx, resolved };
}

/** Dublê de `SessionUserProviderContract` que registra os ids consultados. */
function fakeProvider(users: Record<string, { id: string; name: string }>) {
  const lookups: string[] = [];
  const provider = {
    lookups,
    async createUserForGuard(user: { id: string }) {
      return { getId: () => user.id, getOriginal: () => user };
    },
    async findById(identifier: string | number | bigint) {
      lookups.push(String(identifier));
      const user = users[String(identifier)];
      if (!user) return null;
      return { getId: () => user.id, getOriginal: () => user };
    },
  };
  return provider;
}

/** Monta o `ctx.auth` REAL do @adonisjs/auth com o guard do authkit no lugar. */
async function bootGuard(options: {
  identity: Identity | null;
  users?: Record<string, { id: string; name: string }>;
  resolveUser?: ResolveUser;
}) {
  const manager = fakeManager({ identity: options.identity, resolveUser: options.resolveUser });
  const { ctx, resolved } = fakeCtx(manager);
  const provider = fakeProvider(options.users ?? { u1: { id: 'u1', name: 'Ana (banco local)' } });
  const factory = await authkitClientGuard({ provider: provider as never }).resolver(
    'web',
    {} as never,
  );
  const auth = new FrameworkAuthenticator(ctx, {
    default: 'web',
    guards: { web: factory },
  });
  (ctx as unknown as { auth: unknown }).auth = auth;
  return { auth, ctx, manager, provider, resolved };
}

test.group('authkitClientGuard', () => {
  test('sessão autenticada → ctx.auth.user é o usuário do provider', async ({ assert }) => {
    const { auth, provider } = await bootGuard({ identity });

    const user = await auth.authenticate();

    assert.deepEqual(user, { id: 'u1', name: 'Ana (banco local)' });
    assert.deepEqual(auth.user, { id: 'u1', name: 'Ana (banco local)' });
    assert.isTrue(auth.isAuthenticated);
    // O mapeamento é pelo id ESTÁVEL da Identity (`userId`, a claim `sub`).
    assert.deepEqual(provider.lookups, ['u1']);
  });

  test('sem sessão → check() é false e authenticate() lança E_UNAUTHORIZED_ACCESS', async ({
    assert,
  }) => {
    const { auth } = await bootGuard({ identity: null });

    assert.isFalse(await auth.check());

    const error = await auth.authenticate().then(
      () => null,
      (e: unknown) => e,
    );
    assert.instanceOf(error, authErrors.E_UNAUTHORIZED_ACCESS);
    assert.equal((error as { code?: string }).code, 'E_UNAUTHORIZED_ACCESS');
    assert.equal((error as { guardDriverName?: string }).guardDriverName, 'authkit_client');
  });

  test('sessão válida mas sem usuário local → E_UNAUTHORIZED_ACCESS (fail-closed)', async ({
    assert,
  }) => {
    const { auth } = await bootGuard({ identity, users: {} });

    assert.isFalse(await auth.check());
    await assert.rejects(() => auth.authenticate());
  });

  test('o caminho do guard roda maybeRefresh e reusa o SessionResolver do manager', async ({
    assert,
  }) => {
    const { auth, manager, resolved } = await bootGuard({ identity });

    await auth.authenticate();

    assert.deepEqual(resolved, ['authkit.client']);
    assert.equal(manager.calls.maybeRefresh, 1);
    assert.equal(manager.calls.createAuthenticator, 1);
  });

  test('o caminho do guard popula a ponte do @agora/context', async ({ assert }) => {
    const patches: unknown[] = [];
    const previous = (globalThis as Record<symbol, unknown>)[SET_SLOT];
    (globalThis as Record<symbol, unknown>)[SET_SLOT] = (patch: unknown) => patches.push(patch);
    try {
      const { auth } = await bootGuard({ identity });
      await auth.authenticate();
    } finally {
      (globalThis as Record<symbol, unknown>)[SET_SLOT] = previous;
    }

    assert.lengthOf(patches, 1);
    assert.deepInclude(patches[0] as object, {
      globalRoles: ['ADMIN'],
    });
  });

  test('o guard expõe a superfície do authkit em ctx.authkit (e em guard.authkit)', async ({
    assert,
  }) => {
    const { auth, ctx } = await bootGuard({ identity });
    await auth.authenticate();

    const authkit = (ctx as unknown as { authkit: Authenticator }).authkit;
    assert.instanceOf(authkit, Authenticator);
    assert.isTrue(authkit.hasGlobalRole('ADMIN'));
    assert.equal((await authkit.getIdentity())?.userId, 'u1');
    assert.strictEqual(auth.use('web').authkit, authkit);
  });

  test('provider + resolveUser: o provider manda em ctx.auth.user; resolveUser só alimenta ctx.authkit', async ({
    assert,
  }) => {
    const { auth, ctx } = await bootGuard({
      identity,
      resolveUser: async () => ({ id: 'u1', name: 'via resolveUser' }),
    });

    await auth.authenticate();

    assert.deepEqual(auth.user, { id: 'u1', name: 'Ana (banco local)' });
    const authkit = (ctx as unknown as { authkit: Authenticator }).authkit;
    assert.deepEqual(await authkit.getUser(), { id: 'u1', name: 'via resolveUser' });
  });
});

test.group('AuthkitContextMiddleware', () => {
  test('popula ctx.authkit sem tocar em ctx.auth', async ({ assert }) => {
    const manager = fakeManager({ identity });
    const { ctx } = fakeCtx(manager);

    await new AuthkitContextMiddleware().handle(ctx, async () => {});

    const withAuthkit = ctx as unknown as { authkit?: Authenticator; auth?: unknown };
    assert.instanceOf(withAuthkit.authkit, Authenticator);
    assert.isUndefined(withAuthkit.auth);
    assert.equal(manager.calls.maybeRefresh, 1);
  });

  test('o guard reusa o ctx.authkit já montado pelo middleware (uma resolução só)', async ({
    assert,
  }) => {
    const { auth, ctx, manager } = await bootGuard({ identity });
    await new AuthkitContextMiddleware().handle(ctx, async () => {});
    await auth.authenticate();

    assert.equal(manager.calls.createAuthenticator, 1);
    assert.equal(manager.calls.maybeRefresh, 1);
  });
});

/**
 * A GARANTIA DE COMPATIBILIDADE (plano, passo 3): sem guard configurado, o
 * `authkit_middleware` continua sendo o dono de `ctx.auth` e a superfície do
 * `Authenticator` do authkit segue idêntica. Este teste NÃO depende do guard —
 * é ele que prova que a adição do guard não mexeu no caminho default.
 */
test.group('compatibilidade: sem guard configurado', () => {
  test('authkit_middleware continua colocando o Authenticator do authkit em ctx.auth', async ({
    assert,
  }) => {
    const manager = fakeManager({
      identity,
      resolveUser: async () => ({ id: 'u1', name: 'via resolveUser' }),
    });
    const { ctx } = fakeCtx(manager);

    let nextCalled = false;
    await new AuthkitMiddleware().handle(ctx, async () => {
      nextCalled = true;
    });

    assert.isTrue(nextCalled);
    const auth = (ctx as unknown as { auth: Authenticator }).auth;
    assert.instanceOf(auth, Authenticator);
    assert.equal(manager.calls.maybeRefresh, 1);

    // superfície histórica, intacta
    assert.equal((await auth.getIdentity())?.userId, 'u1');
    assert.equal((await auth.authenticate()).email, 'ana@example.com');
    assert.isTrue(await auth.check());
    assert.isTrue(auth.hasGlobalRole('ADMIN'));
    assert.isFalse(auth.hasGlobalRole('STAFF'));
    assert.deepEqual(await auth.getUser(), { id: 'u1', name: 'via resolveUser' });
    assert.deepEqual(await auth.getUserOrFail(), { id: 'u1', name: 'via resolveUser' });

    // o middleware default NÃO passa a mexer em ctx.authkit
    assert.isUndefined((ctx as unknown as { authkit?: unknown }).authkit);
  });

  test('authkit_middleware sem sessão: check() false e authenticate() lança o erro histórico', async ({
    assert,
  }) => {
    const manager = fakeManager({ identity: null });
    const { ctx } = fakeCtx(manager);
    await new AuthkitMiddleware().handle(ctx, async () => {});

    const auth = (ctx as unknown as { auth: Authenticator }).auth;
    assert.isFalse(await auth.check());
    await assert.rejects(() => auth.authenticate(), 'Not authenticated');
  });
});
