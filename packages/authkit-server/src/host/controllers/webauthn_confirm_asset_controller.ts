import type { HttpContext } from '@adonisjs/core/http';
import { createStaticAssetHandler } from './static_asset_controller.js';

/** Ver o docblock de `passkey_autofill_asset_controller.ts` sobre `import.meta.url`. */
const ASSET_URL = new URL('../assets/webauthn_confirm.js', import.meta.url);

const handler = createStaticAssetHandler(ASSET_URL);

/**
 * GET /authkit/assets/webauthn_confirm.js
 *
 * Serve o script de verificação WebAuthn genérica de `account/confirm.edge`
 * (um handler para todos os blocos `kind: 'webauthn'` da tela) a partir do
 * próprio host. M12: essa view embutia o script como `<script
 * type="module">` INLINE, bloqueado por CSP `script-src 'self'`.
 */
export default class WebauthnConfirmAssetController {
  async handle(ctx: HttpContext) {
    return handler.handle(ctx);
  }
}

/** @internal Limpa o cache do asset — só para os testes exercitarem 200 e 404 no mesmo processo. */
export function resetWebauthnConfirmAssetCache(): void {
  handler.resetCache();
}
