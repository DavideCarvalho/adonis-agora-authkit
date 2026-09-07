import { readFile } from 'node:fs/promises';
import type { HttpContext } from '@adonisjs/core/http';

/**
 * Fábrica compartilhada do padrão "sirva um JS same-origin, cacheado,
 * memoizado em processo" usado por `webauthn_asset_controller.ts` e
 * `logout_asset_controller.ts` (ver o CHANGELOG `0.61.3` para a origem do
 * padrão: CSP `script-src 'self'` bloqueia `<script>` inline sem nonce/hash, e
 * um asset same-origin é permitido por `'self'` sem depender de nenhum dos
 * dois).
 *
 * Extraída para os assets do M12 (login/MFA/confirm passkey flows +
 * anti-duplo-submit) em vez de copiar a mesma leitura+cache+404 mais cinco
 * vezes — os dois controllers originais continuam como estavam (o contrato
 * público deles, incl. `resetXAssetCache`, é usado pelos testes existentes),
 * mas todo asset NOVO passa por aqui.
 */
export interface AssetHandler {
  handle(ctx: HttpContext): Promise<unknown>;
  /** Limpa o cache em memória — só para os testes exercitarem os dois ramos (200/404) no mesmo processo. */
  resetCache(): void;
}

export function createStaticAssetHandler(assetUrl: URL): AssetHandler {
  /** `null` = ainda não lido. `false` = lido e ausente (404 memoizado). */
  let cached: Buffer | false | null = null;

  return {
    async handle(ctx: HttpContext) {
      if (cached === null) {
        try {
          cached = await readFile(assetUrl);
        } catch {
          cached = false;
        }
      }

      if (cached === false) {
        // 404 limpo: asset não incluído no pacote (build incompleto). As views
        // que dependem dele degradam sem JS em vez de estourar 500.
        return ctx.response.notFound();
      }

      return ctx.response
        .type('text/javascript')
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .send(cached);
    },
    resetCache() {
      cached = null;
    },
  };
}
