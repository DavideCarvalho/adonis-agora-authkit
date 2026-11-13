import { type AdminUser, useUsersQueryOptions } from '@adonis-agora/authkit-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { XIcon } from '../agora-kit/icons';
import { Badge } from '../agora-kit/ui/badge';
import { useDebounce } from '../lib/use_debounce';
import { TextInput } from './primitives';

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
    ...useUsersQueryOptions({ search: dSearch, size: 6 }),
    enabled: dSearch.trim().length >= 2,
  });
  const candidates = usersQuery.data?.data ?? [];

  return (
    <div className="relative">
      <TextInput
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={placeholder ?? 'Search user by email or name…'}
        aria-label={placeholder ?? 'Search user by email or name'}
      />
      {dSearch.trim().length >= 2 && (
        <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-md border border-border bg-popover shadow-(--agora-shadow)">
          {usersQuery.isLoading ? (
            <div className="px-3 py-2 text-xs text-faint">Searching…</div>
          ) : candidates.length === 0 ? (
            <div className="px-3 py-2 text-xs text-faint">No users match.</div>
          ) : (
            candidates.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => onPick({ id: u.id, email: u.email, name: u.name })}
                className="block w-full px-3 py-2 text-left text-[12.5px] text-fg hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
              >
                <span className="font-semibold">{u.name ?? u.email}</span>
                {u.name && <span className="ml-2 text-dim">{u.email}</span>}
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
    <Badge variant="neutral">
      {user.name ? `${user.name} · ` : ''}
      {user.email}
      <button
        type="button"
        onClick={onClear}
        className="leading-none text-inherit hover:text-fg [&_svg]:size-2.5"
        aria-label="Clear selected user"
      >
        <XIcon />
      </button>
    </Badge>
  );
}
