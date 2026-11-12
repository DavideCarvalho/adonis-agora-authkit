import type { HttpContext } from '@adonisjs/core/http';
import { accountNavFor } from '../../account/runtime.js';
import { type AuthMessages, DEFAULT_MESSAGES } from '../i18n.js';
import type { AuthkitScreen } from '../screen_props.js';
import { renderEdgeView } from './edge_renderer.js';

/**
 * Resolve o catálogo de mensagens ativo a partir do `authkit.server`. Defensivo:
 * sem container/serviço (ex.: teste unitário com ctx mockado), cai no default
 * pt-BR embutido.
 */
async function resolveMessagesFromCtx(ctx: HttpContext): Promise<AuthMessages> {
  try {
    const service = await (ctx as any).containerResolver?.make?.('authkit.server');
    const messages = service?.config?.messages as AuthMessages | undefined;
    if (messages) return messages;
  } catch {
    // sem container/serviço — usa o default
  }
  return { ...DEFAULT_MESSAGES };
}

/**
 * Opções do renderer Inertia/React.
 */
export interface InertiaRendererOptions {
  /**
   * Prefixo das páginas no diretório `inertia/pages/` do host.
   * Ex.: `'authkit'` → a view `login` mapeia para `inertia/pages/authkit/login.tsx`.
   */
  prefix: string;

  /**
   * Lista de nomes de view que o host criou como páginas React (allowlist).
   *
   * **Somente** as views listadas passam pelo Inertia; qualquer outra view (não
   * listada, ou prefixada com `admin/`) é renderizada pelo renderer Edge built-in
   * da lib. Liste exatamente as páginas que o scaffold (`node ace configure`)
   * gerou, mais as que você criar.
   *
   * A ordem do array é irrelevante — `views` é tratado como um *conjunto*
   * (allowlist). Os nomes têm autocomplete via {@link AuthkitScreen}.
   *
   * @example
   * // Gera `inertia/pages/authkit/<view>.tsx` para cada nome listado.
   * render: inertiaRenderer({
   *   prefix: 'authkit',
   *   views: [
   *     'login', 'consent', 'signup', 'forgot', 'reset',
   *     'verify-email', 'mfa-challenge',
   *     'account/login', 'account/tokens', 'account/mfa',
   *   ],
   * })
   */
  views: readonly AuthkitScreen[];
}

export type { AuthkitScreen } from '../screen_props.js';

/**
 * Renderer do seam para hosts Inertia/React.
 *
 * As páginas React vivem no host em `inertia/pages/<prefix>/<view>`.
 * (O console admin não passa por aqui: é a SPA self-contained da lib,
 * servida pelo shell controller.)
 *
 * Apenas as views listadas em `views` (allowlist) vão ao Inertia; qualquer outra
 * view é renderizada pelo Edge renderer built-in.
 *
 * ---
 *
 * ### Props das telas de conta — tipos exportados (fonte única)
 *
 * Um host que escreve as telas do console em React tipa cada página com os tipos
 * de props exportados do pacote, em vez de copiar o shape à mão deste docblock —
 * que já ficou desatualizado no passado. Cada tipo é a FONTE ÚNICA da verdade: os
 * controllers satisfazem (`satisfies Omit<…, 'messages'>`) exatamente o mesmo
 * tipo ao chamar `render()`, então divergência quebra o `tsc` do pacote. Ver
 * `src/host/account_screen_props.ts`.
 *
 * | Tela                      | Tipo exportado             |
 * |---------------------------|----------------------------|
 * | `account/login`           | {@link AccountLoginProps}          |
 * | `account/security`        | {@link AccountSecurityProps}       |
 * | `account/mfa`             | {@link AccountMfaProps}            |
 * | `account/confirm`         | {@link AccountConfirmProps}        |
 * | `account/email-confirmed` | {@link AccountEmailConfirmedProps} |
 *
 * A prop `messages` (catálogo i18n {@link AuthMessages}) é injetada por este
 * renderer como shared prop e faz parte de todos esses tipos — os controllers,
 * que não a passam, satisfazem `Omit<…, 'messages'>`.
 *
 * ```tsx
 * import type { AccountSecurityProps } from '@adonis-agora/authkit-server'
 *
 * export default function Security(props: AccountSecurityProps) {
 *   return <form action="/account/security/password" method="post">…</form>
 * }
 * ```
 */
export function inertiaRenderer(opts: InertiaRendererOptions) {
  const allowed = new Set<string>(opts.views);

  return async (ctx: HttpContext, view: string, props: Record<string, unknown>) => {
    // Allowlist: view fora da lista vai ao Edge (o host não tem a página React).
    if (!allowed.has(view)) {
      return renderEdgeView(ctx, view, props);
    }

    // Happy path: view vai ao Inertia.
    // `messages` vai como shared prop para as páginas React traduzirem.
    const messages = await resolveMessagesFromCtx(ctx);
    const accountNav = props.accountNav ?? (await accountNavFor(ctx, view, props));
    return (ctx as any).inertia.render(`${opts.prefix}/${view}`, {
      ...(accountNav ? { accountNav } : {}),
      ...props,
      messages,
    });
  };
}
