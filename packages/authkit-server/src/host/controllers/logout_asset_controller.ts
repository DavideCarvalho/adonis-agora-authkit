import { readFile } from 'node:fs/promises';
import type { HttpContext } from '@adonisjs/core/http';

/**
 * URL do script de auto-confirmação do RP-initiated logout, servido pelo
 * próprio host.
 *
 * ⚠️ RESOLVIDO VIA `import.meta.url`, NUNCA relativo ao cwd. Os apps que
 * consomem este pacote rodam `pnpm deploy --legacy`, que remonta a árvore de
 * `node_modules` num diretório novo — um caminho relativo ao cwd do host
 * apontaria para o lugar errado e a rota daria 404 em produção. Ancorado no
 * módulo, o caminho segue o pacote para onde quer que ele seja copiado.
 *
 * Funciona nos dois layouts porque o asset é commitado em `src/host/assets/`
 * e copiado para `build/src/host/assets/` pelo script `build`:
 *   dev   → src/host/controllers/…       → src/host/assets/logout.js
 *   build → build/src/host/controllers/… → build/src/host/assets/logout.js
 */
const ASSET_URL = new URL('../assets/logout.js', import.meta.url);

/**
 * Cache do conteúdo do asset. É imutável por versão do pacote — ler do disco
 * a cada request de logout não compra nada.
 *
 * `null` = ainda não lido. `false` = lido e ausente (404 memoizado); sem isso
 * um asset faltando viraria um `readFile` que falha por request.
 */
let cached: Buffer | false | null = null;

/**
 * GET /authkit/assets/logout.js
 *
 * Serve o script de auto-submit do splash de logout a partir do próprio host.
 *
 * O `logoutSource` (provider/logout_sources.ts) injeta este script VIA
 * `<script src>` em vez de inline: hosts com CSP `script-src 'self'`
 * bloqueiam script inline sem nonce/hash, e o auto-confirm do logout
 * silenciosamente parava de rodar — a tela "Saindo / Encerrando sua
 * sessão…" ficava presa para sempre. Um asset same-origin é permitido por
 * `'self'` em qualquer CSP razoável, sem depender de nonce nem hash.
 *
 * SEM AUTENTICAÇÃO, e é intencional: é asset estático necessário na tela de
 * logout, antes de a sessão SSO ser destruída. Também não pode viver sob o
 * prefixo do console admin (que é opt-in).
 */
export default class LogoutAssetController {
  async handle(ctx: HttpContext) {
    if (cached === null) {
      try {
        cached = await readFile(ASSET_URL);
      } catch {
        cached = false;
      }
    }

    if (cached === false) {
      // 404 limpo: o asset não foi incluído no pacote. O splash degrada para o
      // botão `<noscript>` (que continua funcionando sem JS) em vez de 500.
      return ctx.response.notFound();
    }

    return ctx.response
      .type('text/javascript')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(cached);
  }
}

/**
 * Limpa o cache do asset. Existe para os testes conseguirem exercitar tanto o
 * caminho feliz quanto o 404 no mesmo processo.
 *
 * @internal
 */
export function resetLogoutAssetCache(): void {
  cached = null;
}
