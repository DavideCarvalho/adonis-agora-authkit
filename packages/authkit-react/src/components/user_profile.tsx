import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createElement, type FormEvent, useState } from 'react';
import { useAuthkitConfig } from '../config.js';
import { useUpdateProfileMutationOptions } from '../queries/account/index.js';
import { authkitKeys } from '../queries/keys.js';
import { useAuth } from '../use_auth.js';
import { Avatar } from './avatar.js';

export interface UserProfileProps {
  className?: string;
}

/**
 * Card de perfil (avatar + nome + email) com formulário de edição do nome.
 * Renderiza nada quando não autenticado. Requer `AuthkitClientProvider` +
 * `QueryClientProvider`.
 */
function UserProfileInner({ className }: UserProfileProps) {
  const { user, isAuthenticated } = useAuth();
  const qc = useQueryClient();
  const update = useMutation({
    ...useUpdateProfileMutationOptions(),
    onSuccess: () => qc.invalidateQueries({ queryKey: authkitKeys.account.me() }),
  });
  const [name, setName] = useState(user?.name ?? '');

  if (!isAuthenticated || !user) return null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    update.mutate({ name });
  };

  return createElement(
    'div',
    { className: ['authkit-card', 'authkit-profile', className].filter(Boolean).join(' ') },
    createElement(
      'div',
      { className: 'authkit-profile__header' },
      createElement(Avatar, { user, size: 56 }),
      createElement(
        'div',
        null,
        createElement('div', { className: 'authkit-profile__name' }, user.name ?? user.email),
        createElement('div', { className: 'authkit-profile__email' }, user.email),
      ),
    ),
    createElement(
      'form',
      { className: 'authkit-profile__form', onSubmit },
      createElement(
        'label',
        { className: 'authkit-label', htmlFor: 'authkit-profile-name' },
        'Nome',
      ),
      createElement('input', {
        id: 'authkit-profile-name',
        className: 'authkit-input',
        value: name,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value),
      }),
      update.error
        ? createElement('p', { className: 'authkit-error', role: 'alert' }, update.error.message)
        : null,
      createElement(
        'button',
        {
          type: 'submit',
          className: 'authkit-button authkit-button--primary',
          disabled: update.isPending,
        },
        update.isPending ? 'Salvando…' : 'Salvar',
      ),
    ),
  );
}

/**
 * Depende da REST surface do authkit-server — com `idp: 'external'`
 * (IdP de terceiros) degrada para `null` em vez de chamar endpoints
 * inexistentes.
 */
export function UserProfile(props: Parameters<typeof UserProfileInner>[0]) {
  const { idp } = useAuthkitConfig();
  if (idp === 'external') return null;
  return <UserProfileInner {...props} />;
}
