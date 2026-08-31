import { type AdminUser, useUsersQueryOptions } from '@adonis-agora/authkit-react';
import { useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';
import { useDebounce } from '../lib/use_debounce';

export type PickedUser = Pick<AdminUser, 'id' | 'email' | 'name'>;

/** Busca de usuário por email/nome com dropdown — substitui campos de UUID cru. */
export function UserPicker({
  onPick,
  placeholder,
}: {
  onPick: (u: PickedUser) => void;
  placeholder?: string;
}) {
  const [search, setSearch] = useState('');
  const dSearch = useDebounce(search, 250);
  const usersQuery = useQuery({
    ...useUsersQueryOptions({ search: dSearch, limit: 6 }),
    enabled: dSearch.trim().length >= 2,
  });
  const candidates = usersQuery.data?.data ?? [];

  return (
    <div style={{ position: 'relative' }}>
      <input
        className="input"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={placeholder ?? 'Search user by email or name…'}
      />
      {dSearch.trim().length >= 2 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            zIndex: 30,
            marginTop: 4,
            background: 'var(--panel, var(--bg))',
            border: '1px solid var(--line)',
            borderRadius: 6,
            overflow: 'hidden',
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
          }}
        >
          {usersQuery.isLoading ? (
            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--faint)' }}>
              Searching…
            </div>
          ) : candidates.length === 0 ? (
            <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--faint)' }}>
              No users match.
            </div>
          ) : (
            candidates.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => onPick({ id: u.id, email: u.email, name: u.name })}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 12px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text)',
                  fontSize: 12.5,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--line)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
              >
                <span style={{ fontWeight: 600 }}>{u.name ?? u.email}</span>
                {u.name && <span style={{ color: 'var(--muted)', marginLeft: 8 }}>{u.email}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Chip do usuário escolhido, com X pra trocar. */
export function PickedUserChip({ user, onClear }: { user: PickedUser; onClear: () => void }) {
  return (
    <span
      className="badge badge-muted"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
    >
      {user.name ? `${user.name} · ` : ''}
      {user.email}
      <button
        type="button"
        onClick={onClear}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'inherit',
          padding: 0,
          lineHeight: 1,
        }}
        aria-label="Clear selected user"
      >
        ×
      </button>
    </span>
  );
}
