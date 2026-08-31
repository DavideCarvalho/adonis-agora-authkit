import { createElement, type FormEvent, useState } from 'react';
import { useAuthkitConfig } from '../config.js';
import { useProfile } from '../hooks/use_profile.js';
import { useAuth } from '../use_auth.js';
import { Avatar } from './avatar.js';

export interface UserProfileProps {
  className?: string;
}

/**
 * Card de perfil (avatar + nome + email) com formulário de edição que faz
 * POST no endpoint `profile` configurado. Renderiza nada quando não autenticado.
 */
function UserProfileInner({ className }: UserProfileProps) {
  const { user, isAuthenticated } = useAuth();
  const { actions, loading, error } = useProfile();
  const [name, setName] = useState(user?.name ?? '');

  if (!isAuthenticated || !user) return null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void actions.update({ name });
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
      error
        ? createElement('p', { className: 'authkit-error', role: 'alert' }, error.message)
        : null,
      createElement(
        'button',
        {
          type: 'submit',
          className: 'authkit-button authkit-button--primary',
          disabled: loading,
        },
        loading ? 'Salvando…' : 'Salvar',
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
