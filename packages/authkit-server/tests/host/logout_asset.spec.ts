import { existsSync, readFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from '@japa/runner';
import { resetAuthHostConfig } from '../../src/host/auth_host_config.js';
import LogoutAssetController, {
  resetLogoutAssetCache,
} from '../../src/host/controllers/logout_asset_controller.js';
import { registerAuthHost } from '../../src/host/register_auth_host.js';

const assetPath = fileURLToPath(new URL('../../src/host/assets/logout.js', import.meta.url));

/** Path público do asset — contrato entre a rota e o logoutSource. */
const ASSET_PATH = '/authkit/assets/logout.js';

/**
 * `HttpContext` mínimo para exercitar o controller. Captura o que foi enviado
 * em vez de mockar o response inteiro do Adonis.
 */
function fakeCtx() {
  const captured: {
    type?: string;
    headers: Record<string, string>;
    body?: unknown;
    status?: number;
  } = { headers: {} };

  const response: any = {
    type(t: string) {
      captured.type = t;
      return response;
    },
    header(k: string, v: string) {
      captured.headers[k] = v;
      return response;
    },
    send(b: unknown) {
      captured.body = b;
      return response;
    },
    notFound(b?: unknown) {
      captured.status = 404;
      captured.body = b;
      return response;
    },
  };

  return { ctx: { response } as any, captured };
}

test.group('logout asset (auto-submit CSP-safe do RP-initiated logout)', (group) => {
  group.each.setup(() => {
    resetLogoutAssetCache();
    return () => resetLogoutAssetCache();
  });

  test('o asset existe e contém o auto-submit do form op.logoutForm', ({ assert }) => {
    assert.isTrue(
      existsSync(assetPath),
      'src/host/assets/logout.js não existe — o logoutSource depende dele',
    );
    const code = readFileSync(assetPath, 'utf8');
    assert.include(code, 'op.logoutForm');
    assert.include(code, 'submit');
  });

  test('serve o asset com content-type text/javascript e cache imutável', async ({ assert }) => {
    const { ctx, captured } = fakeCtx();
    await new LogoutAssetController().handle(ctx);

    assert.equal(captured.type, 'text/javascript');
    assert.equal(captured.headers['Cache-Control'], 'public, max-age=31536000, immutable');
    assert.isUndefined(captured.status, 'não deveria ter caído no 404');
    assert.isTrue(Buffer.isBuffer(captured.body));
    assert.include((captured.body as Buffer).toString('utf8'), 'op.logoutForm');
  });

  test('responde 404 limpo quando o asset não existe', async ({ assert }) => {
    const hidden = `${assetPath}.hidden-by-test`;
    renameSync(assetPath, hidden);
    try {
      resetLogoutAssetCache();
      const { ctx, captured } = fakeCtx();
      await new LogoutAssetController().handle(ctx);

      assert.equal(captured.status, 404);
      assert.isUndefined(captured.type, 'não deveria ter setado content-type');
      assert.isUndefined(captured.headers['Cache-Control']);
    } finally {
      renameSync(hidden, assetPath);
      resetLogoutAssetCache();
    }
  });

  test('a rota é pública, sem guard, e registrada antes do wildcard do provider', ({
    assert,
  }) => {
    resetAuthHostConfig();

    const routes: Array<{ method: string; pattern: string; middleware: unknown[]; name?: string }> =
      [];
    const mk = (method: string) => (pattern: string, handler?: unknown) => {
      const route = {
        method,
        pattern,
        middleware: [] as unknown[],
        handler,
        name: undefined as any,
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
    const groupChain: any = {
      as: () => groupChain,
      prefix: () => groupChain,
      middleware: () => groupChain,
      use: () => groupChain,
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
    };

    registerAuthHost(router);

    const route = routes.find((r) => r.pattern === ASSET_PATH);
    assert.isDefined(route, `rota ${ASSET_PATH} não registrada`);
    assert.equal(route!.method, 'GET');
    assert.lengthOf(route!.middleware, 0, 'o asset do splash de logout não pode ter guard');

    // Registrada antes do wildcard do provider OIDC — senão um mountPath
    // agressivo engole o asset e o auto-confirm do logout some sem aviso.
    const wildcard = routes.findIndex((r) => r.name === 'authkit.oidc.wildcard');
    assert.isBelow(routes.indexOf(route!), wildcard);
  });
});
