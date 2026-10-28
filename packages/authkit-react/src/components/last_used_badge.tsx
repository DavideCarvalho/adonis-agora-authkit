import { createElement, type HTMLAttributes, type ReactNode } from 'react';
import { isLastUsedLoginMethod, type LastLoginMethod } from '../interaction/last_used.js';

export interface LastUsedBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** A prop `lastUsedLoginMethod` que o authkit-server manda na tela `login`. */
  lastUsed: string | null | undefined;
  /** Método(s) do botão onde o selo está. Ex.: `'social:google'`, `['magic_link', 'otp']`. */
  method: LastLoginMethod | readonly LastLoginMethod[];
  /** Texto do selo. Default `'Último usado'`. */
  children?: ReactNode;
}

/**
 * Selo "último usado" (tier "faz tudo"): renderiza só quando `lastUsed` casa com
 * `method`, senão `null`. Coloque dentro (ou ao lado) do botão do método:
 *
 * ```tsx
 * <OAuthButton provider="google" uid={uid}>
 *   Entrar com Google
 *   <LastUsedBadge lastUsed={lastUsedLoginMethod} method="social:google" />
 * </OAuthButton>
 * ```
 *
 * Temável via `className` (mescla com `authkit-last-used`).
 */
export function LastUsedBadge({
  lastUsed,
  method,
  children = 'Último usado',
  className,
  ...rest
}: LastUsedBadgeProps) {
  if (!isLastUsedLoginMethod(lastUsed, method)) return null;
  return createElement(
    'span',
    {
      className: className ? `authkit-last-used ${className}` : 'authkit-last-used',
      ...rest,
    },
    children,
  );
}
