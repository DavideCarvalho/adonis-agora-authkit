import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createElement } from 'react';
import type { AccountAppEntry } from '../client/types.js';
import { useAuthkitConfig } from '../config.js';
import { useAppsQueryOptions, useRevokeAppMutationOptions } from '../queries/account/index.js';
import { authkitKeys } from '../queries/keys.js';

export interface AuthorizedAppsProps {
  className?: string;
  revokeLabel?: string;
  emptyLabel?: string;
}

/**
 * Lista os apps autorizados pelo usuário com botão de revogar por item.
 * Requer `AuthkitClientProvider` + `QueryClientProvider`.
 */
function AuthorizedAppsInner({
  className,
  revokeLabel = 'Revogar',
  emptyLabel = 'Nenhum app autorizado.',
}: AuthorizedAppsProps) {
  const qc = useQueryClient();
  const query = useQuery(useAppsQueryOptions());
  const revoke = useMutation({
    ...useRevokeAppMutationOptions(),
    onSuccess: () => qc.invalidateQueries({ queryKey: authkitKeys.account.apps() }),
  });

  if (query.isLoading && !query.data) {
    return createElement('div', { className: 'authkit-apps__loading' }, 'Carregando…');
  }
  if (query.error) {
    return createElement('p', { className: 'authkit-error', role: 'alert' }, query.error.message);
  }
  const apps = query.data?.apps ?? [];
  if (apps.length === 0) {
    return createElement('p', { className: 'authkit-apps__empty' }, emptyLabel);
  }

  return createElement(
    'ul',
    { className: ['authkit-apps', className].filter(Boolean).join(' ') },
    ...apps.map((app: AccountAppEntry) =>
      createElement(
        'li',
        { key: app.clientId, className: 'authkit-apps__item' },
        createElement(
          'div',
          { className: 'authkit-apps__info' },
          app.logoUrl
            ? createElement('img', { className: 'authkit-apps__logo', src: app.logoUrl, alt: '' })
            : null,
          createElement('span', { className: 'authkit-apps__name' }, app.name || app.clientId),
        ),
        createElement(
          'button',
          {
            type: 'button',
            className: 'authkit-button authkit-button--danger',
            disabled: revoke.isPending,
            onClick: () => revoke.mutate(app.clientId),
          },
          revokeLabel,
        ),
      ),
    ),
  );
}

/**
 * Depende da REST surface do authkit-server — com `idp: 'external'`
 * (IdP de terceiros) degrada para `null` em vez de chamar endpoints
 * inexistentes.
 */
export function AuthorizedApps(props: Parameters<typeof AuthorizedAppsInner>[0]) {
  const { idp } = useAuthkitConfig();
  if (idp === 'external') return null;
  return <AuthorizedAppsInner {...props} />;
}
