import type { HttpContext } from '@adonisjs/core/http';

/**
 * "Último método usado" no login (o selo "Last used" do Cloudflare, Vercel, Clerk…).
 *
 * O método fica num cookie DESTE DISPOSITIVO, não na conta. É de propósito:
 *  - o passo 1 (identifier) ainda não sabe quem é o usuário, e é exatamente ali
 *    que o selo mais ajuda ("da última vez você entrou com Google");
 *  - guardar por conta e mostrar no passo 2 diria a quem digita um e-mail qualquer
 *    como aquela conta entra — vazamento de enumeração. O cookie só conta ao
 *    próprio browser o que ele mesmo fez.
 *
 * O cookie não carrega identidade nenhuma (nem e-mail, nem accountId), só o método.
 * É puramente de SUPERFÍCIE: a tela destaca um botão, mas nada no fluxo muda — os
 * métodos oferecidos continuam vindo de `authMethods`, e um valor adulterado no
 * cookie só destaca outro botão (ou nenhum, se não passar na validação).
 *
 * Gravado quando o fator PRIMÁRIO é aceito. Numa conta com 2º fator, isso acontece
 * antes do desafio de MFA: o selo responde "como você se identificou", que é o
 * botão que a pessoa procura na próxima vez.
 */

/** Nome do cookie do último método de login. */
export const LAST_LOGIN_METHOD_COOKIE = 'authkit_last_login';

/** Validade do cookie: 1 ano (renovado a cada login). */
const LAST_LOGIN_METHOD_MAX_AGE = 365 * 24 * 60 * 60;

/**
 * Método de login primário. `social:<provider>` e `custom:<id>` carregam o id do
 * provedor/método para a tela destacar o botão certo entre vários.
 */
export type LastLoginMethod =
  | 'password'
  | 'magic_link'
  | 'otp'
  | 'passkey'
  | `social:${string}`
  | `custom:${string}`;

const FIXED_METHODS = new Set(['password', 'magic_link', 'otp', 'passkey']);
/** Ids de provedor/método: mesmo formato curto que vai em rota/config. */
const QUALIFIED_METHOD = /^(social|custom):[a-z0-9][a-z0-9_-]{0,63}$/i;

/**
 * Valida um valor lido do cookie. Só os métodos conhecidos passam; qualquer outra
 * coisa (ausente, lixo, valor adulterado) vira `undefined` — sem selo.
 */
export function normalizeLastLoginMethod(raw: unknown): LastLoginMethod | undefined {
  if (typeof raw !== 'string') return undefined;
  if (FIXED_METHODS.has(raw) || QUALIFIED_METHOD.test(raw)) return raw as LastLoginMethod;
  return undefined;
}

/** `false` desliga a feature (`login.lastUsedMethod: false`); ausente = ligada. */
function isEnabled(cfg: { login?: { lastUsedMethod?: boolean } }): boolean {
  return cfg.login?.lastUsedMethod !== false;
}

/**
 * Lê o último método deste dispositivo para a tela de login. Fail-safe: feature
 * desligada, ctx sem cookies ou qualquer erro → `undefined` (sem selo).
 */
export function readLastLoginMethod(
  ctx: HttpContext,
  cfg: { login?: { lastUsedMethod?: boolean } },
): LastLoginMethod | undefined {
  if (!isEnabled(cfg)) return undefined;
  try {
    return normalizeLastLoginMethod(ctx.request.plainCookie?.(LAST_LOGIN_METHOD_COOKIE));
  } catch {
    return undefined;
  }
}

/**
 * Registra o método primário que acabou de ser aceito. Grava via resposta do
 * Adonis; quando o login termina no `interactionFinished` (que encerra a resposta
 * crua), o `completeLogin` repassa o cookie pendente — ver
 * {@link relayPendingCookies}. Best-effort: nunca derruba o login.
 */
export function rememberLastLoginMethod(
  ctx: HttpContext,
  cfg: { login?: { lastUsedMethod?: boolean } },
  method: LastLoginMethod,
): void {
  if (!isEnabled(cfg)) return;
  if (!normalizeLastLoginMethod(method)) return;
  try {
    ctx.response.plainCookie?.(LAST_LOGIN_METHOD_COOKIE, method, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: LAST_LOGIN_METHOD_MAX_AGE,
      secure: ctx.request.secure?.() ?? false,
    });
  } catch {
    // Selo é cosmético: falha ao gravar não interfere no login.
  }
}

/**
 * Repassa os `Set-Cookie` que o handler gravou na resposta do Adonis para a
 * resposta crua do Node.
 *
 * O Adonis só escreve os headers no `finish()`, depois do handler. Mas o
 * `interactionFinished` do oidc-provider escreve o 303 e dá `res.end()` direto na
 * resposta crua — quando o Adonis chega no `finish()`, a resposta já saiu e todo
 * cookie gravado via `ctx.response.cookie()` no mesmo request é descartado em
 * silêncio. Chamado pelo `completeLogin` logo antes do `interactionFinished`.
 *
 * Os cookies saem do Adonis ao serem repassados, então não há como irem em dobro.
 * O `Set-Cookie` que o próprio oidc-provider grava depois é ACRESCENTADO aos
 * existentes (a lib `cookies` do Koa preserva o header), então nada se perde.
 */
export function relayPendingCookies(ctx: HttpContext): void {
  try {
    const response = ctx.response as any;
    const raw = response?.response;
    if (!raw || typeof raw.setHeader !== 'function' || raw.headersSent) return;
    const pending = response.getHeader?.('set-cookie');
    if (pending === undefined || pending === null) return;
    const toList = (value: unknown): string[] =>
      value === undefined || value === null
        ? []
        : Array.isArray(value)
          ? value.map(String)
          : [String(value)];
    // O `getHeader` do Adonis também enxerga o que já está na resposta crua, então
    // a lista pendente pode repetir o que lá está — dedup preservando a ordem.
    const cookies = [...new Set([...toList(raw.getHeader?.('set-cookie')), ...toList(pending)])];
    // O `removeHeader` do Adonis apaga também da resposta crua — por isso vem
    // ANTES do `setHeader`, que regrava a lista completa.
    response.removeHeader?.('set-cookie');
    raw.setHeader('set-cookie', cookies);
  } catch {
    // Repasse é best-effort: nunca derruba o login.
  }
}
