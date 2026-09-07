import type { HttpContext } from '@adonisjs/core/http';
import { createStaticAssetHandler } from './static_asset_controller.js';

/** Ver o docblock de `passkey_autofill_asset_controller.ts` sobre `import.meta.url`. */
const ASSET_URL = new URL('../assets/passkey_register.js', import.meta.url);

const handler = createStaticAssetHandler(ASSET_URL);

/**
 * GET /authkit/assets/passkey_register.js
 *
 * Serve o script de registro de passkey (account/mfa.edge, "adicionar chave
 * de acesso") a partir do próprio host. M12: essa view embutia o script como
 * `<script type="module">` INLINE, bloqueado por CSP `script-src 'self'`.
 *
 * Fica FORA do prefixo do console admin (opt-in): a tela de MFA da conta
 * (`/account/mfa`) existe em qualquer host, com ou sem console.
 */
export default class PasskeyRegisterAssetController {
  async handle(ctx: HttpContext) {
    return handler.handle(ctx);
  }
}

/** @internal Limpa o cache do asset — só para os testes exercitarem 200 e 404 no mesmo processo. */
export function resetPasskeyRegisterAssetCache(): void {
  handler.resetCache();
}
