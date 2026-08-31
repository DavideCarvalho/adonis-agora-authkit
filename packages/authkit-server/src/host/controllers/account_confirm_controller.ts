/**
 * Sudo mode — tela de confirmação de identidade (/account/confirm).
 *
 * O GET lista os métodos DISPONÍVEIS para a conta (SPI `SudoMethod`); a
 * verificação de cada um vive no próprio método, nas rotas que ele registra.
 * Este controller não verifica credencial nem chama `markSudo`.
 *
 * A tela está atrás do `accountGuard` (requer sessão de conta ativa).
 */

import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import type { AccountConfirmProps } from '../account_screen_props.js';
import {
  configuredSudoMethods,
  isSudoMethodMounted,
  LAST_METHOD_SESSION_KEY,
  resolveAvailableMethods,
  sudoContextFrom,
} from '../sudo/runtime.js';

/**
 * Reexport de compatibilidade. O construtor canônico do `SudoContext` vive em
 * `sudo/runtime.ts` (é runtime do SPI, não detalhe da tela); este caminho
 * antigo segue valendo para quem já o importava.
 */
export { sudoContextFrom };

export default class AccountConfirmController {
  async show(ctx: HttpContext) {
    const c = await sudoContextFrom(ctx);
    const available = await resolveAvailableMethods(c, configuredSudoMethods(c.cfg));
    const methods = await Promise.all(
      available.map(async (m) => ({ id: m.id, ...(await m.describe(c)) })),
    );

    if (!methods.length) {
      // Nenhum método disponível é erro de CONFIGURAÇÃO do host, não usuário
      // preso: a tela informa e o log aponta o problema.
      (ctx as any).logger?.error(
        { accountId: c.accountId },
        'authkit: nenhum método de sudo disponível para a conta — verifique config.sudo.methods',
      );
    }

    // FLAG-DRIFT: `config.sudo.methods` decide o que a tela OFERECE, mas as
    // rotas são montadas em tempo de registro, por `registerAuthHost`. Se as
    // duas listas divergirem, a tela mostra um método cujo endpoint não existe
    // — falha silenciosa e confusa. Avisa alto, uma vez por render.
    //
    // Só o caso de config EXPLÍCITA chega aqui divergindo: sem config,
    // `configuredSudoMethods` devolve a própria lista montada.
    for (const m of methods) {
      if (!isSudoMethodMounted(m.id)) {
        (ctx as any).logger?.warn(
          { method: m.id },
          `authkit: método de sudo "${m.id}" está em config.sudo.methods mas não teve rotas montadas por registerAuthHost — a tela vai oferecer uma opção cujo endpoint não existe`,
        );
      }
    }

    const props = {
      csrfToken: ctx.request.csrfToken,
      returnTo: c.returnTo,
      error: ctx.session.flashMessages.get('confirmError') ?? null,
      // `confirmNotice` é flashado por `magic_link.ts` ao enviar o link (já
      // traduzido, mesmo padrão de `confirmError`). Sem repassar aqui, quem
      // pede o link volta para a tela sem nenhum feedback de que o e-mail saiu.
      notice: ctx.session.flashMessages.get('confirmNotice') ?? null,
      methods,
      preferredId: ctx.session.get(LAST_METHOD_SESSION_KEY) ?? null,
    } satisfies Omit<AccountConfirmProps, 'messages'>;

    return c.cfg.render!(ctx, 'account/confirm', props);
  }
}
