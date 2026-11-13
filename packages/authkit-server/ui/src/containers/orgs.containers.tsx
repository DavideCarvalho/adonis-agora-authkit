import {
  authkitKeys,
  useCreateOrgMutationOptions,
  useDeleteOrgMutationOptions,
  useOrgQueryOptions,
  useOrgsQueryOptions,
  useUpdateOrgMutationOptions,
} from '@adonis-agora/authkit-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { useState } from 'react';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { Panel } from '../agora-kit/blocks/panel';
import { Badge } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import { Drawer } from '../components/Drawer';
import { Modal } from '../components/Modal';
import { Pagination } from '../components/Pagination';
import {
  AdminTable,
  Cell,
  Code,
  dangerButtonClass,
  Field,
  Row,
  SectionLabel,
  TextInput,
} from '../components/primitives';
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

  return (
    <Modal open={open} onClose={onClose} title="New Organization">
      <form onSubmit={handleSubmit} className="flex flex-col">
        <Field label="Name">
          <TextInput
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="Acme Inc."
            required
          />
        </Field>
        <Field label="Slug">
          <TextInput
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugTouched(true);
            }}
            placeholder="acme-inc"
            required
          />
        </Field>
        <Field label="Owner">
          {owner ? (
            <PickedUserChip user={owner} onClear={() => setOwner(null)} />
          ) : (
            <UserPicker onPick={setOwner} placeholder="Search the initial owner by email…" />
          )}
        </Field>
        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending ? 'Creating…' : 'Create'}
          </Button>
        </div>
      </form>
    </Modal>
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
    ...useOrgsQueryOptions({ search: search || undefined, page, size: PAGE_SIZE }),
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

  const orgs = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  const isNotFound =
    error &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status: number }).status === 404;
  const displayError = error && !isNotFound ? error : undefined;

  return (
    <QueryBoundary
      label="Organizations"
      isLoading={isLoading}
      error={displayError}
      onRetry={refetch}
      skeleton={<SkeletonPanelTable rows={6} cols={4} />}
    >
      <Panel title="All organizations" description={`${total.toLocaleString()} total`} flush>
        {orgs.length === 0 ? (
          <EmptyState
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <path d="M17.5 14v7M14 17.5h7" strokeLinecap="round" />
              </svg>
            }
            title="No organizations"
            description={search ? 'No results for your search' : 'No organizations created yet'}
            action={!search ? <Button onClick={onCreateClick}>New organization</Button> : undefined}
          />
        ) : (
          <>
            <AdminTable head={['Name', 'Slug', 'Members', 'Created']} label="Organizations">
              {orgs.map((o) => (
                <Row key={o.id} onClick={() => onSelectOrg(o.id)}>
                  <Cell strong>{o.name}</Cell>
                  <Cell>
                    <Code>{o.slug}</Code>
                  </Cell>
                  <Cell className="mono text-[11px]">{o.memberCount ?? '—'}</Cell>
                  <Cell className="mono text-[11px] text-faint">
                    {o.createdAt ? new Date(o.createdAt).toLocaleDateString() : '—'}
                  </Cell>
                </Row>
              ))}
            </AdminTable>
            <Pagination page={page} total={total} size={PAGE_SIZE} onPage={onPage} />
          </>
        )}
      </Panel>
    </QueryBoundary>
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
    <form onSubmit={handleSubmit} className="flex flex-col">
      <Field label="Name" className="mb-2.5">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Logo URL" className="mb-2.5">
        <TextInput
          value={logoUrl}
          onChange={(e) => setLogoUrl(e.target.value)}
          placeholder="https://…"
        />
      </Field>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={updateMutation.isPending}>
          {updateMutation.isPending ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** A drawer section's CAPS heading with an action on the right. */
function DrawerSectionHead({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between text-[10.5px] font-semibold tracking-[0.12em] text-faint uppercase">
      {children}
    </div>
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
      label="Organization"
      isLoading={isLoading}
      error={error}
      onRetry={refetch}
      skeleton={<SkeletonDrawerSection />}
    >
      {detail && (
        <div className="flex flex-col gap-5">
          {/* ── Info / Edit ── */}
          <div>
            <DrawerSectionHead>
              <span>Info</span>
              {!editing && (
                <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
            </DrawerSectionHead>
            {editing ? (
              <EditOrgSection
                orgId={orgId}
                currentName={detail.name}
                currentLogoUrl={detail.logoUrl}
                onDone={() => setEditing(false)}
              />
            ) : (
              <>
                <Code className="block">{detail.id}</Code>
                <div className="mt-1.5 text-xs">
                  <Badge variant="neutral">{detail.slug}</Badge>
                </div>
              </>
            )}
          </div>

          {/* ── Members ── */}
          <div>
            <DrawerSectionHead>
              <span>Members ({detail.members.length})</span>
              {!addingMember && (
                <Button variant="ghost" size="sm" onClick={() => setAddingMember(true)}>
                  + Add
                </Button>
              )}
            </DrawerSectionHead>
            {addingMember && (
              <div className="mb-2.5">
                <AddMemberSection orgId={orgId} onDone={() => setAddingMember(false)} />
              </div>
            )}
            {detail.members.map((m) => (
              <MemberRow key={m.accountId} orgId={orgId} member={m} />
            ))}
          </div>

          {/* ── Pending Invitations ── */}
          <div>
            <DrawerSectionHead>
              <span>Pending Invitations ({detail.pendingInvitations.length})</span>
              {!inviting && (
                <Button variant="ghost" size="sm" onClick={() => setInviting(true)}>
                  + Invite
                </Button>
              )}
            </DrawerSectionHead>
            {inviting && (
              <div className="mb-2.5">
                <InviteSection orgId={orgId} onDone={() => setInviting(false)} />
              </div>
            )}
            {detail.pendingInvitations.length === 0 && !inviting && (
              <div className="text-xs text-faint">No pending invitations</div>
            )}
            {detail.pendingInvitations.map((inv) => (
              <InvitationRow key={inv.id} orgId={orgId} invitation={inv} />
            ))}
          </div>

          {/* ── Organization Settings ── */}
          <OrgSettingsSection orgId={orgId} />

          {/* ── Danger Zone ── */}
          <div className="border-t border-border pt-4">
            <SectionLabel className="text-[10.5px] text-bad">Danger Zone</SectionLabel>
            {confirmDelete ? (
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="text-dim">Delete this organization?</span>
                <Button
                  variant="outline"
                  size="sm"
                  className={dangerButtonClass}
                  onClick={handleDelete}
                  disabled={deleteMutation.isPending}
                >
                  {deleteMutation.isPending ? 'Deleting…' : 'Yes, delete'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className={dangerButtonClass}
                onClick={() => setConfirmDelete(true)}
              >
                Delete organization
              </Button>
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
  const { data } = useQuery(
    useOrgsQueryOptions({ search: search || undefined, page: 1, size: PAGE_SIZE }),
  );
  return data?.meta.total ?? 0;
}
