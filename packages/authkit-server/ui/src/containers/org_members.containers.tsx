import {
  authkitKeys,
  useAddOrgMemberMutationOptions,
  useCreateOrgInvitationMutationOptions,
  useRemoveOrgMemberMutationOptions,
  useRevokeOrgInvitationMutationOptions,
  useUpdateOrgMemberRoleMutationOptions,
} from '@adonis-agora/authkit-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { type PickedUser, PickedUserChip, UserPicker } from '../components/UserPicker';
import { useToast } from '../lib/toast';
import { DEFAULT_ORG_ROLES } from './org_settings.containers';

// ── OrgRoleSelect ─────────────────────────────────────────────────────────────

function OrgRoleSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const roles = DEFAULT_ORG_ROLES.includes(value)
    ? DEFAULT_ORG_ROLES
    : [...DEFAULT_ORG_ROLES, value];
  return (
    <select
      className="input"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ width: 110 }}
    >
      {roles.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </select>
  );
}

// ── AddMemberSection ──────────────────────────────────────────────────────────

interface AddMemberSectionProps {
  orgId: string;
  onDone: () => void;
}

export function AddMemberSection({ orgId, onDone }: AddMemberSectionProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<PickedUser | null>(null);
  const [role, setRole] = useState('member');

  const addMutation = useMutation(useAddOrgMemberMutationOptions(orgId));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!picked) return;
    try {
      await addMutation.mutateAsync({ accountId: picked.id, role });
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.org(orgId) });
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.orgs() });
      toast.success(`${picked.email} added as ${role}`);
      onDone();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to add member');
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {picked ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <PickedUserChip user={picked} onClear={() => setPicked(null)} />
          <OrgRoleSelect value={role} onChange={setRole} />
          <button type="submit" className="btn btn-primary btn-sm" disabled={addMutation.isPending}>
            {addMutation.isPending ? 'Adding…' : 'Add member'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
            Cancel
          </button>
        </div>
      ) : (
        <div>
          <UserPicker onPick={setPicked} />
          <div style={{ marginTop: 6, display: 'flex', justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </form>
  );
}

// ── InviteSection ─────────────────────────────────────────────────────────────

interface InviteSectionProps {
  orgId: string;
  onDone: () => void;
}

export function InviteSection({ orgId, onDone }: InviteSectionProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');

  const inviteMutation = useMutation(useCreateOrgInvitationMutationOptions(orgId));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    try {
      await inviteMutation.mutateAsync({ email: email.trim(), role });
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.org(orgId) });
      toast.success('Invitation sent');
      setEmail('');
      onDone();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to create invitation');
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}
    >
      <div style={{ flex: 1, minWidth: 180 }}>
        <label className="field-label">Email</label>
        <input
          className="input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
          required
        />
      </div>
      <div>
        <label className="field-label">Role</label>
        <OrgRoleSelect value={role} onChange={setRole} />
      </div>
      <button type="submit" className="btn btn-primary btn-sm" disabled={inviteMutation.isPending}>
        {inviteMutation.isPending ? 'Sending…' : 'Invite'}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}

// ── MemberRow ─────────────────────────────────────────────────────────────────

export function MemberRow({
  orgId,
  member,
}: {
  orgId: string;
  member: { accountId: string; email: string | null; role: string; joinedAt: string };
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editingRole, setEditingRole] = useState(false);
  const [newRole, setNewRole] = useState(member.role);

  const removeMutation = useMutation(useRemoveOrgMemberMutationOptions(orgId, member.accountId));
  const roleMutation = useMutation(useUpdateOrgMemberRoleMutationOptions(orgId, member.accountId));

  async function handleRemove() {
    try {
      await removeMutation.mutateAsync();
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.org(orgId) });
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.orgs() });
      toast.success('Member removed');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove member');
    }
  }

  async function handleRoleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await roleMutation.mutateAsync(newRole);
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.org(orgId) });
      toast.success('Role updated');
      setEditingRole(false);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to update role');
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 0',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <div className="avatar" style={{ width: 24, height: 24, fontSize: 9 }}>
        {(member.email ?? '?').slice(0, 2).toUpperCase()}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, color: 'var(--text)' }}>{member.email ?? member.accountId}</div>
      </div>
      {editingRole ? (
        <form onSubmit={handleRoleSubmit} style={{ display: 'flex', gap: 4 }}>
          <input
            className="input"
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            style={{ width: 80, padding: '2px 6px', fontSize: 11 }}
          />
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={roleMutation.isPending}
          >
            ✓
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setEditingRole(false)}
          >
            ✕
          </button>
        </form>
      ) : (
        <>
          <button
            className="badge badge-muted"
            title="Click to change role"
            onClick={() => setEditingRole(true)}
            style={{ cursor: 'pointer', background: 'none', border: '1px solid var(--line)' }}
          >
            {member.role}
          </button>
          <button
            className="icon-btn"
            title="Remove member"
            onClick={handleRemove}
            disabled={removeMutation.isPending}
            style={{ color: 'var(--danger, #e53e3e)', fontSize: 13 }}
          >
            ✕
          </button>
        </>
      )}
    </div>
  );
}

// ── InvitationRow ─────────────────────────────────────────────────────────────

export function InvitationRow({
  orgId,
  invitation,
}: {
  orgId: string;
  invitation: { id: string; email: string; role: string; expiresAt: string };
}) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const revokeMutation = useMutation(useRevokeOrgInvitationMutationOptions(orgId, invitation.id));

  async function handleRevoke() {
    try {
      await revokeMutation.mutateAsync();
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.org(orgId) });
      toast.success('Invitation revoked');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to revoke invitation');
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 0',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <div style={{ flex: 1, fontSize: 12, color: 'var(--muted)' }}>{invitation.email}</div>
      <span className="badge badge-amber">{invitation.role}</span>
      <button
        className="icon-btn"
        title="Revoke invitation"
        onClick={handleRevoke}
        disabled={revokeMutation.isPending}
        style={{ color: 'var(--danger, #e53e3e)', fontSize: 13 }}
      >
        ✕
      </button>
    </div>
  );
}
