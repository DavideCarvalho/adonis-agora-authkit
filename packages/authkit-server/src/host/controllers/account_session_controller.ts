import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { accountHome } from '../account_home.js';
import { getAccountLoginUrl } from '../account_login_url.js';
import type { AccountLoginProps } from '../account_screen_props.js';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { syncAdonisAuthLogin, syncAdonisAuthLogout } from '../adonis_auth_sync.js';
import { translate } from '../i18n.js';
import { attemptPasswordLogin } from '../login_attempt.js';
import { notifyLoginSuccess } from '../login_notify.js';
import { resolveRuntimeSettings } from '../runtime_settings.js';
import { markSudo } from '../sudo_mode.js';

/**
 * Valida um valor de `return_to` recebido da query-string ou de um campo hidden.
 *
 * Regras de segurança (anti open-redirect):
 *   - Deve ser uma string não-vazia.
 *   - Deve começar com `/`.
 *   - NÃO pode começar com `//` (esquema-relativo, ex.: `//evil.com`).
 *   - NÃO pode conter `://` (URL absoluta com esquema, ex.: `https://evil.com`).
 *   - NÃO pode conter `\` (backslash). Browsers normalizam `\`→`/`, então
 *     `/\evil.com` vira `//evil.com` (esquema-relativo) → open-redirect. (L9)
 *
 * Retorna o valor validado ou `null` quando inválido/ausente.
 */
export function validateReturnTo(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  // L9: backslash é tratado como `/` por muitos browsers; `/\evil.com` →
  // `//evil.com`. Rejeitamos qualquer backslash ANTES das demais checagens
  // para não deixar passar variantes ofuscadas (`/\`, `\/`, `\\`).
  if (value.includes('\\')) return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//')) return null;
  if (value.includes('://')) return null;
  return value;
}

export default class AccountSessionController {
  async show(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;

    if (ctx.session.get(ACCOUNT_SESSION_KEY)) {
      return ctx.response.redirect(accountHome(cfg));
    }

    // Lê e valida o return_to da query-string — descarta valores inválidos (open-redirect).
    const rawReturnTo = (ctx.request as any).qs?.()?.return_to ?? ctx.request.input?.('return_to');
    const returnTo = validateReturnTo(rawReturnTo);

    const props = {
      csrfToken: ctx.request.csrfToken,
      returnTo,
    } satisfies Omit<AccountLoginProps, 'messages'>;

    return render(ctx, 'account/login', props);
  }

  async login(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;

    const { email: rawEmail, password } = ctx.request.only(['email', 'password']);
    // L6: normaliza o e-mail (trim + lowercase) ANTES de usar — garante que o
    // lookup, o lockout (keyed por email) e a auditoria usem a forma canônica,
    // independente do casing/espaços digitados.
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : rawEmail;
    const ip = ctx.request.ip?.() ?? null;

    // Lê e valida o return_to do corpo do formulário (hidden input) — nunca confiar sem revalidar.
    const rawReturnTo = ctx.request.input?.('return_to');
    const returnTo = validateReturnTo(rawReturnTo);

    // Verificação + lockout + auditoria de falha centralizados (sem clientId no console).
    // M1: passa `settings` p/ o lockout (e verified-email/expiração) runtime valerem aqui também.
    const settings = await resolveRuntimeSettings(ctx);
    const result = await attemptPasswordLogin(cfg, {
      email,
      password,
      ip,
      logger: ctx.logger,
      settings: settings ?? undefined,
    });
    if (!result.ok) {
      const props = {
        csrfToken: ctx.request.csrfToken,
        returnTo,
        error: result.locked
          ? translate(cfg.messages, 'errors.account_locked', {
              seconds: result.retryAfterSec ?? 0,
            })
          : result.disabled
            ? translate(cfg.messages, 'errors.account_disabled')
            : translate(cfg.messages, 'errors.invalid_credentials'),
      } satisfies Omit<AccountLoginProps, 'messages'>;

      return render(ctx, 'account/login', props);
    }

    const acc = result.account;
    // M5 (session fixation): regenera a sessão IMEDIATAMENTE após autenticar e
    // ANTES de gravar a chave de conta. A elevação de privilégio (anônimo →
    // autenticado) DEVE trocar o session id para que um id fixado por um atacante
    // pré-login deixe de valer. O AdonisJS migra os dados já presentes na sessão
    // para o novo id, então qualquer estado de pré-login (ex.: MFA-pending) é
    // preservado — o que muda é só o identificador do cookie.
    await ctx.session.regenerate();
    ctx.session.put(ACCOUNT_SESSION_KEY, acc.id);
    // Login com senha = confirmação de identidade → marca sudo (graça a partir do login).
    markSudo(ctx);
    // Opt-in: sincroniza ctx.auth.use(cfg.adonisAuth.guard) com a mesma conta —
    // no-op sem `adonisAuth` configurado ou sem @adonisjs/auth inicializado.
    await syncAdonisAuthLogin(ctx, cfg, acc);
    await notifyLoginSuccess(ctx, cfg, { accountId: acc.id, email, ip });
    // Redireciona pro destino original (validado), ou cai no accountHome configurado.
    return ctx.response.redirect(returnTo ?? accountHome(cfg));
  }

  async logout(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    // M6: não basta `forget(ACCOUNT_SESSION_KEY)` — sobravam na sessão
    // `authkit_sudo_at` (sudo), `authkit_last_seen` e qualquer outro estado
    // sensível, com o session id INALTERADO. Regenerar troca o id do cookie,
    // o que invalida o identificador antigo.
    //
    // ATENÇÃO ao que `regenerate()` NÃO faz: ele NÃO descarta os dados. O
    // AdonisJS MIGRA o conteúdo da sessão para o id novo (é o mesmo
    // comportamento descrito no M5 do login, e é por isso que o estado de
    // pré-login sobrevive lá). Quem apaga estado aqui é o `forget` explícito —
    // não o `regenerate`.
    //
    // Consequência de projeto: TODO dado sensível guardado na sessão precisa
    // ser VINCULADO À CONTA que o gravou (ex.: `accountId` no pendente do
    // magic link de sudo, na vinculação do challenge de passkey e na marca de
    // sudo — `SUDO_ACCOUNT_SESSION_KEY`). Confiar que ele "some no logout" é
    // falso — num navegador compartilhado ele sobrevive ao logout de A e ao
    // login de B.
    //
    // A marca de sudo era a EXCEÇÃO à própria regra declarada aqui: só o
    // timestamp, sem dono. Passou a ser vinculada — por isso este `forget`
    // continua sendo só do `ACCOUNT_SESSION_KEY`: trocada a conta, a marca de
    // sudo remanescente já não vale para ninguém.
    ctx.session.forget(ACCOUNT_SESSION_KEY);
    await ctx.session.regenerate();
    // Opt-in: espelha o logout no guard de @adonisjs/auth (ver adonisAuth em define_config.ts).
    await syncAdonisAuthLogout(ctx, cfg);
    // Destino configurável (`accountLoginUrl`): default `/account/login`.
    return ctx.response.redirect(getAccountLoginUrl());
  }
}
