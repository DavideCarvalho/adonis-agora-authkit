import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createElement, type FormEvent, useState } from 'react';
import { useAuthkitConfig } from '../config.js';
import {
  useAccountInviteOrgMemberMutationOptions,
  useAccountLeaveOrgMutationOptions,
  useAccountOrgQueryOptions,
  useAccountOrgsQueryOptions,
} from '../queries/account/index.js';
import { authkitKeys } from '../queries/keys.js';
import { useAuth } from '../use_auth.js';

export interface OrganizationProfileProps {
  /** Rótulo do botão de convidar. Default: 'Convidar membro' */
  inviteLabel?: string;
  /** Rótulo do botão de sair da org. Default: 'Sair da organização' */
  leaveLabel?: string;
  className?: string;
}

/**
 * Card de perfil da organização ativa: lista de membros + formulário de convite
 * (visível para owner/admin) + botão de sair. SSR-safe. Requer
 * `AuthkitClientProvider` + `QueryClientProvider`.
 */
function OrganizationProfileInner({
  inviteLabel = 'Convidar membro',
  leaveLabel = 'Sair da organização',
  className,
}: OrganizationProfileProps) {
  const { isAuthenticated } = useAuth();
  const qc = useQueryClient();
  const orgs = useQuery({ ...useAccountOrgsQueryOptions(), enabled: isAuthenticated });
  const activeOrgId = orgs.data?.activeOrgId ?? null;
  const orgQuery = useAccountOrgQueryOptions(activeOrgId ?? '');
  const detail = useQuery({ ...orgQuery, enabled: isAuthenticated && activeOrgId !== null });
  const invite = useMutation({
    ...useAccountInviteOrgMemberMutationOptions(),
    onSuccess: () => qc.invalidateQueries({ queryKey: orgQuery.queryKey }),
  });
  const leave = useMutation({
    ...useAccountLeaveOrgMutationOptions(),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: authkitKeys.account.orgs() }),
        qc.invalidateQueries({ queryKey: authkitKeys.account.me() }),
      ]),
  });
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');

  if (!isAuthenticated || !activeOrgId) return null;
  if (detail.isLoading)
    return createElement('div', { className: 'authkit-org-profile__loading' }, 'Carregando…');
  if (detail.error)
    return createElement('div', { className: 'authkit-error' }, detail.error.message);
  const org = detail.data;
  if (!org) return null;

  const handleInvite = async (e: FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    try {
      await invite.mutateAsync({ orgId: activeOrgId, email: inviteEmail.trim(), role: inviteRole });
      setInviteEmail('');
    } catch {
      // o erro fica em `invite.error`
    }
  };

  const handleLeave = () => {
    // best-effort
    leave.mutate(activeOrgId);
  };

  const memberList = createElement(
    'div',
    { className: 'authkit-org-profile__members' },
    createElement('h3', { className: 'authkit-org-profile__section-title' }, 'Membros'),
    ...(org.members.length === 0
      ? [createElement('p', { className: 'authkit-org-profile__empty' }, 'Nenhum membro.')]
      : org.members.map((m) =>
          createElement(
            'div',
            { key: m.accountId, className: 'authkit-org-profile__member' },
            createElement(
              'div',
              { className: 'authkit-org-profile__member-info' },
              createElement(
                'span',
                { className: 'authkit-org-profile__member-email' },
                m.email ?? m.accountId,
              ),
              createElement('span', { className: 'authkit-org-profile__member-role' }, m.role),
            ),
          ),
        )),
  );

  const inviteForm = org.canManage
    ? createElement(
        'form',
        { className: 'authkit-org-profile__invite-form', onSubmit: handleInvite },
        createElement('h3', { className: 'authkit-org-profile__section-title' }, inviteLabel),
        createElement('input', {
          className: 'authkit-input',
          type: 'email',
          placeholder: 'Email',
          value: inviteEmail,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setInviteEmail(e.target.value),
        }),
        createElement('input', {
          className: 'authkit-input',
          placeholder: 'Papel (ex: member)',
          value: inviteRole,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setInviteRole(e.target.value),
        }),
        invite.error
          ? createElement('p', { className: 'authkit-error', role: 'alert' }, invite.error.message)
          : null,
        createElement(
          'button',
          {
            type: 'submit',
            className: 'authkit-button authkit-button--primary',
            disabled: invite.isPending,
          },
          invite.isPending ? 'Enviando…' : inviteLabel,
        ),
      )
    : null;

  const leaveButton = createElement(
    'button',
    {
      type: 'button',
      className: 'authkit-button authkit-button--danger',
      onClick: handleLeave,
    },
    leaveLabel,
  );

  return createElement(
    'div',
    { className: ['authkit-card', 'authkit-org-profile', className].filter(Boolean).join(' ') },
    createElement(
      'div',
      { className: 'authkit-org-profile__header' },
      createElement('div', { className: 'authkit-org-profile__name' }, org.name),
      createElement('div', { className: 'authkit-org-profile__slug' }, org.slug),
    ),
    memberList,
    inviteForm,
    leaveButton,
  );
}

/**
 * Depende da REST surface do authkit-server — com `idp: 'external'`
 * (IdP de terceiros) degrada para `null` em vez de chamar endpoints
 * inexistentes.
 */
export function OrganizationProfile(props: Parameters<typeof OrganizationProfileInner>[0]) {
  const { idp } = useAuthkitConfig();
  if (idp === 'external') return null;
  return <OrganizationProfileInner {...props} />;
}
