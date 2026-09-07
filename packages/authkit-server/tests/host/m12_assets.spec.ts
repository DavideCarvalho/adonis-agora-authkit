import { existsSync, readFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from '@japa/runner';
import { resetAuthHostConfig } from '../../src/host/auth_host_config.js';
import PasskeyAutofillAssetController, {
  resetPasskeyAutofillAssetCache,
} from '../../src/host/controllers/passkey_autofill_asset_controller.js';
import PasskeyButtonAssetController, {
  resetPasskeyButtonAssetCache,
} from '../../src/host/controllers/passkey_button_asset_controller.js';
import PasskeyRegisterAssetController, {
  resetPasskeyRegisterAssetCache,
} from '../../src/host/controllers/passkey_register_asset_controller.js';
import SubmitLockAssetController, {
  resetSubmitLockAssetCache,
} from '../../src/host/controllers/submit_lock_asset_controller.js';
import WebauthnConfirmAssetController, {
  resetWebauthnConfirmAssetCache,
} from '../../src/host/controllers/webauthn_confirm_asset_controller.js';
import { registerAuthHost } from '../../src/host/register_auth_host.js';

/**
 * M12 (auditoria de segurança): estes cinco assets substituem o
 * `<script>`/`<script type="module">` INLINE que `login.edge`,
 * `mfa-challenge.edge`, `account/confirm.edge`, `account/mfa.edge` e
 * `partials/submit_lock.edge` embutiam — bloqueado por CSP `script-src
 * 'self'` sem nonce/hash, mesma classe do bug do splash de logout (`0.61.3`).
 *
 * Cada asset segue o padrão EXATO de `logout_asset_controller.ts`/
 * `webauthn_asset_controller.ts` (agora fatorado em
 * `static_asset_controller.ts`): rota pública sem guard, registrada ANTES do
 * wildcard do provider OIDC, cache imutável, 404 limpo quando o arquivo falta.
 * Este spec cobre os cinco de uma vez, parametrizado, em vez de repetir os
 * ~90 asserts de `webauthn_asset.spec.ts`/`logout_asset.spec.ts` cinco vezes.
 */
const ASSETS = [
  {
    name: 'passkey_autofill.js',
    routePath: '/authkit/assets/passkey_autofill.js',
    Controller: PasskeyAutofillAssetController,
    resetCache: resetPasskeyAutofillAssetCache,
    contains: 'autofill-passkey-form',
    views: ['login.edge'],
  },
  {
    name: 'passkey_button.js',
    routePath: '/authkit/assets/passkey_button.js',
    Controller: PasskeyButtonAssetController,
    resetCache: resetPasskeyButtonAssetCache,
    contains: 'passkey-button',
    views: ['login.edge', 'mfa-challenge.edge'],
  },
  {
    name: 'passkey_register.js',
    routePath: '/authkit/assets/passkey_register.js',
    Controller: PasskeyRegisterAssetController,
    resetCache: resetPasskeyRegisterAssetCache,
    contains: 'passkey-add',
    views: ['account/mfa.edge'],
  },
  {
    name: 'webauthn_confirm.js',
    routePath: '/authkit/assets/webauthn_confirm.js',
    Controller: WebauthnConfirmAssetController,
    resetCache: resetWebauthnConfirmAssetCache,
    contains: 'data-authkit-webauthn',
    views: ['account/confirm.edge'],
  },
  {
    name: 'submit_lock.js',
    routePath: '/authkit/assets/submit_lock.js',
    Controller: SubmitLockAssetController,
    resetCache: resetSubmitLockAssetCache,
    contains: 'aria-busy',
    views: ['partials/submit_lock.edge'],
  },
] as const;

const viewsDir = fileURLToPath(new URL('../../src/host/views/', import.meta.url));
const read = (p: string) => readFileSync(viewsDir + p, 'utf8');

/** `HttpContext` mínimo — mesma forma usada em `logout_asset.spec.ts`/`webauthn_asset.spec.ts`. */
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

/** Router fake — mesma forma usada em `logout_asset.spec.ts`. */
function fakeRouter() {
  const routes: Array<{ method: string; pattern: string; middleware: unknown[]; name?: string }> =
    [];
  const mk = (method: string) => (pattern: string, handler?: unknown) => {
    const route = { method, pattern, middleware: [] as unknown[], handler, name: undefined as any };
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
  return { router, routes };
}

for (const asset of ASSETS) {
  test.group(`M12 asset: ${asset.name}`, (group) => {
    group.each.setup(() => {
      asset.resetCache();
      return () => asset.resetCache();
    });

    const assetPath = fileURLToPath(
      new URL(`../../src/host/assets/${asset.name}`, import.meta.url),
    );

    test(`o asset existe e contém "${asset.contains}"`, ({ assert }) => {
      assert.isTrue(
        existsSync(assetPath),
        `src/host/assets/${asset.name} não existe — a view depende dele`,
      );
      const code = readFileSync(assetPath, 'utf8');
      assert.include(code, asset.contains);
    });

    test('serve o asset com content-type text/javascript e cache imutável', async ({ assert }) => {
      const { ctx, captured } = fakeCtx();
      await new asset.Controller().handle(ctx);

      assert.equal(captured.type, 'text/javascript');
      assert.equal(captured.headers['Cache-Control'], 'public, max-age=31536000, immutable');
      assert.isUndefined(captured.status, 'não deveria ter caído no 404');
      assert.isTrue(Buffer.isBuffer(captured.body));
      assert.include((captured.body as Buffer).toString('utf8'), asset.contains);
    });

    test('responde 404 limpo quando o asset não existe', async ({ assert }) => {
      const hidden = `${assetPath}.hidden-by-test`;
      renameSync(assetPath, hidden);
      try {
        asset.resetCache();
        const { ctx, captured } = fakeCtx();
        await new asset.Controller().handle(ctx);

        assert.equal(captured.status, 404);
        assert.isUndefined(captured.type, 'não deveria ter setado content-type');
        assert.isUndefined(captured.headers['Cache-Control']);
      } finally {
        renameSync(hidden, assetPath);
        asset.resetCache();
      }
    });

    test('a rota é pública, sem guard, e registrada antes do wildcard do provider', ({
      assert,
    }) => {
      resetAuthHostConfig();
      const { router, routes } = fakeRouter();
      registerAuthHost(router);

      const route = routes.find((r) => r.pattern === asset.routePath);
      assert.isDefined(route, `rota ${asset.routePath} não registrada`);
      assert.equal(route!.method, 'GET');
      assert.lengthOf(route!.middleware, 0, `${asset.name} não pode ter guard`);

      const wildcard = routes.findIndex((r) => r.name === 'authkit.oidc.wildcard');
      assert.isBelow(routes.indexOf(route!), wildcard);
    });

    test('as views que dependem do asset o referenciam por `src` same-origin', ({ assert }) => {
      for (const view of asset.views) {
        assert.include(read(view), asset.routePath, `${view} não importa ${asset.routePath}`);
      }
    });
  });
}
