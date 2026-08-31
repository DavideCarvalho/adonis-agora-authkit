import { createElement, type FormEvent, useState } from 'react';
import { useAuthkitConfig } from '../config.js';
import { useOrganization } from '../hooks/use_organization.js';
import { useOrganizations } from '../hooks/use_organizations.js';
import { jsonRequest } from '../hooks/use_resource.js';
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
 * (visível para owner/admin) + botão de sair. SSR-safe.
 */
function OrganizationProfileInner({
  inviteLabel = 'Convidar membro',
  leaveLabel = 'Sair da organização',
  className,
}: OrganizationProfileProps) {
  const { isAuthenticated } = useAuth();
  const config = useAuthkitConfig();
  const { activeOrgId, actions: orgListActions } = useOrganizations();
  const { data: org, loading, error, actions } = useOrganization(activeOrgId);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteError, setInviteError] = useState<Error | null>(null);

  if (!isAuthenticated || !activeOrgId) return null;
  if (loading)
    return createElement('div', { className: 'authkit-org-profile__loading' }, 'Carregando…');
  if (error) return createElement('div', { className: 'authkit-error' }, error.message);
  if (!org) return null;

  const base = config.endpoints.orgs.replace('/json', '');

  const handleInvite = async (e: FormEvent) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviteLoading(true);
    setInviteError(null);
    try {
      await jsonRequest(`${base}/${encodeURIComponent(activeOrgId)}/invite`, {
        method: 'POST',
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
        csrfToken: config.csrfToken,
      });
      setInviteEmail('');
      await actions.refetch();
    } catch (err) {
      setInviteError(err as Error);
    } finally {
      setInviteLoading(false);
    }
  };

  const handleLeave = async () => {
    try {
      await jsonRequest(`${base}/${encodeURIComponent(activeOrgId)}/leave`, {
        method: 'POST',
        csrfToken: config.csrfToken,
      });
      await orgListActions.refetch();
    } catch {
      // best-effort
    }
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
        inviteError
          ? createElement('p', { className: 'authkit-error', role: 'alert' }, inviteError.message)
          : null,
        createElement(
          'button',
          {
            type: 'submit',
            className: 'authkit-button authkit-button--primary',
            disabled: inviteLoading,
          },
          inviteLoading ? 'Enviando…' : inviteLabel,
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
