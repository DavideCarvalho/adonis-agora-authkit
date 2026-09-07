import type { HttpContext } from '@adonisjs/core/http';
import { createStaticAssetHandler } from './static_asset_controller.js';

/** Ver o docblock de `passkey_autofill_asset_controller.ts` sobre `import.meta.url`. */
const ASSET_URL = new URL('../assets/submit_lock.js', import.meta.url);

const handler = createStaticAssetHandler(ASSET_URL);

/**
 * GET /authkit/assets/submit_lock.js
 *
 * Serve a trava anti-duplo-submit incluída em TODA view do host-kit
 * (`partials/submit_lock.edge`) a partir do próprio host. M12: essa partial
 * embutia o script como `<script>` INLINE (sem `type="module"`, mas mesmo
 * bloqueio de CSP `script-src 'self'` sem nonce/hash).
 *
 * Carregado em toda tela do fluxo (login, signup, MFA, conta) — SEM
 * AUTENTICAÇÃO, e é intencional, pelo mesmo motivo do bundle WebAuthn.
 */
export default class SubmitLockAssetController {
  async handle(ctx: HttpContext) {
    return handler.handle(ctx);
  }
}

/** @internal Limpa o cache do asset — só para os testes exercitarem 200 e 404 no mesmo processo. */
export function resetSubmitLockAssetCache(): void {
  handler.resetCache();
}
