import { test } from '@japa/runner';
import { resolveRateLimit } from '../../src/define_config.js';
import { getAccountLoginUrl, resetAccountLoginUrl } from '../../src/host/account_login_url.js';
import {
  getAdminApiPrefix,
  getAdminPrefix,
  normalizeAdminApiPrefix,
  normalizeAdminPrefix,
} from '../../src/host/admin_prefix.js';
import { resetAuthHostConfig, setAuthHostConfig } from '../../src/host/auth_host_config.js';
import { registerAuthHost } from '../../src/host/register_auth_host.js';

function fakeRouter() {
  const routes: Array<{
    method: string;
    pattern: string;
    middleware: unknown[];
    handler?: unknown;
    name?: string;
  }> = [];
  let groupMiddlewareApplied = false;
  /** Last prefix passed via `.prefix()` on any group chain — useful for API prefix tests. */
  const groupPrefixes: string[] = [];

  const mk = (method: string) => (pattern: string, handler?: unknown) => {
    const route = {
      method,
      pattern,
      middleware: [] as unknown[],
      handler,
      name: undefined as string | undefined,
    };
    routes.push(route);
    const chain: any = {
      as: (n: string) => {
        route.name = n;
        return chain;
      },
      middleware: () => chain,
      use: (m: unknown[]) => {
        route.middleware.push(...(Array.isArray(m) ? m : [m]));
        return chain;
      },
    };
    return chain;
  };

  const groupChain = {
    as: () => groupChain,
    prefix: (p: string) => {
      groupPrefixes.push(p);
      return groupChain;
    },
    middleware: (..._args: any[]) => {
      groupMiddlewareApplied = true;
      return groupChain;
    },
    use: (..._args: any[]) => {
      groupMiddlewareApplied = true;
      return groupChain;
    },
  };

  const router: any = {
    get: mk('GET'),
    post: mk('POST'),
    patch: mk('PATCH'),
    delete: mk('DELETE'),
    put: mk('PUT'),
    any: mk('ANY'),
    group: (cb: () => void) => {
      cb();
      return groupChain;
    },
    routes,
    get groupMiddlewareApplied() {
      return groupMiddlewareApplied;
    },
    get groupPrefixes() {
      return groupPrefixes;
    },
  };
  return router;
}

test.group('registerAuthHost', () => {
  test('monta o wildcard do provider sob mountPath + a interaction', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/oidc/*'));
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/oidc'));
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/auth/interaction/:uid'));
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/account/login'));
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/authkit/pat/introspect'));
  });

  test('console React: rotas /api/* são registradas ANTES do catch-all do shell (anti-shadowing)', ({
    assert,
  }) => {
    // Regressão: o AdonisJS casa wildcards por ordem de registro. Se o catch-all
    // `${ap}/*` (shell HTML) vier antes das rotas `/api/*`, ele engole a API e
    // devolve HTML onde a SPA espera JSON ("Unexpected token '<'" no console).
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', admin: { ui: 'react', prefix: '/admin' } });

    const idxCatchAll = (router.routes as any[]).findIndex(
      (r) => r.method === 'GET' && r.pattern === '/admin/*',
    );
    const apiGets = (router.routes as any[]).filter(
      (r) => r.method === 'GET' && r.pattern.startsWith('/admin/api/'),
    );
    assert.isAbove(idxCatchAll, -1, 'catch-all do shell deve existir');
    assert.isAbove(apiGets.length, 0, 'deve haver rotas /api/*');
    for (const api of apiGets) {
      const idx = (router.routes as any[]).indexOf(api);
      assert.isBelow(idx, idxCatchAll, `${api.pattern} deve vir antes do catch-all /admin/*`);
    }
  });

  test('console React: rotas /api/users/:id/sessions e /api/users/:id/revoke-sessions são registradas ANTES do catch-all', ({
    assert,
  }) => {
    // Regressão: sem essas rotas o catch-all servia HTML → "Unexpected token '<'" no drawer do usuário.
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', admin: { ui: 'react', prefix: '/admin' } });

    const idxCatchAll = (router.routes as any[]).findIndex(
      (r) => r.method === 'GET' && r.pattern === '/admin/*',
    );
    assert.isAbove(idxCatchAll, -1, 'catch-all do shell deve existir');

    // GET sessions por usuário deve existir e vir antes do catch-all.
    const idxGetSessions = (router.routes as any[]).findIndex(
      (r) => r.method === 'GET' && r.pattern === '/admin/api/users/:id/sessions',
    );
    assert.isAbove(idxGetSessions, -1, 'GET /admin/api/users/:id/sessions deve estar registrada');
    assert.isBelow(
      idxGetSessions,
      idxCatchAll,
      'GET /admin/api/users/:id/sessions deve vir antes do catch-all',
    );

    // POST revoke-sessions por usuário deve existir.
    const hasPostRevoke = (router.routes as any[]).some(
      (r) => r.method === 'POST' && r.pattern === '/admin/api/users/:id/revoke-sessions',
    );
    assert.isTrue(hasPostRevoke, 'POST /admin/api/users/:id/revoke-sessions deve estar registrada');
  });

  test('console React: rotas com mesmo controller.método têm nomes explícitos distintos (anti-colisão)', ({
    assert,
  }) => {
    // Regressão: o AdonisJS auto-deriva o nome da rota de controller.método. Duas
    // rotas GET no mesmo [controller, método] (shell em `ap` e `ap/*`) sem `.as()`
    // distinto colidem no boot ("route name already exists") — derrubou o deploy.
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', admin: { ui: 'react' } });

    // Agrupa por handler-tuple (controller thunk + método); cada grupo com >1 rota
    // PRECISA de nomes explícitos e distintos.
    const byHandler = new Map<string, Array<{ name?: string }>>();
    for (const r of router.routes as any[]) {
      if (!Array.isArray(r.handler)) continue;
      const key = JSON.stringify([String(r.handler[0]), r.handler[1], r.method]);
      const list = byHandler.get(key) ?? [];
      list.push(r);
      byHandler.set(key, list);
    }
    for (const [, list] of byHandler) {
      if (list.length < 2) continue;
      const names = list.map((r) => r.name);
      assert.isTrue(
        names.every((n) => typeof n === 'string' && n.length > 0),
        'rotas que compartilham controller.método precisam de .as() explícito',
      );
      assert.equal(new Set(names).size, names.length, 'nomes de rota devem ser únicos');
    }
  });

  test('NÃO monta rotas sociais quando social ausente', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    assert.isFalse(router.routes.some((r: any) => r.pattern.includes('/redirect/:uid')));
  });

  test('monta rotas sociais quando social definido', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', social: { providers: ['google'] } });
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/auth/:provider/redirect/:uid'));
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/auth/:provider/callback'));
  });

  test('usa o mountPath custom', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/sso' });
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/sso/*'));
  });

  test('protege as rotas /account/tokens com middleware (login/logout ficam livres)', ({
    assert,
  }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });

    // As 3 rotas de tokens existem
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/account/security'));
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/account/tokens/:id/revoke'));

    // O middleware account_auth foi aplicado ao grupo
    assert.isTrue(router.groupMiddlewareApplied);

    // login/logout continuam registradas fora do grupo protegido
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/account/login'));
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/account/logout'));
  });

  test('L6: POST /account/login e /account/logout recebem o throttle por IP (withLogin)', ({
    assert,
  }) => {
    const router = fakeRouter();
    // rateLimit habilitado (default) → throttles existem e withLogin aplica o middleware.
    registerAuthHost(router, { mountPath: '/oidc', rateLimit: {} });

    const postLogin = (router.routes as any[]).find(
      (r) => r.pattern === '/account/login' && r.method === 'POST',
    );
    const postLogout = (router.routes as any[]).find(
      (r) => r.pattern === '/account/logout' && r.method === 'POST',
    );
    // A rota de interaction/login (já protegida) serve de baseline do throttle.
    const baseline = (router.routes as any[]).find(
      (r) => r.pattern === '/auth/interaction/:uid/login' && r.method === 'POST',
    );
    assert.isOk(postLogin);
    assert.isOk(postLogout);
    assert.isAbove(baseline.middleware.length, 0, 'baseline deve ter throttle');
    // O MESMO throttle aplicado ao baseline deve estar em login/logout do console.
    assert.isAbove(postLogin.middleware.length, 0, '/account/login deve ter throttle por IP');
    assert.isAbove(postLogout.middleware.length, 0, '/account/logout deve ter throttle por IP');
  });

  test('NÃO monta rotas /admin por default (opt-in)', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    assert.isFalse(router.routes.some((r: any) => r.pattern === '/admin'));
    assert.isFalse(router.routes.some((r: any) => r.pattern === '/admin/users'));
  });

  test('monta o grupo /admin quando admin: true (React SPA — novo default)', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', admin: true });
    // admin:true usa ui:'react' — monta shell + JSON API.
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/admin'));
    // Shell catch-all.
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/admin/*' && r.method === 'GET'));
    // JSON API overview.
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/admin/api/overview'));
    // JSON API users.
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/admin/api/users'));
    // JSON API clients.
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/admin/api/clients'));
    // JSON API audit.
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/admin/api/audit'));
    // NÃO monta rotas Edge antigas.
    assert.isFalse(
      router.routes.some((r: any) => r.pattern === '/admin/users' && r.method === 'GET'),
    );
    // O grupo recebeu middleware (adminGuard).
    assert.isTrue(router.groupMiddlewareApplied);
    // O singleton de processo reflete o prefixo default.
    assert.equal(getAdminPrefix(), '/admin');
  });

  test('monta o grupo sob prefixo custom quando admin: { prefix }', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', admin: { prefix: '/auth/admin' } });
    // Rotas React devem existir sob o prefixo custom.
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/auth/admin'));
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/auth/admin/*'));
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/auth/admin/api/overview'));
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/auth/admin/api/users'));
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/auth/admin/api/clients'));
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/auth/admin/api/audit'));
    // As rotas do prefixo DEFAULT /admin NÃO devem existir.
    assert.isFalse(router.routes.some((r: any) => r.pattern === '/admin'));
    assert.isFalse(router.routes.some((r: any) => r.pattern === '/admin/users'));
    // O singleton reflete o prefixo custom.
    assert.equal(getAdminPrefix(), '/auth/admin');
    // O grupo recebeu middleware (adminGuard).
    assert.isTrue(router.groupMiddlewareApplied);
  });

  test('admin: {} sem prefix usa o default /admin (React mode)', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', admin: {} });
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/admin'));
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/admin/api/users'));
    assert.equal(getAdminPrefix(), '/admin');
  });

  test('normalizeAdminPrefix normaliza corretamente', ({ assert }) => {
    assert.equal(normalizeAdminPrefix('/admin'), '/admin');
    assert.equal(normalizeAdminPrefix('admin'), '/admin');
    assert.equal(normalizeAdminPrefix('/admin/'), '/admin');
    assert.equal(normalizeAdminPrefix('/auth/admin/'), '/auth/admin');
    assert.equal(normalizeAdminPrefix('  /auth/admin  '), '/auth/admin');
  });

  test('NÃO aplica throttle quando rateLimit enabled: false explícito', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', rateLimit: { enabled: false } });

    const loginRoute = router.routes.find((r: any) => r.pattern === '/auth/interaction/:uid/login');
    const introspectRoute = router.routes.find((r: any) => r.pattern === '/authkit/pat/introspect');
    assert.lengthOf(loginRoute.middleware, 0);
    assert.lengthOf(introspectRoute.middleware, 0);
  });

  test('aplica throttle por default (sem rateLimit passado)', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });

    const loginRoute = router.routes.find(
      (r: any) => r.pattern === '/auth/interaction/:uid/login' && r.method === 'POST',
    );
    const introspectRoute = router.routes.find((r: any) => r.pattern === '/authkit/pat/introspect');
    assert.isAbove(loginRoute.middleware.length, 0);
    assert.isAbove(introspectRoute.middleware.length, 0);
  });

  test('aplica throttle nas rotas sensíveis quando rateLimit enabled', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', rateLimit: { enabled: true } });

    // Login bucket: login/signup/forgot/reset POSTs recebem throttle.
    const loginBucketPatterns = [
      '/auth/interaction/:uid/login',
      '/auth/interaction/:uid/signup',
      '/auth/forgot-password',
      '/auth/reset-password',
    ];
    for (const pattern of loginBucketPatterns) {
      const route = router.routes.find((r: any) => r.pattern === pattern && r.method === 'POST');
      assert.isAbove(route.middleware.length, 0, `esperava throttle em ${pattern}`);
    }

    // Introspection bucket.
    const introspectRoute = router.routes.find((r: any) => r.pattern === '/authkit/pat/introspect');
    assert.isAbove(introspectRoute.middleware.length, 0);

    // Rotas não-sensíveis (GETs, consent, identifier) NÃO recebem throttle.
    const consentRoute = router.routes.find(
      (r: any) => r.pattern === '/auth/interaction/:uid/consent',
    );
    assert.lengthOf(consentRoute.middleware, 0);
    const showRoute = router.routes.find(
      (r: any) => r.pattern === '/auth/interaction/:uid' && r.method === 'GET',
    );
    assert.lengthOf(showRoute.middleware, 0);
  });
});

test.group('registerAuthHost — Admin REST API prefix', () => {
  test('NÃO monta rotas da Admin API por default (opt-in)', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    // Rotas internas do grupo (sem prefixo aplicado pelo fakeRouter) não devem existir.
    assert.isFalse(router.routes.some((r: any) => r.pattern === '/users'));
    assert.isFalse(router.routes.some((r: any) => r.pattern === '/clients'));
  });

  test('adminApi: true → prefixo default /api/authkit/v1 (back-compat)', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', adminApi: true });
    // Grupo montado — rotas internas presentes.
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/users' && r.method === 'GET'));
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/clients' && r.method === 'GET'));
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/audit' && r.method === 'GET'));
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/stats' && r.method === 'GET'));
    // Prefixo default aplicado ao grupo.
    assert.isTrue(router.groupPrefixes.includes('/api/authkit/v1'));
    // Singleton de processo reflete o prefixo default.
    assert.equal(getAdminApiPrefix(), '/api/authkit/v1');
    // Middleware (adminApiGuard) aplicado ao grupo.
    assert.isTrue(router.groupMiddlewareApplied);
  });

  test('adminApi: { prefix } → prefixo custom', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', adminApi: { prefix: '/authkit/api' } });
    // Grupo montado — rotas internas presentes.
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/users' && r.method === 'GET'));
    // Prefixo custom aplicado ao grupo.
    assert.isTrue(router.groupPrefixes.includes('/authkit/api'));
    // Default NÃO aplicado.
    assert.isFalse(router.groupPrefixes.includes('/api/authkit/v1'));
    // Singleton reflete o prefixo custom.
    assert.equal(getAdminApiPrefix(), '/authkit/api');
  });

  test('adminApi: {} sem prefix usa o default /api/authkit/v1', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', adminApi: {} });
    assert.isTrue(router.groupPrefixes.includes('/api/authkit/v1'));
    assert.equal(getAdminApiPrefix(), '/api/authkit/v1');
  });

  test('adminApi prefix normalizado (sem trailing slash, com leading slash)', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', adminApi: { prefix: 'authkit/api/' } });
    assert.isTrue(router.groupPrefixes.includes('/authkit/api'));
    assert.equal(getAdminApiPrefix(), '/authkit/api');
  });

  test('normalizeAdminApiPrefix normaliza corretamente', ({ assert }) => {
    assert.equal(normalizeAdminApiPrefix('/api/authkit/v1'), '/api/authkit/v1');
    assert.equal(normalizeAdminApiPrefix('api/authkit/v1'), '/api/authkit/v1');
    assert.equal(normalizeAdminApiPrefix('/api/authkit/v1/'), '/api/authkit/v1');
    assert.equal(normalizeAdminApiPrefix('/authkit/api/'), '/authkit/api');
    assert.equal(normalizeAdminApiPrefix('  /authkit/api  '), '/authkit/api');
  });

  test('ambos os prefixos (console + API) custom convivem', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, {
      mountPath: '/oidc',
      admin: { prefix: '/auth/admin' },
      adminApi: { prefix: '/authkit/api' },
    });
    // Console sob prefixo custom (modo React: rota shell + JSON API).
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/auth/admin'));
    // Em modo React, as rotas de dados ficam sob /api/: /auth/admin/api/users.
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/auth/admin/api/users'));
    assert.isFalse(router.routes.some((r: any) => r.pattern === '/admin'));
    // API grupo sob prefixo custom.
    assert.isTrue(router.routes.some((r: any) => r.pattern === '/users' && r.method === 'GET'));
    assert.isTrue(router.groupPrefixes.includes('/authkit/api'));
    assert.isFalse(router.groupPrefixes.includes('/api/authkit/v1'));
    // Singletons refletem ambos.
    assert.equal(getAdminPrefix(), '/auth/admin');
    assert.equal(getAdminApiPrefix(), '/authkit/api');
  });
});

test.group('registerAuthHost / dedup do config (Option C)', (group) => {
  group.each.teardown(() => resetAuthHostConfig());

  test('console sem porta de entrada (SSO e senha desligados) sem `accountLoginUrl`: recusa', ({
    assert,
  }) => {
    setAuthHostConfig({
      mountPath: '/oidc',
      rateLimit: resolveRateLimit(undefined),
      adminEnabled: true,
      adminApiEnabled: false,
      consoleNeedsLoginUrl: true,
    });
    assert.throws(() => registerAuthHost(fakeRouter()), /nenhum jeito de entrar/);
  });

  test('console sem porta de entrada: `accountLoginUrl` no registerAuthHost ou em routes resolve', ({
    assert,
  }) => {
    const base = {
      mountPath: '/oidc',
      rateLimit: resolveRateLimit(undefined),
      adminEnabled: true,
      adminApiEnabled: false,
      consoleNeedsLoginUrl: true,
    };
    setAuthHostConfig(base);
    assert.doesNotThrow(() => registerAuthHost(fakeRouter(), { accountLoginUrl: '/login' }));
    setAuthHostConfig({ ...base, routes: { accountLoginUrl: '/login' } });
    assert.doesNotThrow(() => registerAuthHost(fakeRouter()));
    resetAccountLoginUrl();
  });

  test('sem opts: lê mountPath/social/admin/adminApi do config stashado no boot', ({ assert }) => {
    setAuthHostConfig({
      mountPath: '/oidc',
      social: { providers: ['google'] },
      rateLimit: resolveRateLimit(undefined),
      adminEnabled: true,
      adminApiEnabled: true,
    });

    const router = fakeRouter();
    // Chamada mínima — tudo vem do config (zero duplicação no routes.ts).
    registerAuthHost(router);

    assert.isTrue(
      router.routes.some((r: any) => r.pattern === '/oidc/*'),
      'mountPath do config',
    );
    assert.isTrue(
      router.routes.some((r: any) => r.pattern === '/auth/:provider/redirect/:uid'),
      'social montado pelo config',
    );
    assert.isTrue(
      router.routes.some((r: any) => r.pattern === '/admin/*'),
      'console admin montado pq config.admin.enabled',
    );
    // adminApi usa .group().prefix() — o prefixo fica em groupPrefixes, não no pattern.
    assert.include(
      router.groupPrefixes,
      '/api/authkit/v1',
      'admin API montada pq config.adminApi.enabled',
    );
  });

  test('config desligado: admin/adminApi/social NÃO são montados', ({ assert }) => {
    setAuthHostConfig({
      mountPath: '/oidc',
      social: undefined,
      rateLimit: resolveRateLimit(undefined),
      adminEnabled: false,
      adminApiEnabled: false,
    });
    const router = fakeRouter();
    registerAuthHost(router);
    assert.isFalse(router.routes.some((r: any) => r.pattern === '/admin/*'));
    assert.isFalse(router.routes.some((r: any) => r.pattern === '/auth/:provider/callback'));
  });

  test('opts fazem override do config (prefix custom do admin)', ({ assert }) => {
    setAuthHostConfig({
      mountPath: '/oidc',
      rateLimit: resolveRateLimit(undefined),
      adminEnabled: true,
      adminApiEnabled: false,
    });
    const router = fakeRouter();
    registerAuthHost(router, { admin: { prefix: '/auth/admin' } });
    assert.isTrue(
      router.routes.some((r: any) => r.pattern === '/auth/admin/*'),
      'prefix do opts vence',
    );
    assert.isFalse(router.routes.some((r: any) => r.pattern === '/admin/*'));
  });

  test('sem stash e sem opts: cai no default /oidc (fallback seguro)', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router);
    assert.isTrue(
      router.routes.some((r: any) => r.pattern === '/oidc/*'),
      'default /oidc',
    );
  });
});

test.group('registerAuthHost — montagem por tela do console de conta', (group) => {
  // Reseta o singleton de accountLoginUrl e o stash de config entre casos:
  // são estado de processo e vazariam de um teste para o outro.
  group.each.teardown(() => {
    resetAccountLoginUrl();
    resetAuthHostConfig();
  });

  const has = (router: any, pattern: string, method?: string) =>
    router.routes.some((r: any) => r.pattern === pattern && (!method || r.method === method));

  test('default (sem account): monta TODAS as telas (back-compat)', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    assert.isTrue(has(router, '/account/login'), 'login montado');
    assert.isTrue(has(router, '/account/tokens'), 'tokens montado');
    assert.isTrue(has(router, '/account/security'), 'security montado');
    assert.isTrue(has(router, '/account/mfa'), 'mfa montado');
    assert.isTrue(has(router, '/account/apps'), 'apps montado');
    assert.isTrue(has(router, '/account/orgs'), 'orgs montado');
    assert.isTrue(has(router, '/account/email/confirm'), 'email/confirm montado');
    // Confirm (sudo) e a JSON API continuam sempre montados.
    assert.isTrue(has(router, '/account/confirm'), 'confirm sempre montado');
    assert.isTrue(has(router, '/account/api/me'), 'account api sempre montada');
  });

  test('account: false desmonta TODAS as telas (confirm + api permanecem)', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', account: false });
    assert.isFalse(has(router, '/account/login'), 'login desmontado');
    assert.isFalse(has(router, '/account/tokens'), 'tokens desmontado');
    assert.isFalse(has(router, '/account/security'), 'security desmontado');
    assert.isFalse(has(router, '/account/mfa'), 'mfa desmontado');
    assert.isFalse(has(router, '/account/apps'), 'apps desmontado');
    assert.isFalse(has(router, '/account/orgs'), 'orgs desmontado');
    assert.isFalse(has(router, '/account/email/confirm'), 'email/confirm desmontado');
    assert.isFalse(
      has(router, '/account/orgs/invitations/:token/accept'),
      'accept de convite desmontado com orgs',
    );
    // Infra continua.
    assert.isTrue(has(router, '/account/confirm'), 'confirm permanece');
    assert.isTrue(has(router, '/account/api/me'), 'account api permanece');
  });

  test('account: { login: false } desmonta só o login', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', account: { login: false } });
    assert.isFalse(has(router, '/account/login'), 'login desmontado');
    assert.isFalse(has(router, '/account/logout'), 'logout desmontado junto');
    assert.isTrue(has(router, '/account/security'), 'security segue montado');
    assert.isTrue(has(router, '/account/tokens'), 'tokens segue montado');
  });

  test('account: { tokens: false } desmonta só os tokens', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', account: { tokens: false } });
    assert.isFalse(has(router, '/account/tokens'), 'tokens desmontado');
    assert.isFalse(has(router, '/account/tokens/:id/revoke'), 'revoke desmontado');
    assert.isTrue(has(router, '/account/login'), 'login segue montado');
    assert.isTrue(has(router, '/account/security'), 'security segue montado');
  });

  test('account: { orgs: false } desmonta orgs (incl. accept público)', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', account: { orgs: false } });
    assert.isFalse(has(router, '/account/orgs'), 'orgs desmontado');
    assert.isFalse(
      has(router, '/account/orgs/invitations/:token/accept'),
      'accept de convite desmontado',
    );
    assert.isTrue(has(router, '/account/security'), 'security segue montado');
  });

  test('account: { security: false } desmonta security + email/confirm', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', account: { security: false } });
    assert.isFalse(has(router, '/account/security'), 'security desmontado');
    assert.isFalse(has(router, '/account/security/export'), 'export desmontado');
    assert.isFalse(has(router, '/account/email/confirm'), 'email/confirm desmontado junto');
    assert.isTrue(has(router, '/account/mfa'), 'mfa segue montado');
  });

  test('account: { mfa: false } desmonta só o mfa', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', account: { mfa: false } });
    assert.isFalse(has(router, '/account/mfa'), 'mfa desmontado');
    assert.isFalse(has(router, '/account/mfa/passkeys/options'), 'passkeys desmontado');
    assert.isTrue(has(router, '/account/security'), 'security segue montado');
  });

  test('account: { apps: false } desmonta só os apps', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', account: { apps: false } });
    assert.isFalse(has(router, '/account/apps'), 'apps desmontado');
    assert.isTrue(has(router, '/account/security'), 'security segue montado');
  });

  test('accountLoginUrl aponta o redirect de não-autenticado para a rota do host', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, {
      mountPath: '/oidc',
      account: { login: false },
      accountLoginUrl: '/login',
    });
    // O singleton de processo passa a devolver o destino configurado.
    assert.equal(getAccountLoginUrl(), '/login');
    // E a tela de login por senha da lib não é montada.
    assert.isFalse(has(router, '/account/login'));
  });

  test('sem accountLoginUrl: singleton mantém o default /account/login', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    assert.equal(getAccountLoginUrl(), '/account/login');
  });
});
