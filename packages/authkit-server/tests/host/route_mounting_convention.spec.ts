/**
 * A convenção de montagem de rotas (plano 015): config E função, com uma regra
 * de precedência.
 *
 * R1 — o caminho automático É o caminho manual (`config.routes` chama a função
 *      exportada, sem segunda implementação).
 * R2 — argumento omitido HERDA do config; não zera.
 * R3 — precedência partida por espécie: política → config vence e trava;
 *      estrutural → argumento vence.
 * R4 — devolve o mapa de rotas resolvido.
 */

import { test } from '@japa/runner';
import { resolveRateLimit } from '../../src/define_config.js';
import { resetAccountLoginUrl } from '../../src/host/account_login_url.js';
import { resetAccountPaths } from '../../src/host/account_paths.js';
import { resetAuthHostConfig, setAuthHostConfig } from '../../src/host/auth_host_config.js';
import { deriveLockedRouteOptions } from '../../src/host/config_locks.js';
import { autoMountAuthHost, registerAuthHost } from '../../src/host/register_auth_host.js';
import { magicLink } from '../../src/host/sudo/methods/magic_link.js';
import { passkey } from '../../src/host/sudo/methods/passkey.js';
import { password } from '../../src/host/sudo/methods/password.js';

/**
 * Router falso mínimo. Espelha o de `register_auth_host.spec.ts`; os métodos de
 * sudo registram através de um Proxy sobre ELE (`guardSudoRoutes`), então
 * precisa aceitar handler-função também.
 */
function fakeRouter() {
  const routes: Array<{ method: string; pattern: string; name?: string }> = [];
  const groupPrefixes: string[] = [];

  const mk = (method: string) => (pattern: string, _handler?: unknown) => {
    const route = { method, pattern, name: undefined as string | undefined };
    routes.push(route);
    const chain: any = {
      as: (n: string) => {
        route.name = n;
        return chain;
      },
      middleware: () => chain,
      use: () => chain,
    };
    return chain;
  };

  const groupChain: any = {
    as: () => groupChain,
    prefix: (p: string) => {
      groupPrefixes.push(p);
      return groupChain;
    },
    middleware: () => groupChain,
    use: () => groupChain,
  };

  return {
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
    groupPrefixes,
  } as any;
}

const has = (router: any, pattern: string, method?: string) =>
  router.routes.some((r: any) => r.pattern === pattern && (!method || r.method === method));

/** Reseta TODO o estado de processo que `registerAuthHost` escreve. */
function resetProcessState() {
  resetAuthHostConfig();
  resetAccountPaths();
  resetAccountLoginUrl();
}

const baseStash = {
  mountPath: '/oidc',
  rateLimit: resolveRateLimit(undefined),
  adminEnabled: false,
  adminApiEnabled: false,
};

// ───────────────────────────────────────────────────────────────────────────
// R2 — argumento omitido herda do config
// ───────────────────────────────────────────────────────────────────────────

test.group('R2 — argumento omitido herda do config', (group) => {
  group.each.teardown(resetProcessState);

  test('sudoMethods vem de config.sudo.methods quando a chamada só troca o prefixo', ({
    assert,
  }) => {
    // A dor do consumidor: `sudoMethods` tinha de ser declarado DUAS vezes —
    // em `config/authkit.ts` (o que a tela oferece) e em `registerAuthHost` (o
    // que tem rota) — e divergir gerava flag-drift + 404.
    setAuthHostConfig({ ...baseStash, sudoMethods: [magicLink()] });

    const router = fakeRouter();
    // Só uma chave ESTRUTURAL passada. `sudoMethods` omitido → herda do config.
    const map = registerAuthHost(router, { accountRoutes: { prefix: '/conta' } });

    assert.isTrue(
      has(router, '/conta/confirm/magic-link', 'POST'),
      'a rota do método configurado tem de estar montada',
    );
    assert.deepEqual(map.sudoMethods, ['magic-link']);
    // E os defaults históricos NÃO são montados por cima.
    assert.isFalse(has(router, '/conta/confirm/passkey/options', 'POST'));
  });

  test('sem config.sudo.methods e sem argumento: defaults históricos (password + passkey)', ({
    assert,
  }) => {
    const router = fakeRouter();
    const map = registerAuthHost(router);
    assert.deepEqual(map.sudoMethods, ['password', 'passkey']);
  });

  test('estruturais (account/accountRoutes/accountLoginUrl) herdam de config.routes', ({
    assert,
  }) => {
    setAuthHostConfig({
      ...baseStash,
      routes: {
        accountRoutes: { prefix: '/conta', paths: { security: 'seguranca' } },
        account: { tokens: false },
        accountLoginUrl: '/entrar',
      },
    });

    const router = fakeRouter();
    const map = registerAuthHost(router);

    assert.isTrue(has(router, '/conta/seguranca', 'GET'), 'prefixo+segmento do config');
    assert.isFalse(has(router, '/conta/tokens', 'GET'), 'tela desmontada pelo config');
    assert.equal(map.account.loginUrl, '/entrar');
  });

  test('argumento estrutural vence o default estrutural do config', ({ assert }) => {
    setAuthHostConfig({ ...baseStash, routes: { accountRoutes: { prefix: '/conta' } } });

    const router = fakeRouter();
    const map = registerAuthHost(router, { accountRoutes: { prefix: '/perfil' } });

    assert.equal(map.account.prefix, '/perfil');
    assert.isTrue(has(router, '/perfil/security', 'GET'));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// R1 — o caminho automático É o caminho manual
// ───────────────────────────────────────────────────────────────────────────

test.group('R1 — auto-mount chama a função exportada', (group) => {
  group.each.teardown(resetProcessState);

  test('auto-mount e chamada manual montam EXATAMENTE o mesmo conjunto de rotas', ({ assert }) => {
    const stash = {
      ...baseStash,
      adminEnabled: true,
      adminApiEnabled: true,
      social: { providers: ['google'] as string[] },
      routes: { accountRoutes: { prefix: '/conta' } },
    };

    // App "config-only": o provider auto-monta.
    setAuthHostConfig(stash as any);
    const autoRouter = fakeRouter();
    autoMountAuthHost(autoRouter);
    const auto = autoRouter.routes.map((r: any) => `${r.method} ${r.pattern}`);

    // App "explícito": mesma config, chamada crua no start/routes.ts.
    resetProcessState();
    setAuthHostConfig(stash as any);
    const manualRouter = fakeRouter();
    registerAuthHost(manualRouter);
    const manual = manualRouter.routes.map((r: any) => `${r.method} ${r.pattern}`);

    assert.deepEqual(auto, manual);
    assert.isAbove(auto.length, 100, 'sanidade: o conjunto de rotas não pode estar vazio');
  });

  test('chamar registerAuthHost DEPOIS do auto-mount lança em vez de registrar duas vezes', ({
    assert,
  }) => {
    setAuthHostConfig({ ...baseStash });
    autoMountAuthHost(fakeRouter());

    assert.throws(() => registerAuthHost(fakeRouter()), /já ter montado as rotas automaticamente/);
  });

  test('sem auto-mount, chamadas manuais seguem livres (back-compat)', ({ assert }) => {
    assert.doesNotThrow(() => registerAuthHost(fakeRouter()));
    assert.doesNotThrow(() => registerAuthHost(fakeRouter()));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// R3 — precedência partida por espécie
// ───────────────────────────────────────────────────────────────────────────

test.group('R3 — política trava no config, estrutural vence pela função', (group) => {
  group.each.teardown(resetProcessState);

  test('deriveLockedRouteOptions trava só o que o defineConfig DECLARA', ({ assert }) => {
    assert.deepEqual(deriveLockedRouteOptions({}), []);
    assert.deepEqual(
      deriveLockedRouteOptions({
        social: { providers: ['google'] },
        rateLimit: {},
        sudo: { methods: [] },
        admin: { enabled: true },
        adminApi: { enabled: false },
      }),
      ['social', 'rateLimit', 'sudoMethods', 'admin', 'adminApi'],
    );
  });

  test('POLÍTICA: rateLimit do config vence — um routes.ts não desliga o throttle', ({
    assert,
  }) => {
    setAuthHostConfig({
      ...baseStash,
      rateLimit: resolveRateLimit({ enabled: true }),
      lockedRouteOptions: ['rateLimit'],
    });

    const router = fakeRouter();
    const map = registerAuthHost(router, { rateLimit: { enabled: false } });

    // O throttle continua aplicado (o fake não guarda middleware; o sinal é o
    // relatório de override, que só existe quando o argumento foi ignorado).
    assert.deepEqual(map.overriddenByConfig, ['rateLimit']);
  });

  test('POLÍTICA: social do config vence — um routes.ts não monta caminho de auth a mais', ({
    assert,
  }) => {
    setAuthHostConfig({ ...baseStash, social: undefined, lockedRouteOptions: ['social'] });

    const router = fakeRouter();
    const map = registerAuthHost(router, { social: { providers: ['google'] } });

    assert.isFalse(has(router, '/auth/:provider/callback', 'GET'), 'social NÃO montado');
    assert.deepEqual(map.overriddenByConfig, ['social']);
  });

  test('POLÍTICA: sudoMethods do config vence sobre a lista da chamada', ({ assert }) => {
    setAuthHostConfig({
      ...baseStash,
      sudoMethods: [magicLink()],
      lockedRouteOptions: ['sudoMethods'],
    });

    const router = fakeRouter();
    const map = registerAuthHost(router, { sudoMethods: [password(), passkey()] });

    assert.deepEqual(map.sudoMethods, ['magic-link']);
    assert.deepEqual(map.overriddenByConfig, ['sudoMethods']);
  });

  test('POLÍTICA: o liga/desliga de admin vem do config, mesmo com admin: true na chamada', ({
    assert,
  }) => {
    setAuthHostConfig({ ...baseStash, adminEnabled: false, lockedRouteOptions: ['admin'] });

    const router = fakeRouter();
    const map = registerAuthHost(router, { admin: true });

    assert.isNull(map.admin, 'console admin NÃO montado');
    assert.isFalse(has(router, '/admin/*', 'GET'));
    assert.deepEqual(map.overriddenByConfig, ['admin']);
  });

  test('ESTRUTURAL: o prefixo do admin continua vindo da chamada mesmo com admin travado', ({
    assert,
  }) => {
    // O eixo travado é o liga/desliga, NÃO o prefixo: onde as rotas moram é
    // decisão do ponto de chamada.
    setAuthHostConfig({ ...baseStash, adminEnabled: true, lockedRouteOptions: ['admin'] });

    const router = fakeRouter();
    const map = registerAuthHost(router, { admin: { prefix: '/painel' } });

    assert.deepEqual(map.admin, { prefix: '/painel' });
    assert.isTrue(has(router, '/painel/*', 'GET'));
    assert.isEmpty(map.overriddenByConfig, 'prefixo não é override de política');
  });

  test('ESTRUTURAL: mountPath e accountRoutes nunca travam', ({ assert }) => {
    setAuthHostConfig({
      ...baseStash,
      lockedRouteOptions: ['social', 'rateLimit', 'sudoMethods', 'admin', 'adminApi'],
    });

    const router = fakeRouter();
    const map = registerAuthHost(router, {
      mountPath: '/sso',
      accountRoutes: { prefix: '/conta' },
      accountLoginUrl: '/entrar',
      account: { mfa: false },
    });

    assert.equal(map.mountPath, '/sso');
    assert.isTrue(has(router, '/sso/*', 'ANY'));
    assert.equal(map.account.prefix, '/conta');
    assert.equal(map.account.loginUrl, '/entrar');
    assert.isFalse(map.account.screens.mfa);
    assert.isEmpty(map.overriddenByConfig);
  });

  test('sem lock no config, o argumento de política segue valendo (back-compat)', ({ assert }) => {
    // Nada declarado no defineConfig → nada travado → quem só configura pelo
    // routes.ts continua funcionando exatamente como antes.
    const router = fakeRouter();
    const map = registerAuthHost(router, { social: { providers: ['google'] }, admin: true });

    assert.isTrue(has(router, '/auth/:provider/callback', 'GET'));
    assert.deepEqual(map.admin, { prefix: '/admin' });
    assert.isEmpty(map.overriddenByConfig);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// R4 — o mapa resolvido
// ───────────────────────────────────────────────────────────────────────────

test.group('R4 — registerAuthHost devolve o mapa de rotas resolvido', (group) => {
  group.each.teardown(resetProcessState);

  test('overrides de path aparecem no mapa (é o que o frontend consome)', ({ assert }) => {
    const router = fakeRouter();
    const map = registerAuthHost(router, {
      accountRoutes: {
        prefix: '/conta',
        paths: { security: 'seguranca', confirm: 'confirmar', mfa: 'autenticacao' },
      },
    });

    assert.equal(map.account.prefix, '/conta');
    assert.equal(map.account.paths.security, '/conta/seguranca');
    assert.equal(map.account.paths.confirm, '/conta/confirmar');
    assert.equal(map.account.paths.mfa, '/conta/autenticacao');
    // Segmentos não sobrescritos mantêm o default, sob o novo prefixo.
    assert.equal(map.account.paths.tokens, '/conta/tokens');
    // A JSON API segue o prefixo com o segmento `api` FIXO.
    assert.equal(map.account.api, '/conta/api');
    // E o mapa casa com o que foi REALMENTE registrado.
    assert.isTrue(has(router, map.account.paths.security, 'GET'));
    assert.isTrue(has(router, `${map.account.api}/me`, 'GET'));
  });

  test('mapa default: prefixos, nomes e telas', ({ assert }) => {
    const router = fakeRouter();
    const map = registerAuthHost(router, { mountPath: '/oidc', adminApi: true });

    assert.equal(map.mountPath, '/oidc');
    assert.equal(map.account.prefix, '/account');
    assert.equal(map.account.loginUrl, '/account/login');
    assert.isNull(map.admin, 'admin não montado → null');
    assert.deepEqual(map.adminApi, { prefix: '/api/authkit/v1' });
    assert.equal(map.names.oidcWildcard, 'authkit.oidc.wildcard');
    // Os nomes do mapa têm de existir de fato no router.
    for (const name of Object.values(map.names)) {
      assert.isTrue(
        router.routes.some((r: any) => r.name === name),
        `rota nomeada "${name}" deve existir`,
      );
    }
    assert.deepEqual(map.account.screens, {
      login: true,
      tokens: true,
      orgs: true,
      security: true,
      mfa: true,
      apps: true,
    });
  });

  test('nomes do console admin só aparecem quando o console é montado', ({ assert }) => {
    const router = fakeRouter();
    const map = registerAuthHost(router, { admin: { prefix: '/painel' } });

    assert.deepEqual(map.admin, { prefix: '/painel' });
    assert.equal(map.names.consoleShell, 'authkit_console_shell');
    for (const name of Object.values(map.names)) {
      assert.isTrue(
        router.routes.some((r: any) => r.name === name),
        `rota nomeada "${name}" deve existir`,
      );
    }
  });
});
