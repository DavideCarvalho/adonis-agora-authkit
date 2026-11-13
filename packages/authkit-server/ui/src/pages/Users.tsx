import { authkitKeys, useCreateUserMutationOptions } from '@adonis-agora/authkit-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { parseAsInteger, parseAsString, useQueryState } from 'nuqs';
import type React from 'react';
import { useState } from 'react';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { PageBody } from '../agora-kit/shell/app-shell';
import { Button } from '../agora-kit/ui/button';
import { Modal } from '../components/Modal';
import { CheckboxRow, Field, SearchInput, TextInput } from '../components/primitives';
import { UserDetailDrawer, UsersTableContainer } from '../containers/users.containers';
import { useToast } from '../lib/toast';
import { useDebounce } from '../lib/use_debounce';

export function Users() {
  const toast = useToast();
  const queryClient = useQueryClient();

  // Estado de rota (URL): paginação, busca e drawer de detalhe via nuqs.
  const [page, setPage] = useQueryState('page', parseAsInteger.withDefault(1));
  const [search, setSearch] = useQueryState('q', parseAsString.withDefault(''));
  const [detailUserId, setDetailUserId] = useQueryState('user');
  const dSearch = useDebounce(search, 300);

  // Estado efêmero de UI (modal/form) permanece local.
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    email: '',
    name: '',
    password: '',
    invite: false,
  });

  const createMutation = useMutation(useCreateUserMutationOptions());

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    try {
      await createMutation.mutateAsync({
        email: createForm.email,
        name: createForm.name || undefined,
        password: createForm.password || undefined,
        invite: createForm.invite,
      });
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.users() });
      toast.success('User created');
      setCreateOpen(false);
      setCreateForm({ email: '', name: '', password: '', invite: false });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <PageBody>
      <PageHeader
        title="Users"
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M8 2v12M2 8h12" strokeLinecap="round" />
            </svg>
            New User
          </Button>
        }
      />

      {/* Search bar */}
      <div className="agora-surface rounded-lg border border-border px-4 py-3">
        <SearchInput
          wrapperClassName="max-w-[320px] flex-1"
          placeholder="Search by email or name…"
          aria-label="Search by email or name"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>

      {/* Users table container */}
      <UsersTableContainer
        search={dSearch}
        page={page}
        onPage={setPage}
        onSelectUser={setDetailUserId}
        onInvalidate={() => queryClient.invalidateQueries({ queryKey: authkitKeys.admin.users() })}
      />

      {/* Create modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create User"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Creating…' : 'Create User'}
            </Button>
          </>
        }
      >
        <form onSubmit={handleCreate}>
          <Field label="Email *" htmlFor="create-user-email">
            <TextInput
              id="create-user-email"
              type="email"
              required
              value={createForm.email}
              onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="user@example.com"
            />
          </Field>
          <Field label="Name" htmlFor="create-user-name">
            <TextInput
              id="create-user-name"
              value={createForm.name}
              onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Full name (optional)"
            />
          </Field>
          <Field label="Password" htmlFor="create-user-password">
            <TextInput
              id="create-user-password"
              type="password"
              value={createForm.password}
              onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))}
              placeholder="Leave blank to send invite"
            />
          </Field>
          <CheckboxRow
            checked={createForm.invite}
            onChange={(invite) => setCreateForm((f) => ({ ...f, invite }))}
            label="Send invitation email"
          />
        </form>
      </Modal>

      {/* Detail drawer */}
      {detailUserId && (
        <UserDetailDrawer
          userId={detailUserId}
          onClose={() => setDetailUserId(null)}
          onMutated={() => queryClient.invalidateQueries({ queryKey: authkitKeys.admin.users() })}
        />
      )}
    </PageBody>
  );
}
