import {
  authkitKeys,
  type RoleCatalogEntry,
  useAuthkitClient,
  useCreateRoleMutationOptions,
} from '@adonis-agora/authkit-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { PageBody } from '../agora-kit/shell/app-shell';
import { Button } from '../agora-kit/ui/button';
import { Modal } from '../components/Modal';
import { Field, Notice, TextInput } from '../components/primitives';
import { RolesTableContainer } from '../containers/roles.containers';
import { useToast } from '../lib/toast';

export function Roles() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const authkitClient = useAuthkitClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [editRole, setEditRole] = useState<RoleCatalogEntry | null>(null);
  const [form, setForm] = useState({ name: '', description: '' });
  const [saving, setSaving] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  const createMutation = useMutation(useCreateRoleMutationOptions());

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await createMutation.mutateAsync({
        name: form.name.trim().toUpperCase(),
        description: form.description || undefined,
      });
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.roles() });
      toast.success('Role created');
      setCreateOpen(false);
      setForm({ name: '', description: '' });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate(e: React.FormEvent) {
    e.preventDefault();
    if (!editRole) return;
    setSaving(true);
    try {
      await authkitClient.admin.roles.update(editRole.name, {
        description: form.description || undefined,
      });
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.roles() });
      toast.success('Role updated');
      setEditRole(null);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(r: RoleCatalogEntry) {
    if (!confirm(`Delete role ${r.name}?`)) return;
    try {
      await authkitClient.admin.roles.remove(r.name);
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.roles() });
      toast.success('Role deleted');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  if (unavailable) {
    return (
      <PageBody>
        <PageHeader title="Roles" />
        <Notice>
          Role catalog requires the <code className="mono">auth_settings</code> table (runtime
          settings). Run the migration to enable this feature.
        </Notice>
      </PageBody>
    );
  }

  return (
    <PageBody>
      <PageHeader
        title="Roles"
        description="Global role catalog"
        actions={
          <Button
            onClick={() => {
              setForm({ name: '', description: '' });
              setCreateOpen(true);
            }}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 2v12M2 8h12" strokeLinecap="round" />
            </svg>
            New Role
          </Button>
        }
      />

      <RolesTableContainer
        onEdit={(r) => {
          setEditRole(r);
          setForm({ name: r.name, description: r.description ?? '' });
        }}
        onDelete={handleDelete}
        onUnavailable={() => setUnavailable(true)}
      />

      {/* Create modal */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="New Role"
        footer={
          <>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={saving}>
              {saving ? 'Creating…' : 'Create Role'}
            </Button>
          </>
        }
      >
        <form onSubmit={handleCreate}>
          <Field
            label="Name * (uppercase)"
            hint="Letters, digits, underscore. E.g. ADMIN, CONTENT_MANAGER"
          >
            <TextInput
              mono
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value.toUpperCase() }))}
              placeholder="EDITOR"
            />
          </Field>
          <Field label="Description">
            <TextInput
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Can edit content"
            />
          </Field>
        </form>
      </Modal>

      {/* Edit modal */}
      <Modal
        open={!!editRole}
        onClose={() => setEditRole(null)}
        title={`Edit Role — ${editRole?.name}`}
        footer={
          <>
            <Button variant="outline" onClick={() => setEditRole(null)}>
              Cancel
            </Button>
            <Button onClick={handleUpdate} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <Field label="Description">
          <TextInput
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </Field>
      </Modal>
    </PageBody>
  );
}
