import { AuthManager, defineConfig as defineAuthConfig, errors } from '@adonisjs/auth';
import type { SessionUserProviderContract } from '@adonisjs/auth/types/session';
import { configProvider } from '@adonisjs/core';
import { AppFactory } from '@adonisjs/core/factories/app';
import { EmitterFactory } from '@adonisjs/core/factories/events';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import type { ResolvedServerConfig } from '../src/define_config.js';
import { adapters, defineConfig } from '../src/define_config.js';
import {
  type AccessTokenVerifier,
  inProcessAccessTokenVerifier,
  type VerifiedAccessToken,
} from '../src/host/access_token_verifier.js';
import { ACCOUNT_SESSION_KEY } from '../src/host/account_session_key.js';
import { authkitUserProvider } from '../src/host/adonis_auth_user_provider.js';
import { getAccountId, hasAccountSession, realAccountId } from '../src/host/console_session.js';
import { impersonationState } from '../src/host/impersonation_session.js';
import {
  OidcBearerGuard,
  type OidcBearerGuardPolicy,
  oidcBearerGuard,
} from '../src/host/oidc_bearer_guard.js';
import { oidcRpGuard } from '../src/host/oidc_rp_guard.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { fakeAccountStore } from './bootstrap.js';

type FakeUser = { id: string; email: string };

const USERS = new Map<string, FakeUser>([['u1', { id: 'u1', email: 'a@b.com' }]]);

function makeUserProvider(
  users: Map<string, FakeUser> = USERS,
): SessionUserProviderContract<FakeUser> {
  const provider = {
    async createUserForGuard(user: FakeUser) {
      return { getId: () => user.id, getOriginal: () => user };
    },
    async findById(identifier: string | number | bigint) {
      const user = users.get(String(identifier));
      if (!user) return null;
      return { getId: () => user.id, getOriginal: () => user };
    },
  };
  return provider as unknown as SessionUserProviderContract<FakeUser>;
}

function verifiedToken(overrides: Partial<VerifiedAccessToken> = {}): VerifiedAccessToken {
  return {
    format: 'opaque',
    sub: 'u1',
    clientId: 'mobile',
    scopes: ['openid', 'email'],
    audience: [],
    exp: Math.floor(Date.now() / 1000) + 300,
    jti: 'jti',
    actor: null,
    ...overrides,
  };
}

/** Verificador em memória: `good` → token; resto → null. */
function fakeVerifier(token: VerifiedAccessToken = verifiedToken()): AccessTokenVerifier {
  return { verify: async (raw) => (raw === 'good' ? token : null) };
}

function makeCtx(opts: { authorization?: string; session?: Record<string, unknown> } = {}) {
  const headers: Record<string, string> = {};
  const emitted: Array<{ event: string; data: unknown }> = [];
  const ctx: any = {
    request: {
      header: (name: string) =>
        name.toLowerCase() === 'authorization' ? opts.authorization : undefined,
    },
    response: {
      header: (name: string, value: string) => {
        headers[name] = value;
      },
    },
  };
  if (opts.session) {
    const store = { ...opts.session };
    ctx.session = {
      get: (k: string) => store[k],
      put: (k: string, v: unknown) => {
        store[k] = v;
      },
      forget: (k: string) => {
        delete store[k];
      },
    };
  }
  const emitter = { emit: (event: string, data: unknown) => emitted.push({ event, data }) } as any;
  return { ctx, headers, emitted, emitter };
}

function makeGuard(
  opts: {
    authorization?: string;
    session?: Record<string, unknown>;
    verifier?: AccessTokenVerifier;
    policy?: OidcBearerGuardPolicy;
    users?: Map<string, FakeUser>;
  } = {},
) {
  const { ctx, headers, emitted, emitter } = makeCtx(opts);
  const guard = new OidcBearerGuard(
    'api',
    ctx,
    emitter,
    makeUserProvider(opts.users),
    opts.verifier ?? fakeVerifier(),
    opts.policy,
    errors.E_UNAUTHORIZED_ACCESS as any,
  );
  return { guard, ctx, headers, emitted };
}

test.group('OidcBearerGuard — authenticate', () => {
  test('token válido → user, accessToken e evento de sucesso', async ({ assert }) => {
    const { guard, emitted } = makeGuard({ authorization: 'Bearer good' });
    const user = await guard.authenticate();
    assert.equal(user.email, 'a@b.com');
    assert.isTrue(guard.isAuthenticated);
    assert.equal(guard.accessToken?.clientId, 'mobile');
    assert.isTrue(guard.hasScopes('openid', 'email'));
    assert.isFalse(guard.hasScopes('admin'));
    assert.deepEqual(
      emitted.map((e) => e.event),
      ['oidc_bearer:authentication_succeeded'],
    );
  });

  test('esquema Bearer é case-insensitive', async ({ assert }) => {
    const { guard } = makeGuard({ authorization: 'bearer good' });
    assert.equal((await guard.authenticate()).id, 'u1');
  });

  test('sem Authorization → E_UNAUTHORIZED_ACCESS (401) + desafio Bearer', async ({ assert }) => {
    const { guard, headers, emitted } = makeGuard();
    try {
      await guard.authenticate();
      assert.fail('deveria lançar');
    } catch (error) {
      assert.instanceOf(error, errors.E_UNAUTHORIZED_ACCESS);
      assert.equal((error as any).status, 401);
      // Renderiza como o guard nativo de access tokens: JSON, nunca redirect.
      assert.equal((error as any).guardDriverName, 'access_tokens');
      assert.isUndefined((error as any).redirectTo);
    }
    assert.equal(headers['WWW-Authenticate'], 'Bearer');
    assert.deepEqual(
      emitted.map((e) => e.event),
      ['oidc_bearer:authentication_failed'],
    );
  });

  test('Authorization com outro esquema (Basic) → 401', async ({ assert }) => {
    const { guard } = makeGuard({ authorization: 'Basic Z29vZDo=' });
    await assert.rejects(() => guard.authenticate(), 'Unauthorized access');
  });

  test('token inválido/expirado/revogado (verifier devolve null) → invalid_token', async ({
    assert,
  }) => {
    const { guard, headers } = makeGuard({ authorization: 'Bearer revoked' });
    await assert.rejects(() => guard.authenticate(), 'Unauthorized access');
    assert.equal(headers['WWW-Authenticate'], 'Bearer error="invalid_token"');
    assert.isFalse(guard.isAuthenticated);
  });

  test('user do sub não existe mais → 401', async ({ assert }) => {
    const { guard } = makeGuard({ authorization: 'Bearer good', users: new Map() });
    await assert.rejects(() => guard.authenticate(), 'Unauthorized access');
  });

  test('segunda chamada devolve o cache sem reverificar', async ({ assert }) => {
    let calls = 0;
    const verifier: AccessTokenVerifier = {
      verify: async () => {
        calls++;
        return verifiedToken();
      },
    };
    const { guard } = makeGuard({ authorization: 'Bearer good', verifier });
    await guard.authenticate();
    await guard.authenticate();
    assert.equal(calls, 1);
  });
});

test.group('OidcBearerGuard — política (escopos, audience, clients)', () => {
  test('escopo exigido ausente → insufficient_scope', async ({ assert }) => {
    const { guard, headers } = makeGuard({
      authorization: 'Bearer good',
      policy: { scopes: ['openid', 'exams:read'] },
    });
    await assert.rejects(() => guard.authenticate(), 'Unauthorized access');
    assert.equal(
      headers['WWW-Authenticate'],
      'Bearer error="insufficient_scope", scope="openid exams:read"',
    );
  });

  test('escopos exigidos presentes → ok', async ({ assert }) => {
    const { guard } = makeGuard({ authorization: 'Bearer good', policy: { scopes: ['email'] } });
    assert.equal((await guard.authenticate()).id, 'u1');
  });

  test('audience: token sem o aud aceito → 401; com → ok', async ({ assert }) => {
    const policy = { audience: 'https://api.example.com' };
    const without = makeGuard({ authorization: 'Bearer good', policy });
    await assert.rejects(() => without.guard.authenticate(), 'Unauthorized access');

    const withAud = makeGuard({
      authorization: 'Bearer good',
      policy,
      verifier: fakeVerifier(verifiedToken({ audience: ['https://api.example.com'] })),
    });
    assert.equal((await withAud.guard.authenticate()).id, 'u1');
  });

  test('clientIds: token de outro client → 401', async ({ assert }) => {
    const { guard } = makeGuard({
      authorization: 'Bearer good',
      policy: { clientIds: ['outro-app'] },
    });
    await assert.rejects(() => guard.authenticate(), 'Unauthorized access');
  });
});

test.group('OidcBearerGuard — check / getUserOrFail', () => {
  test('check() → false em falha de autenticação', async ({ assert }) => {
    const { guard } = makeGuard();
    assert.isFalse(await guard.check());
  });

  test('check() relança erro de infraestrutura (não vira "não logado")', async ({ assert }) => {
    const verifier: AccessTokenVerifier = {
      verify: async () => {
        throw new Error('redis fora');
      },
    };
    const { guard } = makeGuard({ authorization: 'Bearer good', verifier });
    await assert.rejects(() => guard.check(), 'redis fora');
  });

  test('getUserOrFail() antes de autenticar → E_UNAUTHORIZED_ACCESS', ({ assert }) => {
    const { guard } = makeGuard({ authorization: 'Bearer good' });
    assert.throws(() => guard.getUserOrFail());
  });
});

test.group('getAccountId — fallback da identidade bearer', () => {
  test('sem sessão: devolve a conta autenticada pelo bearer', async ({ assert }) => {
    const { guard, ctx } = makeGuard({ authorization: 'Bearer good' });
    assert.isNull(getAccountId(ctx), 'antes do guard rodar não há identidade');
    await guard.authenticate();
    assert.equal(getAccountId(ctx), 'u1');
    assert.equal(realAccountId(ctx), 'u1');
    assert.isFalse(hasAccountSession(ctx), 'bearer não é sessão');
  });

  test('sessão sem conta logada + bearer → bearer', async ({ assert }) => {
    const { guard, ctx } = makeGuard({ authorization: 'Bearer good', session: {} });
    await guard.authenticate();
    assert.equal(getAccountId(ctx), 'u1');
    assert.equal(realAccountId(ctx), 'u1');
  });

  test('sessão logada SEMPRE ganha do bearer', async ({ assert }) => {
    const { guard, ctx } = makeGuard({
      authorization: 'Bearer good',
      session: { [ACCOUNT_SESSION_KEY]: 'session-user' },
    });
    await guard.authenticate();
    assert.equal(getAccountId(ctx), 'session-user');
    assert.isTrue(hasAccountSession(ctx));
  });

  test('bearer recusado não deixa identidade para o getAccountId', async ({ assert }) => {
    const { guard, ctx } = makeGuard({ authorization: 'Bearer nope' });
    await guard.check();
    assert.isNull(getAccountId(ctx));
  });

  test('app só com sessão: comportamento inalterado', ({ assert }) => {
    const { ctx } = makeCtx({ session: { [ACCOUNT_SESSION_KEY]: 'u9' } });
    assert.equal(getAccountId(ctx), 'u9');
    const { ctx: anon } = makeCtx({ session: {} });
    assert.isNull(getAccountId(anon));
  });
});

test.group('OidcBearerGuard — in-process contra o issuer embarcado', (group) => {
  let service: OidcService;
  group.setup(async () => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve<ResolvedServerConfig>(
      fakeApp,
      defineConfig({
        issuer: 'http://localhost:9999',
        adapter: adapters.redis({ connection: 'main' }),
        jwks: { source: 'managed', algorithm: 'RS256' },
        accountStore: fakeAccountStore(),
      }),
    );
    service = new OidcService(cfg!, 'a'.repeat(32));
  });

  test('authenticateAsClient emite um AT real que o próprio guard aceita', async ({ assert }) => {
    const verifier = inProcessAccessTokenVerifier(async () => service);
    const issuing = makeGuard({ verifier, policy: { scopes: ['openid', 'exams:read'] } });
    const { headers } = await issuing.guard.authenticateAsClient(USERS.get('u1')!, {
      clientId: 'mobile',
    });
    assert.match(headers!.authorization, /^Bearer \S+$/);

    const { guard } = makeGuard({
      authorization: headers!.authorization,
      verifier,
      policy: { scopes: ['openid', 'exams:read'] },
    });
    assert.equal((await guard.authenticate()).id, 'u1');
    assert.equal(guard.accessToken?.clientId, 'mobile');
    assert.equal(guard.accessToken?.format, 'opaque');
  });

  test('AT revogado (destroy do artefato) → 401', async ({ assert }) => {
    const verifier = inProcessAccessTokenVerifier(async () => service);
    const provider: any = service.provider;
    const at = new provider.AccessToken({
      accountId: 'u1',
      clientId: 'mobile',
      scope: 'openid',
      gty: 'authorization_code',
    });
    const value = await at.save();
    assert.isTrue(await makeGuard({ authorization: `Bearer ${value}`, verifier }).guard.check());

    await at.destroy();
    assert.isFalse(await makeGuard({ authorization: `Bearer ${value}`, verifier }).guard.check());
  });

  test('authenticateAsClient no modo remoto → erro explícito', async ({ assert }) => {
    const { guard } = makeGuard({ verifier: fakeVerifier() });
    await assert.rejects(() => guard.authenticateAsClient(USERS.get('u1')!), /in-process/);
  });
});

test.group('oidcBearerGuard() — config/auth.ts real (@adonisjs/auth)', (group) => {
  let app: any;
  let service: OidcService;

  group.setup(async () => {
    app = new AppFactory().create(new URL('./', import.meta.url), () => {});
    await app.init();
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve<ResolvedServerConfig>(
      fakeApp,
      defineConfig({
        issuer: 'http://localhost:9998',
        adapter: adapters.redis({ connection: 'main' }),
        jwks: { source: 'managed', algorithm: 'RS256' },
        accountStore: fakeAccountStore(),
      }),
    );
    service = new OidcService(cfg!, 'a'.repeat(32));
    app.container.singleton('authkit.accountStore', async () => fakeAccountStore());
    app.container.singleton('authkit.server', async () => service);
    app.container.singleton('emitter', async () => new EmitterFactory().create(app));
  });

  async function authenticatorFor(ctx: any) {
    const provider = authkitUserProvider();
    const resolved = await configProvider.resolve<any>(
      app,
      defineAuthConfig({
        default: 'web',
        guards: {
          web: oidcRpGuard({ provider }),
          api: oidcBearerGuard({ provider, scopes: ['openid'] }),
        },
      }),
    );
    return new AuthManager(resolved!).createAuthenticator(ctx);
  }

  function apiCtx(authorization?: string) {
    const { ctx } = makeCtx({ authorization, session: {} });
    return ctx;
  }

  test("authenticateUsing(['web','api']): sem sessão, o bearer autentica", async ({ assert }) => {
    const provider: any = service.provider;
    const token = await new provider.AccessToken({
      accountId: 'u1',
      clientId: 'mobile',
      scope: 'openid profile',
      gty: 'authorization_code',
    }).save();

    const ctx = apiCtx(`Bearer ${token}`);
    const auth = await authenticatorFor(ctx);
    const user = (await auth.authenticateUsing(['web', 'api'])) as { id: string };
    assert.equal(user.id, 'u1');
    assert.equal(auth.authenticatedViaGuard, 'api');
    // Sites que chamam getAccountId(ctx) não precisam mudar.
    assert.equal(getAccountId(ctx), 'u1');
  });

  test('sem sessão e sem bearer → E_UNAUTHORIZED_ACCESS 401, sem redirect', async ({ assert }) => {
    const ctx = apiCtx();
    const auth = await authenticatorFor(ctx);
    try {
      await auth.authenticateUsing(['web', 'api']);
      assert.fail('deveria lançar');
    } catch (error) {
      assert.instanceOf(error, errors.E_UNAUTHORIZED_ACCESS);
      assert.equal((error as any).status, 401);
      assert.isUndefined((error as any).redirectTo);
    }
    assert.isNull(getAccountId(ctx));
  });

  test("auth.use('api') sozinho responde no renderer JSON do access_tokens", async ({ assert }) => {
    const ctx = apiCtx('Bearer invalido');
    const auth = await authenticatorFor(ctx);
    const error: any = await auth
      .use('api')
      .authenticate()
      .catch((e: unknown) => e);
    assert.instanceOf(error, errors.E_UNAUTHORIZED_ACCESS);

    let status = 0;
    let body: unknown;
    const res: any = {
      status: (s: number) => {
        status = s;
        return res;
      },
      send: (b: unknown) => {
        body = b;
      },
      redirect: () => {
        throw new Error('não deveria redirecionar');
      },
    };
    await error.handle(error, { request: { accepts: () => 'json' }, response: res });
    assert.equal(status, 401);
    assert.deepEqual(body, { errors: [{ message: 'Unauthorized access' }] });
  });
});

test.group('OidcBearerGuard — impersonation pelo access token (act)', () => {
  const users = new Map<string, FakeUser>([
    ['u1', { id: 'u1', email: 'a@b.com' }],
    ['admin', { id: 'admin', email: 'admin@b.com' }],
  ]);

  test('token com act: age como o alvo, mas impersonationState/realAccountId veem o admin', async ({
    assert,
  }) => {
    const exp = Math.floor(Date.now() / 1000) + 600;
    const { guard, ctx } = makeGuard({
      authorization: 'Bearer good',
      users,
      verifier: fakeVerifier(verifiedToken({ actor: 'admin', exp, jti: 'imp-1' })),
    });
    await guard.authenticate();

    assert.equal(getAccountId(ctx), 'u1', 'a request age como o alvo');
    assert.equal(realAccountId(ctx), 'admin', 'o humano real é o admin');
    const state = impersonationState(ctx);
    assert.isTrue(state.active);
    assert.equal(state.source, 'bearer');
    assert.equal(state.targetId, 'u1');
    assert.equal(state.impersonatorId, 'admin');
    assert.equal(state.impersonationId, 'imp-1');
    assert.equal(state.expiresAt, exp * 1000);
  });

  test('token comum: sem impersonation', async ({ assert }) => {
    const { guard, ctx } = makeGuard({ authorization: 'Bearer good', users });
    await guard.authenticate();
    assert.isFalse(impersonationState(ctx).active);
    assert.equal(realAccountId(ctx), 'u1');
  });

  test('ator que não existe mais derruba o token (401)', async ({ assert }) => {
    const { guard, ctx } = makeGuard({
      authorization: 'Bearer good',
      users: new Map([['u1', { id: 'u1', email: 'a@b.com' }]]),
      verifier: fakeVerifier(verifiedToken({ actor: 'admin-apagado' })),
    });
    assert.isFalse(await guard.check());
    assert.isNull(getAccountId(ctx));
    assert.isFalse(impersonationState(ctx).active);
  });

  test('sessão de console ganha do bearer (mesma regra do getAccountId)', async ({ assert }) => {
    const { guard, ctx } = makeGuard({
      authorization: 'Bearer good',
      users,
      session: { [ACCOUNT_SESSION_KEY]: 'u1' },
      verifier: fakeVerifier(verifiedToken({ actor: 'admin' })),
    });
    await guard.authenticate();
    assert.isFalse(impersonationState(ctx).active, 'a sessão (sem impersonation) é quem manda');
  });
});

test.group('inProcessAccessTokenVerifier — act do token trocado', (group) => {
  let service: OidcService;
  group.setup(async () => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve<ResolvedServerConfig>(
      fakeApp,
      defineConfig({
        issuer: 'http://localhost:9998',
        adapter: adapters.redis({ connection: 'main' }),
        jwks: { source: 'managed', algorithm: 'RS256' },
        accountStore: fakeAccountStore(),
      }),
    );
    service = new OidcService(cfg!, 'a'.repeat(32));
  });

  test('AT opaco com extra.act → actor; sem → null', async ({ assert }) => {
    const verifier = inProcessAccessTokenVerifier(async () => service);
    const provider: any = service.provider;
    const exchanged = new provider.AccessToken({
      accountId: 'u1',
      clientId: 'mobile',
      scope: 'openid',
      gty: 'urn:ietf:params:oauth:grant-type:token-exchange',
    });
    exchanged.authkitImpersonationActor = 'admin';
    const impersonation = await exchanged.save();
    const plain = await new provider.AccessToken({
      accountId: 'u1',
      clientId: 'mobile',
      scope: 'openid',
      gty: 'authorization_code',
    }).save();

    assert.equal((await verifier.verify(impersonation))?.actor, 'admin');
    assert.isNull((await verifier.verify(plain))?.actor);
  });
});
