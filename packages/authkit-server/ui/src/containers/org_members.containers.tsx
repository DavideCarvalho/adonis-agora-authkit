import {
  authkitKeys,
  useAddOrgMemberMutationOptions,
  useCreateOrgInvitationMutationOptions,
  useRemoveOrgMemberMutationOptions,
  useRevokeOrgInvitationMutationOptions,
  useUpdateOrgMemberRoleMutationOptions,
} from '@adonis-agora/authkit-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { useState } from 'react';
import { XIcon } from '../agora-kit/icons';
import { Badge } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import { Field, InitialsAvatar, SelectInput, TextInput } from '../components/primitives';
import { type PickedUser, PickedUserChip, UserPicker } from '../components/UserPicker';
import { useToast } from '../lib/toast';
import { DEFAULT_ORG_ROLES } from './org_settings.containers';

// ── OrgRoleSelect ─────────────────────────────────────────────────────────────

function OrgRoleSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const roles = DEFAULT_ORG_ROLES.includes(value)
    ? DEFAULT_ORG_ROLES
    : [...DEFAULT_ORG_ROLES, value];
  return (
    <SelectInput
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-[110px]"
      aria-label="Role"
    >
      {roles.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </SelectInput>
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
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      {picked ? (
        <div className="flex flex-wrap items-center gap-2">
          <PickedUserChip user={picked} onClear={() => setPicked(null)} />
          <OrgRoleSelect value={role} onChange={setRole} />
          <Button type="submit" size="sm" disabled={addMutation.isPending}>
            {addMutation.isPending ? 'Adding…' : 'Add member'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>
            Cancel
          </Button>
        </div>
      ) : (
        <div>
          <UserPicker onPick={setPicked} />
          <div className="mt-1.5 flex justify-end">
            <Button type="button" variant="ghost" size="sm" onClick={onDone}>
              Cancel
            </Button>
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
    <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
      <Field label="Email" className="mb-0 min-w-[180px] flex-1">
        <TextInput
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="user@example.com"
          required
        />
      </Field>
      <Field label="Role" className="mb-0">
        <OrgRoleSelect value={role} onChange={setRole} />
      </Field>
      <Button type="submit" size="sm" className="h-[34px]" disabled={inviteMutation.isPending}>
        {inviteMutation.isPending ? 'Sending…' : 'Invite'}
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-[34px]" onClick={onDone}>
        Cancel
      </Button>
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
    <div className="flex items-center gap-2 border-b border-border py-1.5">
      <InitialsAvatar text={(member.email ?? '?').slice(0, 2).toUpperCase()} size={24} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-fg">{member.email ?? member.accountId}</div>
      </div>
      {editingRole ? (
        <form onSubmit={handleRoleSubmit} className="flex gap-1">
          <TextInput
            value={newRole}
            onChange={(e) => setNewRole(e.target.value)}
            aria-label="Role"
            className="h-[26px] w-20 px-1.5 text-[11px] md:text-[11px]"
          />
          <Button type="submit" size="sm" disabled={roleMutation.isPending} aria-label="Save role">
            ✓
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setEditingRole(false)}
            aria-label="Cancel"
          >
            ✕
          </Button>
        </form>
      ) : (
        <>
          <Badge
            variant="neutral"
            className="cursor-pointer bg-transparent hover:text-fg"
            title="Click to change role"
            render={<button type="button" onClick={() => setEditingRole(true)} />}
          >
            {member.role}
          </Badge>
          <Button
            variant="ghost"
            size="icon-xs"
            title="Remove member"
            aria-label="Remove member"
            onClick={handleRemove}
            disabled={removeMutation.isPending}
            className="text-bad hover:text-bad"
          >
            <XIcon />
          </Button>
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
    <div className="flex items-center gap-2 border-b border-border py-1.5">
      <div className="min-w-0 flex-1 truncate text-xs text-dim">{invitation.email}</div>
      <Badge variant="warn">{invitation.role}</Badge>
      <Button
        variant="ghost"
        size="icon-xs"
        title="Revoke invitation"
        aria-label="Revoke invitation"
        onClick={handleRevoke}
        disabled={revokeMutation.isPending}
        className="text-bad hover:text-bad"
      >
        <XIcon />
      </Button>
    </div>
  );
}
