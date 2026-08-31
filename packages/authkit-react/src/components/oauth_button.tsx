import { type AnchorHTMLAttributes, createElement, type ReactNode } from 'react';
import { oauthRedirectUrl } from '../interaction/urls.js';
import { buttonClass } from '../utils.js';

export interface OAuthButtonProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  /** Provedor OAuth (ex.: `'google'`, `'github'`). */
  provider: string;
  /** O `uid` da interaction. */
  uid: string;
  /** Prefixo de mount do OAuth, se diferente do padrão `/auth`. */
  basePath?: string;
  /** Conteúdo do botão (ícone + label). Default: nome do provedor capitalizado. */
  children?: ReactNode;
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}

/**
 * Link pronto de login social (tier "faz tudo"): um `<a>` pro redirect do
 * provedor OAuth. Genérico — passe o ícone/label como `children` (ex.: o SVG do
 * Google) e o estilo via `className` (mescla com `authkit-button`). O redirect é
 * navegação de página inteira, então um link é o certo (não um botão + JS).
 */
export function OAuthButton({
  provider,
  uid,
  basePath,
  children,
  className,
  ...rest
}: OAuthButtonProps) {
  return createElement(
    'a',
    {
      href: oauthRedirectUrl(provider, uid, basePath),
      className: buttonClass('authkit-button--ghost', className),
      ...rest,
    },
    children ?? `Entrar com ${capitalize(provider)}`,
  );
}
