import { type ButtonHTMLAttributes, createElement, type ReactNode, useState } from 'react';
import { buttonClass } from '../utils.js';
import { InteractionForm } from './interaction_form.js';

export interface MagicLinkButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** O `uid` da interaction. */
  uid: string;
  /** CSRF token. */
  csrfToken: string;
  /** Prefixo de mount da interaction, se diferente do padrão. */
  basePath?: string;
  /**
   * Canal "choose-first" (authkit-server 0.51+): vira o campo escondido
   * `channel` do POST `/magic` — `'code'` dispara só o código OTP, `'link'` só
   * o link mágico (o e-mail e a tela seguinte surfam só aquele método). Sem a
   * prop, o POST vai sem `channel` (comportamento histórico: link + código).
   */
  channel?: 'code' | 'link';
  /**
   * Conteúdo do botão DURANTE o voo do POST (o envio do e-mail pode levar
   * segundos). Default `'Enviando…'`.
   */
  pendingChildren?: ReactNode;
  children?: ReactNode;
}

/**
 * Botão pronto de magic link (tier "faz tudo"): um `<form>` POST em `/magic` com
 * um botão de submit. Temável via `className` (mescla com `authkit-button`) e
 * `children`. Construído sobre `InteractionForm` — quem quer controle do form usa
 * o primitivo direto.
 *
 * Anti-duplo-submit em DUAS camadas: o `InteractionForm` trava o botão a nível
 * de DOM (cobre qualquer children), e o estado `pending` aqui troca o conteúdo
 * para `pendingChildren` + `disabled` — sem isso o usuário clicava N vezes sem
 * feedback e cada clique virava um e-mail novo (até cair no throttle, 429).
 */
export function MagicLinkButton({
  uid,
  csrfToken,
  basePath,
  channel,
  pendingChildren = 'Enviando…',
  children = 'Enviar link de login',
  className,
  disabled,
  ...rest
}: MagicLinkButtonProps) {
  const [pending, setPending] = useState(false);
  return createElement(
    InteractionForm,
    { uid, step: 'magic', csrfToken, basePath, onSubmit: () => setPending(true) },
    channel ? createElement('input', { type: 'hidden', name: 'channel', value: channel }) : null,
    createElement(
      'button',
      {
        type: 'submit',
        disabled: disabled || pending,
        className: buttonClass('authkit-button--ghost', className),
        ...rest,
      },
      pending ? pendingChildren : children,
    ),
  );
}
