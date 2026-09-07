/**
 * `authkitCsrfExceptions` (src/host/csrf.ts) é o helper exportado para o host
 * excluir das checagens de `@adonisjs/shield` as rotas machine-to-machine do
 * IdP (token/introspection/userinfo/jwks/etc, todas sob `mountPath`). Sem essa
 * exclusão, `POST {mountPath}/token` recebe a negação HTML do CSRF em vez da
 * resposta JSON de token, e `exchangeCode()` no client quebra com
 * `SyntaxError: Unexpected token '<' ... is not valid JSON` — reproduzível
 * seguindo a doc de `registerAuthHost` ao pé da letra sob o `web` starter kit
 * (shield com CSRF ligado por default).
 *
 * Este teste NÃO hardcoda os padrões de rota: ele chama o `registerAuthHost`
 * de verdade contra um router fake e lê as rotas REALMENTE registradas, para
 * que o helper não possa silenciosamente sair de sincronia com o que o host
 * kit efetivamente monta.
 */
import { test } from '@japa/runner';
import { resetAccountLoginUrl } from '../../src/host/account_login_url.js';
import { resetAccountPaths } from '../../src/host/account_paths.js';
import { resetAuthHostConfig } from '../../src/host/auth_host_config.js';
import { authkitCsrfExceptions } from '../../src/host/csrf.js';
import { registerAuthHost } from '../../src/host/register_auth_host.js';

function fakeRouter() {
  const routes: Array<{ method: string; pattern: string }> = [];
  const mk = (method: string) => (pattern: string, _handler?: unknown) => {
    routes.push({ method, pattern });
    const chain: any = {
      as: () => chain,
      middleware: () => chain,
      use: () => chain,
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

/** Concretiza um pattern de rota do router (`:uid` etc) num path de exemplo. */
function exampleUrl(pattern: string): string {
  return pattern.replace(/:[a-zA-Z]+/g, 'x').replace(/\*$/, 'token');
}

test.group('authkitCsrfExceptions — cobre exatamente o que registerAuthHost monta', (group) => {
  group.each.teardown(resetProcessState);

  test('toda rota sob o mountPath (o wildcard ANY do provider OIDC) é exempted', ({ assert }) => {
    const router = fakeRouter();
    const map = registerAuthHost(router, { mountPath: '/oidc' });
    assert.equal(map.mountPath, '/oidc');

    const oidcRoutes = router.routes.filter(
      (r: any) => r.pattern === '/oidc' || r.pattern.startsWith('/oidc/'),
    );
    assert.isAbove(oidcRoutes.length, 0, 'sanidade: o provider tem de montar rotas sob /oidc');

    for (const route of oidcRoutes) {
      const url = exampleUrl(route.pattern);
      assert.isTrue(
        authkitCsrfExceptions(url, { mountPath: '/oidc' }),
        `${route.method} ${route.pattern} (ex.: ${url}) deveria ser exempted de CSRF`,
      );
    }
  });

  test('honra um mountPath customizado', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/sso' });

    const oidcRoutes = router.routes.filter(
      (r: any) => r.pattern === '/sso' || r.pattern.startsWith('/sso/'),
    );
    assert.isAbove(oidcRoutes.length, 0);
    for (const route of oidcRoutes) {
      assert.isTrue(authkitCsrfExceptions(exampleUrl(route.pattern), { mountPath: '/sso' }));
    }
    // E não isenta o mountPath default quando o host customizou.
    assert.isFalse(authkitCsrfExceptions('/oidc/token', { mountPath: '/sso' }));
  });

  test('as telas interativas (login/consent/signup) continuam SOB CSRF', ({ assert }) => {
    const router = fakeRouter();
    registerAuthHost(router, { mountPath: '/oidc' });

    const interactiveRoutes = router.routes.filter(
      (r: any) =>
        r.pattern.startsWith('/auth/interaction/') || r.pattern === '/auth/forgot-password',
    );
    assert.isAbove(interactiveRoutes.length, 0);

    for (const route of interactiveRoutes) {
      const url = exampleUrl(route.pattern);
      assert.isFalse(
        authkitCsrfExceptions(url, { mountPath: '/oidc' }),
        `${route.method} ${route.pattern} (ex.: ${url}) NÃO deveria ser exempted — é um POST de browser com sessão`,
      );
    }
  });

  test('introspecção de PAT é exempted (machine-to-machine, sem sessão de browser)', ({
    assert,
  }) => {
    assert.isTrue(authkitCsrfExceptions('/authkit/pat/introspect', { mountPath: '/oidc' }));
  });

  test('back-channel logout do client é exempted por default, e desligável', ({ assert }) => {
    assert.isTrue(authkitCsrfExceptions('/auth/backchannel-logout', { mountPath: '/oidc' }));
    assert.isFalse(
      authkitCsrfExceptions('/auth/backchannel-logout', {
        mountPath: '/oidc',
        backchannelLogoutPath: false,
      }),
    );
  });

  test('uma rota qualquer do app do host não é afetada', ({ assert }) => {
    assert.isFalse(authkitCsrfExceptions('/dashboard', { mountPath: '/oidc' }));
    assert.isFalse(authkitCsrfExceptions('/api/orders', { mountPath: '/oidc' }));
  });
});
