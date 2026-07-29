import { type FormHTMLAttributes, type ReactNode, type SubmitEvent, createElement } from 'react';
import { type InteractionPostStep, interactionUrls } from '../interaction/urls.js';

export interface InteractionFormProps
  extends Omit<FormHTMLAttributes<HTMLFormElement>, 'method' | 'action'> {
  /** O `uid` da interaction (vem da view do authkit-server). */
  uid: string;
  /** Qual endpoint POST da interaction submeter. */
  step: InteractionPostStep;
  /** CSRF token — vira o campo escondido `_csrf`. */
  csrfToken: string;
  /** Prefixo de mount da interaction, se diferente do padrão. */
  basePath?: string;
  /** Os campos/botões do formulário (o app é dono deles e do estilo). */
  children?: ReactNode;
}

/**
 * Trava anti-duplo-submit A NÍVEL DE DOM, compartilhada por todos os forms de
 * interaction. Por que DOM e não estado React:
 *
 * - Cobre QUALQUER `children` (o app é dono dos campos/botões) sem exigir
 *   render-prop nem mudança de API — hosts ganham a trava de graça.
 * - O `setTimeout(0)` agenda a trava pra DEPOIS do dispatch do `submit`: a
 *   entry-list do form já foi construída (então até um botão de submit NOMEADO
 *   preserva seu valor no POST) e qualquer handler em bolha que chame
 *   `preventDefault` já rodou (aí `defaultPrevented` evita travar à toa — sem
 *   navegação, nada de botão morto).
 * - Validação nativa que barra o submit nem dispara o evento — a trava nunca
 *   liga num form inválido.
 *
 * Não há "destravar": a resposta (redirect ou re-render de erro) chega como
 * documento NOVO e o React remonta — o estado zera sozinho.
 */
function lockOnSubmit(
  event: SubmitEvent<HTMLElement>,
  hostOnSubmit?: FormHTMLAttributes<HTMLFormElement>['onSubmit'],
): void {
  // O handler vive no <form>: o currentTarget É o form (o genérico que o
  // createElement do React 19 infere pra props soltas é HTMLElement — o
  // narrowing aqui é seguro).
  const formEvent = event as SubmitEvent<HTMLFormElement>;
  hostOnSubmit?.(formEvent);
  const form = formEvent.currentTarget;
  setTimeout(() => {
    if (formEvent.defaultPrevented) return;
    for (const el of form.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
      'button[type="submit"], input[type="submit"]',
    )) {
      el.disabled = true;
    }
    form.setAttribute('aria-busy', 'true');
  }, 0);
}

/**
 * Formulário de interaction do AuthKit: `<form method="POST">` apontando pro
 * endpoint certo + o campo escondido `_csrf`, deixando os campos e o estilo pro
 * app. Encapsula o boilerplate que se repetia em cada método (identifier, login,
 * magic): a URL (via `interactionUrls`) e o CSRF. Primitivo componível — os
 * componentes prontos (`MagicLinkButton`) são construídos sobre ele.
 *
 * Todo submit passa pela trava anti-duplo-submit (ver `lockOnSubmit`): os
 * endpoints de interaction disparam ações custosas (envio de e-mail, cerimônia
 * WebAuthn) e um clique repetido vira POST duplicado — no `/magic`, derrubava o
 * usuário no throttle do host (429) por N cliques impacientes.
 */
export function InteractionForm({
  uid,
  step,
  csrfToken,
  basePath,
  children,
  onSubmit,
  ...rest
}: InteractionFormProps) {
  const action = interactionUrls(uid, basePath)[step];
  return createElement(
    'form',
    { method: 'POST', action, onSubmit: (event) => lockOnSubmit(event, onSubmit), ...rest },
    createElement('input', { type: 'hidden', name: '_csrf', value: csrfToken }),
    children,
  );
}
