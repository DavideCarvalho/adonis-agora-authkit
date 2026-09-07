import type { HttpContext } from '@adonisjs/core/http';
import { createStaticAssetHandler } from './static_asset_controller.js';

/**
 * URL do asset, ANCORADA em `import.meta.url` (nunca relativa ao cwd) — mesmo
 * motivo de `webauthn_asset_controller.ts`: `pnpm deploy --legacy` remonta a
 * árvore de `node_modules` num diretório novo, e um caminho relativo ao cwd
 * do host apontaria para o lugar errado em produção.
 */
const ASSET_URL = new URL('../assets/passkey_autofill.js', import.meta.url);

const handler = createStaticAssetHandler(ASSET_URL);

/**
 * GET /authkit/assets/passkey_autofill.js
 *
 * Serve o script de autofill de passkey (conditional mediation) do
 * `login.edge` a partir do próprio host — M12: `login.edge` embutia esse
 * script como `<script type="module">` INLINE, bloqueado por CSP
 * `script-src 'self'` (sem nonce/hash). Mesmo tratamento same-origin de
 * `logout_asset_controller.ts`/`webauthn_asset_controller.ts`.
 *
 * SEM AUTENTICAÇÃO, e é intencional: carregado na tela de login, antes de
 * existir qualquer sessão.
 */
export default class PasskeyAutofillAssetController {
  async handle(ctx: HttpContext) {
    return handler.handle(ctx);
  }
}

/** @internal Limpa o cache do asset — só para os testes exercitarem 200 e 404 no mesmo processo. */
export function resetPasskeyAutofillAssetCache(): void {
  handler.resetCache();
}
