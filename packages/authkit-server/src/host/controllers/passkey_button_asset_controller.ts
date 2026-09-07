import type { HttpContext } from '@adonisjs/core/http';
import { createStaticAssetHandler } from './static_asset_controller.js';

/** Ver o docblock de `passkey_autofill_asset_controller.ts` sobre `import.meta.url`. */
const ASSET_URL = new URL('../assets/passkey_button.js', import.meta.url);

const handler = createStaticAssetHandler(ASSET_URL);

/**
 * GET /authkit/assets/passkey_button.js
 *
 * Serve o botão "entrar com passkey" a partir do próprio host — compartilhado
 * por `login.edge` (passwordless antes da senha) e `mfa-challenge.edge` (2º
 * fator). M12: as duas views embutiam esse script como `<script
 * type="module">` INLINE, bloqueado por CSP `script-src 'self'`.
 *
 * SEM AUTENTICAÇÃO, e é intencional: carregado nas telas de login/MFA, antes
 * (ou durante) o handshake de autenticação.
 */
export default class PasskeyButtonAssetController {
  async handle(ctx: HttpContext) {
    return handler.handle(ctx);
  }
}

/** @internal Limpa o cache do asset — só para os testes exercitarem 200 e 404 no mesmo processo. */
export function resetPasskeyButtonAssetCache(): void {
  handler.resetCache();
}
