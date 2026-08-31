import {
  authkitKeys,
  type RoleCatalogEntry,
  useAuthkitClient,
  useCreateRoleMutationOptions,
} from '@adonis-agora/authkit-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Modal } from '../components/Modal';
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
      <div>
        <div className="page-title" style={{ marginBottom: 8 }}>
          Roles
        </div>
        <div className="error-box">
          Role catalog requires the <code>auth_settings</code> table (runtime settings). Run the
          migration to enable this feature.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header-row">
        <div>
          <div className="page-title">Roles</div>
          <div className="page-sub">Global role catalog</div>
        </div>
        <div className="page-actions">
          <button
            className="btn btn-primary"
            onClick={() => {
              setForm({ name: '', description: '' });
              setCreateOpen(true);
            }}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M8 2v12M2 8h12" strokeLinecap="round" />
            </svg>
            New Role
          </button>
        </div>
      </div>

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
            <button className="btn" onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>
              {saving ? <span className="spinner sm" /> : 'Create Role'}
            </button>
          </>
        }
      >
        <form onSubmit={handleCreate}>
          <div className="field">
            <label>Name * (uppercase)</label>
            <input
              className="input input-mono"
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value.toUpperCase() }))}
              placeholder="EDITOR"
            />
            <div className="hint">Letters, digits, underscore. E.g. ADMIN, CONTENT_MANAGER</div>
          </div>
          <div className="field">
            <label>Description</label>
            <input
              className="input"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Can edit content"
            />
          </div>
        </form>
      </Modal>

      {/* Edit modal */}
      <Modal
        open={!!editRole}
        onClose={() => setEditRole(null)}
        title={`Edit Role — ${editRole?.name}`}
        footer={
          <>
            <button className="btn" onClick={() => setEditRole(null)}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={handleUpdate} disabled={saving}>
              {saving ? <span className="spinner sm" /> : 'Save'}
            </button>
          </>
        }
      >
        <div className="field">
          <label>Description</label>
          <input
            className="input"
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </div>
      </Modal>
    </div>
  );
}
