import {
  authkitKeys,
  useCreateOrgMutationOptions,
  useDeleteOrgMutationOptions,
  useOrgQueryOptions,
  useOrgsQueryOptions,
  useUpdateOrgMutationOptions,
} from '@adonis-agora/authkit-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Drawer } from '../components/Drawer';
import { Pagination } from '../components/Pagination';
import { QueryBoundary } from '../components/QueryBoundary';
import { SkeletonDrawerSection, SkeletonPanelTable } from '../components/Skeleton';
import { type PickedUser, PickedUserChip, UserPicker } from '../components/UserPicker';
import { useToast } from '../lib/toast';
import {
  AddMemberSection,
  InvitationRow,
  InviteSection,
  MemberRow,
} from './org_members.containers';
import { OrgSettingsSection } from './org_settings.containers';

const PAGE_SIZE = 20;

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(s: string) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── CreateOrgModal ────────────────────────────────────────────────────────────

interface CreateOrgModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateOrgModal({ open, onClose, onCreated }: CreateOrgModalProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [owner, setOwner] = useState<PickedUser | null>(null);

  const createMutation = useMutation(useCreateOrgMutationOptions());

  function handleNameChange(v: string) {
    setName(v);
    if (!slugTouched) setSlug(slugify(v));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !slug.trim() || !owner) return;
    try {
      await createMutation.mutateAsync({
        name: name.trim(),
        slug: slug.trim(),
        ownerAccountId: owner.id,
      });
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.orgs() });
      toast.success('Organization created');
      setName('');
      setSlug('');
      setOwner(null);
      setSlugTouched(false);
      onCreated();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to create organization');
    }
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>New Organization</span>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label className="field-label">Name</label>
            <input
              className="input"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="Acme Inc."
              required
            />
          </div>
          <div>
            <label className="field-label">Slug</label>
            <input
              className="input"
              value={slug}
              onChange={(e) => {
                setSlug(e.target.value);
                setSlugTouched(true);
              }}
              placeholder="acme-inc"
              required
            />
          </div>
          <div>
            <label className="field-label">Owner</label>
            {owner ? (
              <PickedUserChip user={owner} onClear={() => setOwner(null)} />
            ) : (
              <UserPicker onPick={setOwner} placeholder="Search the initial owner by email…" />
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── OrgsTableContainer ────────────────────────────────────────────────────────

interface OrgsTableContainerProps {
  search: string;
  page: number;
  onPage: (p: number) => void;
  onSelectOrg: (id: string) => void;
  onUnavailable: () => void;
  onCreateClick: () => void;
}

export function OrgsTableContainer({
  search,
  page,
  onPage,
  onSelectOrg,
  onUnavailable,
  onCreateClick,
}: OrgsTableContainerProps) {
  const [checkedUnavailable, setCheckedUnavailable] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    ...useOrgsQueryOptions(),
    retry: (failureCount, err: unknown) => {
      if (
        err &&
        typeof err === 'object' &&
        'status' in err &&
        (err as { status: number }).status === 404
      ) {
        if (!checkedUnavailable) {
          setCheckedUnavailable(true);
          onUnavailable();
        }
        return false;
      }
      return failureCount < 1;
    },
  });

  const allOrgs = data?.data ?? [];
  const filtered = search
    ? allOrgs.filter(
        (o) =>
          o.name.toLowerCase().includes(search.toLowerCase()) ||
          o.slug.toLowerCase().includes(search.toLowerCase()),
      )
    : allOrgs;
  const total = filtered.length;
  const orgs = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const isNotFound =
    error &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status: number }).status === 404;
  const displayError = error && !isNotFound ? error : undefined;

  return (
    <div className="panel">
      <QueryBoundary
        isLoading={isLoading}
        error={displayError}
        onRetry={refetch}
        skeleton={<SkeletonPanelTable rows={6} cols={4} />}
      >
        {orgs.length === 0 ? (
          <div className="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <path d="M17.5 14v7M14 17.5h7" strokeLinecap="round" />
            </svg>
            <h4>No organizations</h4>
            <p>{search ? 'No results for your search' : 'No organizations created yet'}</p>
            {!search && (
              <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={onCreateClick}>
                New organization
              </button>
            )}
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Slug</th>
                  <th>Members</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {orgs.map((o) => (
                  <tr key={o.id} onClick={() => onSelectOrg(o.id)}>
                    <td>
                      <b>{o.name}</b>
                    </td>
                    <td>
                      <span className="code">{o.slug}</span>
                    </td>
                    <td>
                      <span className="mono text-sm">{o.memberCount ?? '—'}</span>
                    </td>
                    <td>
                      <span
                        style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--faint)' }}
                      >
                        {o.createdAt ? new Date(o.createdAt).toLocaleDateString() : '—'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ padding: '0 16px 12px' }}>
              <Pagination page={page} total={total} size={PAGE_SIZE} onPage={onPage} />
            </div>
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}

// ── EditOrgSection ────────────────────────────────────────────────────────────

interface EditOrgSectionProps {
  orgId: string;
  currentName: string;
  currentLogoUrl: string | null;
  onDone: () => void;
}

function EditOrgSection({ orgId, currentName, currentLogoUrl, onDone }: EditOrgSectionProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(currentName);
  const [logoUrl, setLogoUrl] = useState(currentLogoUrl ?? '');

  const updateMutation = useMutation(useUpdateOrgMutationOptions(orgId));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await updateMutation.mutateAsync({
        name: name.trim() || undefined,
        logoUrl: logoUrl.trim() || null,
      });
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.orgs() });
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.org(orgId) });
      toast.success('Organization updated');
      onDone();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to update organization');
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <label className="field-label">Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <label className="field-label">Logo URL</label>
        <input
          className="input"
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.target.value)}
          placeholder="https://…"
        />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={updateMutation.isPending}
        >
          {updateMutation.isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── OrgDetailContent ──────────────────────────────────────────────────────────

interface OrgDetailContentProps {
  orgId: string;
  onDeleted: () => void;
}

function OrgDetailContent({ orgId, onDeleted }: OrgDetailContentProps) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { data: detail, isLoading, error, refetch } = useQuery(useOrgQueryOptions(orgId));
  const [editing, setEditing] = useState(false);
  const [addingMember, setAddingMember] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const deleteMutation = useMutation(useDeleteOrgMutationOptions(orgId));

  async function handleDelete() {
    try {
      await deleteMutation.mutateAsync();
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.orgs() });
      toast.success('Organization deleted');
      onDeleted();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete organization');
    }
  }

  return (
    <QueryBoundary
      isLoading={isLoading}
      error={error}
      onRetry={refetch}
      skeleton={<SkeletonDrawerSection />}
    >
      {detail && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* ── Info / Edit ── */}
          <div>
            <div
              style={{
                fontSize: 10.5,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--faint)',
                fontWeight: 600,
                marginBottom: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>Info</span>
              {!editing && (
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(true)}>
                  Edit
                </button>
              )}
            </div>
            {editing ? (
              <EditOrgSection
                orgId={orgId}
                currentName={detail.name}
                currentLogoUrl={detail.logoUrl}
                onDone={() => setEditing(false)}
              />
            ) : (
              <>
                <div className="code">{detail.id}</div>
                <div style={{ marginTop: 6, fontSize: 12 }}>
                  <span className="badge badge-muted">{detail.slug}</span>
                </div>
              </>
            )}
          </div>

          {/* ── Members ── */}
          <div>
            <div
              style={{
                fontSize: 10.5,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--faint)',
                fontWeight: 600,
                marginBottom: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>Members ({detail.members.length})</span>
              {!addingMember && (
                <button className="btn btn-ghost btn-sm" onClick={() => setAddingMember(true)}>
                  + Add
                </button>
              )}
            </div>
            {addingMember && (
              <div style={{ marginBottom: 10 }}>
                <AddMemberSection orgId={orgId} onDone={() => setAddingMember(false)} />
              </div>
            )}
            {detail.members.map((m) => (
              <MemberRow key={m.accountId} orgId={orgId} member={m} />
            ))}
          </div>

          {/* ── Pending Invitations ── */}
          <div>
            <div
              style={{
                fontSize: 10.5,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--faint)',
                fontWeight: 600,
                marginBottom: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>Pending Invitations ({detail.pendingInvitations.length})</span>
              {!inviting && (
                <button className="btn btn-ghost btn-sm" onClick={() => setInviting(true)}>
                  + Invite
                </button>
              )}
            </div>
            {inviting && (
              <div style={{ marginBottom: 10 }}>
                <InviteSection orgId={orgId} onDone={() => setInviting(false)} />
              </div>
            )}
            {detail.pendingInvitations.length === 0 && !inviting && (
              <div style={{ fontSize: 12, color: 'var(--faint)' }}>No pending invitations</div>
            )}
            {detail.pendingInvitations.map((inv) => (
              <InvitationRow key={inv.id} orgId={orgId} invitation={inv} />
            ))}
          </div>

          {/* ── Organization Settings ── */}
          <OrgSettingsSection orgId={orgId} />

          {/* ── Danger Zone ── */}
          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}>
            <div
              style={{
                fontSize: 10.5,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--danger, #e53e3e)',
                fontWeight: 600,
                marginBottom: 8,
              }}
            >
              Danger Zone
            </div>
            {confirmDelete ? (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <span style={{ color: 'var(--muted)' }}>Delete this organization?</span>
                <button
                  className="btn btn-danger btn-sm"
                  onClick={handleDelete}
                  disabled={deleteMutation.isPending}
                >
                  {deleteMutation.isPending ? 'Deleting…' : 'Yes, delete'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(true)}>
                Delete organization
              </button>
            )}
          </div>
        </div>
      )}
    </QueryBoundary>
  );
}

// ── OrgDetailDrawer ───────────────────────────────────────────────────────────

interface OrgDetailDrawerProps {
  orgId: string;
  onClose: () => void;
}

export function OrgDetailDrawer({ orgId, onClose }: OrgDetailDrawerProps) {
  const { data: detail } = useQuery(useOrgQueryOptions(orgId));

  return (
    <Drawer open={true} onClose={onClose} title={detail?.name ?? 'Organization'}>
      <OrgDetailContent orgId={orgId} onDeleted={onClose} />
    </Drawer>
  );
}

// ── Re-export count for page header ──────────────────────────────────────────

export function useOrgsTotal(search: string) {
  const { data } = useQuery(useOrgsQueryOptions());
  const allOrgs = data?.data ?? [];
  const filtered = search
    ? allOrgs.filter(
        (o) =>
          o.name.toLowerCase().includes(search.toLowerCase()) ||
          o.slug.toLowerCase().includes(search.toLowerCase()),
      )
    : allOrgs;
  return filtered.length;
}
