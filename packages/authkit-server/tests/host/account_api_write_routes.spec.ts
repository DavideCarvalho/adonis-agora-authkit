/**
 * MONTAGEM das rotas de escrita do `/account/api/*` (orgs + segundo fator).
 *
 * Este spec não exercita handler nenhum: ele olha o que o `registerAuthHost`
 * REALMENTE registra, porque três propriedades do espelho JSON são do roteador,
 * não do controller —
 *
 *   1. as rotas existem, com o verbo certo e sob o prefixo do console;
 *   2. ORDEM: segmento fixo antes de paramétrico (`/orgs/deactivate` antes de
 *      `/orgs/:id/activate`, `/orgs/invitations/:token/accept` antes de
 *      `/orgs/:id/...`) — invertido, o Adonis casa `deactivate` como `:id`;
 *   3. elas NÃO entram nas isenções de CSRF: são POSTs de browser com sessão,
 *      exatamente como os formulários que espelham;
 *   4. elas continuam montadas com as TELAS do console desligadas — é o modo
 *      headless (host com telas próprias), o caso de uso que motivou tudo isto.
 */

import { test } from '@japa/runner';
import { resetAccountLoginUrl } from '../../src/host/account_login_url.js';
import { resetAccountPaths } from '../../src/host/account_paths.js';
import { resetAuthHostConfig } from '../../src/host/auth_host_config.js';
import { authkitCsrfExceptions } from '../../src/host/csrf.js';
import { registerAuthHost } from '../../src/host/register_auth_host.js';

interface FakeRoute {
  method: string;
  pattern: string;
  middleware: unknown[];
}

function fakeRouter() {
  const routes: FakeRoute[] = [];
  const mk = (method: string) => (pattern: string, _handler?: unknown) => {
    const route: FakeRoute = { method, pattern, middleware: [] };
    routes.push(route);
    const chain: any = {
      as: () => chain,
      middleware: () => chain,
      use: (m: unknown) => {
        route.middleware.push(...(Array.isArray(m) ? m : [m]));
        return chain;
      },
    };
    return chain;
  };
  const groupChain: any = {
    as: () => groupChain,
    prefix: () => groupChain,
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
  } as any;
}

function resetProcessState() {
  resetAuthHostConfig();
  resetAccountPaths();
  resetAccountLoginUrl();
}

/** Índice do pattern na ordem de registro (-1 quando não registrado). */
function indexOf(routes: FakeRoute[], method: string, pattern: string): number {
  return routes.findIndex((r) => r.method === method && r.pattern === pattern);
}

const ORG_WRITE_ROUTES: Array<[string, string]> = [
  ['POST', '/account/api/orgs'],
  ['POST', '/account/api/orgs/deactivate'],
  ['POST', '/account/api/orgs/invitations/:token/accept'],
  ['POST', '/account/api/orgs/:id/activate'],
  ['POST', '/account/api/orgs/:id/leave'],
  ['POST', '/account/api/orgs/:id/invitations'],
  ['DELETE', '/account/api/orgs/:id/invitations/:invId'],
  ['PATCH', '/account/api/orgs/:id/members/:accountId'],
  ['DELETE', '/account/api/orgs/:id/members/:accountId'],
];

const MFA_WRITE_ROUTES: Array<[string, string]> = [
  ['POST', '/account/api/mfa/totp/enroll'],
  ['POST', '/account/api/mfa/totp/confirm'],
  ['POST', '/account/api/mfa/totp/disable'],
  ['POST', '/account/api/mfa/recovery-codes'],
  ['POST', '/account/api/mfa/passkeys/options'],
  ['POST', '/account/api/mfa/passkeys/verify'],
];

test.group('registerAuthHost — escritas JSON de /account/api/*', (group) => {
  group.each.teardown(resetProcessState);

  test('todas as rotas de escrita de org estão registradas', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    for (const [method, pattern] of ORG_WRITE_ROUTES) {
      assert.isAbove(
        indexOf(router.routes, method, pattern),
        -1,
        `${method} ${pattern} não foi registrada`,
      );
    }
  });

  test('todas as rotas de segundo fator estão registradas', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    for (const [method, pattern] of MFA_WRITE_ROUTES) {
      assert.isAbove(
        indexOf(router.routes, method, pattern),
        -1,
        `${method} ${pattern} não foi registrada`,
      );
    }
  });

  test('segmento FIXO antes do paramétrico (senão `deactivate` casa como `:id`)', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });
    const r = router.routes as FakeRoute[];

    assert.isBelow(
      indexOf(r, 'POST', '/account/api/orgs/deactivate'),
      indexOf(r, 'POST', '/account/api/orgs/:id/activate'),
    );
    assert.isBelow(
      indexOf(r, 'POST', '/account/api/orgs/invitations/:token/accept'),
      indexOf(r, 'POST', '/account/api/orgs/:id/activate'),
    );
  });

  test('nenhuma delas é isenta de CSRF (são POSTs de browser com sessão)', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });

    for (const [method, pattern] of [...ORG_WRITE_ROUTES, ...MFA_WRITE_ROUTES]) {
      const url = pattern.replace(/:[a-zA-Z]+/g, 'x');
      assert.isFalse(
        authkitCsrfExceptions(url, { mountPath: '/oidc' }),
        `${method} ${pattern} (ex.: ${url}) NÃO pode ser isenta de CSRF`,
      );
    }
  });

  test('o confirm de TOTP leva o throttle do bucket de sudo', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', rateLimit: true } as any);
    const confirm = (router.routes as FakeRoute[]).find(
      (r) => r.method === 'POST' && r.pattern === '/account/api/mfa/totp/confirm',
    );
    assert.exists(confirm);
    assert.isAbove(
      confirm?.middleware.length ?? 0,
      0,
      'o código TOTP é de 6 dígitos: sem throttle, uma sessão viva basta para adivinhá-lo',
    );
  });

  test('seguem montadas com as TELAS do console desligadas (modo headless)', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', account: { orgs: false, mfa: false } });
    const r = router.routes as FakeRoute[];

    // A tela HTML sumiu…
    assert.equal(indexOf(r, 'POST', '/account/orgs'), -1);
    // …e o espelho JSON continua lá, que é o ponto do modo headless.
    for (const [method, pattern] of [...ORG_WRITE_ROUTES, ...MFA_WRITE_ROUTES]) {
      assert.isAbove(
        indexOf(r, method, pattern),
        -1,
        `${method} ${pattern} sumiu junto com a tela — o host com telas próprias fica sem API`,
      );
    }
  });

  test('honra o prefixo customizado do console de conta', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc', accountRoutes: { prefix: '/minha-conta' } });
    const r = router.routes as FakeRoute[];
    assert.isAbove(indexOf(r, 'POST', '/minha-conta/api/orgs'), -1);
    assert.isAbove(indexOf(r, 'POST', '/minha-conta/api/mfa/totp/enroll'), -1);
  });
});
