import { type ButtonHTMLAttributes, createElement, type ReactNode } from 'react';
import { usePasskeyLogin } from '../hooks/use_passkey_login.js';
import { buttonClass } from '../utils.js';

export interface PasskeyButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  /** Endpoint `passkey/options` do interaction controller (POST). */
  optionsUrl: string;
  /** Endpoint `passkey/verify` do interaction controller (POST de página inteira). */
  verifyUrl: string;
  /** CSRF token: header `x-csrf-token` no options e campo `_csrf` no verify. */
  csrfToken?: string;
  children?: ReactNode;
  /**
   * Conteúdo mostrado quando a autenticação falha. Default: mensagem padrão.
   * Passe `null` para desligar (ex.: o app mostra o próprio erro).
   */
  errorContent?: ReactNode;
}

const DEFAULT_ERROR = 'Não foi possível autenticar com a passkey. Tente novamente.';

/**
 * Botão pronto de login por passkey (tier "faz tudo"). Renderiza o botão, roda a
 * cerimônia no clique e mostra o erro em caso de falha. Temável via `className`
 * (mescla com `authkit-button`) e `children`. Construído sobre `usePasskeyLogin`
 * — quem precisa de controle total usa o hook direto.
 */
export function PasskeyButton({
  optionsUrl,
  verifyUrl,
  csrfToken,
  children = 'Entrar com passkey',
  errorContent,
  className,
  ...rest
}: PasskeyButtonProps) {
  const { authenticate, busy, failed } = usePasskeyLogin({
    optionsUrl,
    verifyUrl,
    csrfToken,
  });

  const button = createElement(
    'button',
    {
      type: 'button',
      className: buttonClass('authkit-button--ghost', className),
      onClick: () => {
        void authenticate();
      },
      disabled: busy,
      ...rest,
    },
    children,
  );

  if (!failed || errorContent === null) return button;

  return createElement(
    'div',
    { className: 'authkit-passkey' },
    button,
    createElement('p', { className: 'authkit-passkey__error' }, errorContent ?? DEFAULT_ERROR),
  );
}
