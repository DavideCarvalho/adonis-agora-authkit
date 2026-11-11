import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createElement, useState } from 'react';
import type { AccountOrgEntry } from '../client/types.js';
import { useAuthkitConfig } from '../config.js';
import {
  useAccountActivateOrgMutationOptions,
  useAccountDeactivateOrgMutationOptions,
  useAccountOrgsQueryOptions,
} from '../queries/account/index.js';
import { authkitKeys } from '../queries/keys.js';
import { useAuth } from '../use_auth.js';

export interface OrganizationSwitcherProps {
  /** Rótulo da opção "Conta pessoal" (desativa org ativa). Default: 'Conta pessoal' */
  personalAccountLabel?: string;
  className?: string;
}

/**
 * Dropdown estilo Clerk: mostra a org ativa (ou conta pessoal), lista as orgs
 * do usuário e permite trocar. SSR-safe. Requer `AuthkitClientProvider` +
 * `QueryClientProvider`.
 */
function OrganizationSwitcherInner({
  personalAccountLabel = 'Conta pessoal',
  className,
}: OrganizationSwitcherProps) {
  const { isAuthenticated } = useAuth();
  const qc = useQueryClient();
  const query = useQuery({ ...useAccountOrgsQueryOptions(), enabled: isAuthenticated });
  const onSwitched = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: authkitKeys.account.orgs() }),
      qc.invalidateQueries({ queryKey: authkitKeys.account.me() }),
    ]);
  const activate = useMutation({
    ...useAccountActivateOrgMutationOptions(),
    onSuccess: onSwitched,
  });
  const deactivate = useMutation({
    ...useAccountDeactivateOrgMutationOptions(),
    onSuccess: onSwitched,
  });
  const [open, setOpen] = useState(false);

  if (!isAuthenticated || !query.data?.supported) return null;
  const orgs = query.data.orgs;
  const activeOrgId = query.data.activeOrgId;
  const switching = activate.isPending || deactivate.isPending;

  const activeOrg = orgs.find((o) => o.id === activeOrgId) ?? null;
  const label = activeOrg ? activeOrg.name : personalAccountLabel;

  const trigger = createElement(
    'button',
    {
      type: 'button',
      className: 'authkit-orgswitcher__trigger',
      'aria-haspopup': 'listbox',
      'aria-expanded': open,
      disabled: switching,
      onClick: () => setOpen((v) => !v),
    },
    createElement('span', { className: 'authkit-orgswitcher__label' }, label),
    createElement(
      'span',
      { className: 'authkit-orgswitcher__chevron', 'aria-hidden': 'true' },
      '▾',
    ),
  );

  const menu = open
    ? createElement(
        'div',
        { className: 'authkit-orgswitcher__menu', role: 'listbox' },
        // Conta pessoal
        createElement(
          'button',
          {
            type: 'button',
            className: [
              'authkit-orgswitcher__item',
              !activeOrgId ? 'authkit-orgswitcher__item--active' : '',
            ]
              .filter(Boolean)
              .join(' '),
            role: 'option',
            'aria-selected': !activeOrgId,
            onClick: async () => {
              setOpen(false);
              if (activeOrgId) await deactivate.mutateAsync();
            },
          },
          createElement(
            'span',
            { className: 'authkit-orgswitcher__item-name' },
            personalAccountLabel,
          ),
        ),
        // Orgs
        ...orgs.map((org: AccountOrgEntry) =>
          createElement(
            'button',
            {
              key: org.id,
              type: 'button',
              className: [
                'authkit-orgswitcher__item',
                org.isActive ? 'authkit-orgswitcher__item--active' : '',
              ]
                .filter(Boolean)
                .join(' '),
              role: 'option',
              'aria-selected': org.isActive,
              onClick: async () => {
                setOpen(false);
                if (!org.isActive) await activate.mutateAsync(org.id);
              },
            },
            createElement('span', { className: 'authkit-orgswitcher__item-name' }, org.name),
            createElement('span', { className: 'authkit-orgswitcher__item-role' }, org.role),
          ),
        ),
      )
    : null;

  return createElement(
    'div',
    { className: ['authkit-orgswitcher', className].filter(Boolean).join(' ') },
    trigger,
    menu,
  );
}

/**
 * Depende da REST surface do authkit-server — com `idp: 'external'`
 * (IdP de terceiros) degrada para `null` em vez de chamar endpoints
 * inexistentes.
 */
export function OrganizationSwitcher(props: Parameters<typeof OrganizationSwitcherInner>[0]) {
  const { idp } = useAuthkitConfig();
  if (idp === 'external') return null;
  return <OrganizationSwitcherInner {...props} />;
}
