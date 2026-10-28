import { test } from '@japa/runner';
import { registerAuthHost } from '../../src/host/register_auth_host.js';

/**
 * `POST /auth/interaction/:uid/identifier` é a PORTA DE ENTRADA do login: recebe só o
 * e-mail e abre/avança a interaction. Até 2026-10-28 era a única rota do fluxo sem
 * throttle — o `/magic` (que envia o e-mail) já tinha, o passo anterior não.
 *
 * A consequência não é força bruta (o fluxo é passwordless) nem enumeração (a resposta é
 * uniforme): é criação ilimitada de estado de interaction, que vive no store de sessão,
 * por um anônimo.
 *
 * Este spec trava três coisas: o vínculo com o bucket `login` (por IP), a precedência de
 * política (`opts.rateLimit` não vence o `defineConfig`) e o escape hatch que a lib
 * passou a oferecer — `routes`/`urls` no mapa e `extraMiddleware` por rota.
 */
test.group('interaction — throttle e escape hatch do host', () => {
  /** Router falso que guarda, por rota, as chamadas de `use`. */
  function throttleTrackingRouter() {
    const routes = new Map<string, { uses: unknown[][] }>();
    const groupChain: any = {
      as: () => groupChain,
      prefix: () => groupChain,
      middleware: () => groupChain,
      use: () => groupChain,
    };
    const mk = (verb: string) => (pattern: string) => {
      const entry = { uses: [] as unknown[][] };
      routes.set(`${verb} ${pattern}`, entry);
      const chain: any = {
        as: () => chain,
        middleware: () => chain,
        prefix: () => chain,
        use: (m: unknown[]) => {
          entry.uses.push(m);
          return chain;
        },
      };
      return chain;
    };
    return {
      get: mk('GET'),
      post: mk('POST'),
      patch: mk('PATCH'),
      put: mk('PUT'),
      delete: mk('DELETE'),
      any: mk('ANY'),
      group: (cb: () => void) => {
        cb();
        return groupChain;
      },
      routes,
    } as any;
  }

  test('o POST que recebe o e-mail leva o throttle de login', ({ assert }) => {
    const router = throttleTrackingRouter();
    const map = registerAuthHost(router, { mountPath: '/oidc' });

    const identifier = router.routes.get('POST /auth/interaction/:uid/identifier');
    assert.isDefined(identifier, 'a rota do identifier precisa existir');
    assert.isAbove(identifier!.uses.length, 0, 'o identifier precisa de throttle');
    assert.isDefined(map.routes.identifier, 'o handle da rota precisa sair no mapa');
  });

  test('identifier e magic compartilham o MESMO bucket (login, por IP)', ({ assert }) => {
    const router = throttleTrackingRouter();
    registerAuthHost(router, { mountPath: '/oidc' });

    const identifier = router.routes.get('POST /auth/interaction/:uid/identifier')!;
    const magic = router.routes.get('POST /auth/interaction/:uid/magic')!;

    // Mesma instância de middleware = mesmo bucket/namespace no limiter.
    assert.strictEqual(identifier.uses[0][0], magic.uses[0][0]);
  });

  test('extraMiddleware de uma rota não vaza para as outras', ({ assert }) => {
    const router = throttleTrackingRouter();
    registerAuthHost(router, {
      mountPath: '/oidc',
      extraMiddleware: { identifier: [async () => {}] },
    });

    const identifier = router.routes.get('POST /auth/interaction/:uid/identifier')!;
    const magic = router.routes.get('POST /auth/interaction/:uid/magic')!;

    assert.lengthOf(identifier.uses, 2, 'throttle da lib + middleware do host');
    assert.lengthOf(magic.uses, 1, 'só o throttle da lib');
  });

  test('extraMiddleware do host entra DEPOIS do throttle da lib', ({ assert }) => {
    const router = throttleTrackingRouter();
    const meuThrottle = async () => {};

    registerAuthHost(router, {
      mountPath: '/oidc',
      extraMiddleware: { identifier: [meuThrottle] },
    });

    const identifier = router.routes.get('POST /auth/interaction/:uid/identifier')!;
    assert.lengthOf(identifier.uses, 2, 'throttle da lib + middleware do host');
    assert.strictEqual(identifier.uses[1][0], meuThrottle);
  });

  test('o passo de opções de passkey também leva o throttle de login', ({ assert }) => {
    const router = throttleTrackingRouter();
    registerAuthHost(router, { mountPath: '/oidc' });

    const options = router.routes.get('POST /auth/interaction/:uid/passkey/options')!;
    const identifier = router.routes.get('POST /auth/interaction/:uid/identifier')!;

    // Mesma classe do identifier: anônimo que cria estado, no bucket `login`.
    assert.isAbove(options.uses.length, 0, 'passkey/options precisa de throttle');
    assert.strictEqual(options.uses[0][0], identifier.uses[0][0]);
  });

  test('routes/urls expõem o fluxo para o host (href sem hardcode)', ({ assert }) => {
    const router = throttleTrackingRouter();
    const map = registerAuthHost(router, { mountPath: '/oidc' });

    assert.equal(map.urls.identifier, '/auth/interaction/:uid/identifier');
    assert.equal(map.urls.magic, '/auth/interaction/:uid/magic');
    assert.isDefined(map.routes.magic);
    assert.isDefined(map.routes.consent);
    assert.equal(map.interactionUrl('magic', 'abc-123'), '/auth/interaction/abc-123/magic');
  });
});
