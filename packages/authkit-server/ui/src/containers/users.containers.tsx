import type { ImpersonationPanel } from '@adonis-agora/authkit-react';
import {
  authkitKeys,
  useDeleteUserMutationOptions,
  useDisableUserMutationOptions,
  useEnableUserMutationOptions,
  useImpersonationQueryOptions,
  useResetPasswordMutationOptions,
  useRevokeUserSessionsMutationOptions,
  useUpdateUserMutationOptions,
  useUserQueryOptions,
  useUserSessionsQueryOptions,
  useUsersQueryOptions,
} from '@adonis-agora/authkit-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { Badge } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import { Drawer } from '../components/Drawer';
import { Modal } from '../components/Modal';
import { Pagination } from '../components/Pagination';
import {
  AdminTable,
  Cell,
  CheckboxRow,
  Code,
  dangerButtonClass,
  InitialsAvatar,
  Row,
  SectionLabel,
  Surface,
} from '../components/primitives';
import { QueryBoundary } from '../components/QueryBoundary';
import { Skeleton, SkeletonTable } from '../components/Skeleton';
import { getConfig } from '../lib/config';
import { useToast } from '../lib/toast';

/** Page size sent as `?size=` to `GET {prefix}/api/users`. */
const PAGE_SIZE = 20;

// ── UsersTableContainer ───────────────────────────────────────────────────────

interface UsersTableContainerProps {
  search: string;
  page: number;
  onPage: (p: number) => void;
  onSelectUser: (id: string) => void;
  onInvalidate: () => void;
}

export function UsersTableContainer({
  search,
  page,
  onPage,
  onSelectUser,
}: UsersTableContainerProps) {
  const { data, isLoading, error, refetch } = useQuery(
    useUsersQueryOptions({ search, page, size: PAGE_SIZE }),
  );
  const users = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  return (
    <>
      {/* Sub-count shown outside the boundary */}
      {!isLoading && !error && (
        <div className="-mt-2 text-xs text-faint">{total.toLocaleString()} accounts</div>
      )}

      <Surface>
        <QueryBoundary
          label="Users"
          isLoading={isLoading}
          error={error}
          onRetry={refetch}
          skeleton={<SkeletonTable rows={6} cols={3} />}
        >
          {users.length === 0 ? (
            <EmptyState
              icon={
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 20c0-4.42 3.58-8 8-8s8 3.58 8 8" />
                </svg>
              }
              title="No users found"
              description={search ? 'Try a different search term' : 'No accounts registered yet'}
            />
          ) : (
            <>
              <AdminTable head={['User', 'Roles', 'Status']} label="Users">
                {users.map((u) => (
                  <Row key={u.id} onClick={() => onSelectUser(u.id)}>
                    <Cell>
                      <div className="flex items-center gap-2.5">
                        <InitialsAvatar text={u.email.slice(0, 2).toUpperCase()} size={26} />
                        <div className="min-w-0">
                          <div className="truncate text-[12.5px] font-medium text-fg">
                            {u.email}
                          </div>
                          {u.name && <div className="text-[11px] text-faint">{u.name}</div>}
                        </div>
                      </div>
                    </Cell>
                    <Cell>
                      <div className="flex flex-wrap gap-1">
                        {(u.roles ?? u.globalRoles).length === 0 ? (
                          <Badge variant="neutral">no roles</Badge>
                        ) : (
                          (u.roles ?? u.globalRoles).map((r) => (
                            <Badge key={r} variant="brand">
                              {r}
                            </Badge>
                          ))
                        )}
                      </div>
                    </Cell>
                    <Cell>
                      <Badge variant={u.disabled ? 'destructive' : 'good'}>
                        {u.disabled ? 'disabled' : 'active'}
                      </Badge>
                    </Cell>
                  </Row>
                ))}
              </AdminTable>
              <Pagination page={page} total={total} size={PAGE_SIZE} onPage={onPage} />
            </>
          )}
        </QueryBoundary>
      </Surface>
    </>
  );
}

// ── UserInfoContainer ─────────────────────────────────────────────────────────

interface UserInfoContainerProps {
  userId: string;
  onMutated: () => void;
  onClose: () => void;
}

export function UserInfoContainer({ userId, onMutated, onClose }: UserInfoContainerProps) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data: user, isLoading, error, refetch } = useQuery(useUserQueryOptions(userId));

  const disableMutation = useMutation(useDisableUserMutationOptions(userId));
  const enableMutation = useMutation(useEnableUserMutationOptions(userId));
  const resetPwMutation = useMutation(useResetPasswordMutationOptions(userId));
  const deleteMutation = useMutation(useDeleteUserMutationOptions(userId));
  const revokeSessionsMutation = useMutation(useRevokeUserSessionsMutationOptions(userId));

  const impersonationQuery = useQuery({
    ...useImpersonationQueryOptions(userId),
    enabled: false,
  });
  const [impersonationPanel, setImpersonationPanel] = useState<ImpersonationPanel | null>(null);

  async function handleToggleDisable() {
    if (!user) return;
    try {
      if (user.disabled) {
        await enableMutation.mutateAsync();
        toast.success('User enabled');
      } else {
        await disableMutation.mutateAsync();
        toast.success('User disabled');
      }
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.user(userId) });
      onMutated();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleResetPassword() {
    try {
      await resetPwMutation.mutateAsync();
      toast.success('Reset email sent');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete() {
    if (!user) return;
    if (!confirm(`Delete user ${user.email}? This cannot be undone.`)) return;
    try {
      await deleteMutation.mutateAsync();
      toast.success('User deleted');
      onClose();
      onMutated();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRevokeSessions() {
    if (!user) return;
    if (
      !confirm(
        `Disconnect ${user.email} from all devices? Every active session and grant will be revoked.`,
      )
    )
      return;
    try {
      const result = await revokeSessionsMutation.mutateAsync();
      toast.success(
        `Disconnected from all devices${typeof result?.revoked === 'number' ? ` (${result.revoked} sessions)` : ''}`,
      );
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.userSessions(userId) });
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Impersonation is an RFC 8693 token exchange, and the exchange needs the
   * ADMIN'S OWN access token as `subject_token` — something this console, which
   * authenticates with a session cookie, does not hold. So there is no URL to
   * open: the endpoint returns the exchange parameters, and we show them.
   *
   * The previous version opened `result.data.url`, a field the server has never
   * returned. It type-checked only because the panel type carried an index
   * signature, and it always landed on `window.open(undefined)`.
   */
  async function handleImpersonate() {
    const result = await impersonationQuery.refetch();
    if (result.error) {
      toast.error(
        result.error instanceof Error ? result.error.message : 'Impersonation not available',
      );
      return;
    }
    if (!result.data) {
      toast.error('Impersonation not available');
      return;
    }
    setImpersonationPanel(result.data);
  }

  async function copyToClipboard(value: string, what: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${what} copied`);
    } catch {
      toast.error('Could not copy to the clipboard');
    }
  }

  return (
    <QueryBoundary
      isLoading={isLoading}
      error={error}
      onRetry={refetch}
      label="User"
      skeleton={
        <div className="mb-4 flex items-center gap-3" aria-hidden>
          <Skeleton width={44} height={44} borderRadius="50%" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton width="60%" height={14} />
            <Skeleton width="40%" height={11} />
          </div>
        </div>
      }
    >
      {user && (
        <div>
          {/* Info */}
          <div className="mb-4 flex items-center gap-3">
            <InitialsAvatar text={user.email.slice(0, 2).toUpperCase()} size={44} />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-fg">{user.email}</div>
              {user.name && <div className="text-xs text-faint">{user.name}</div>}
              <div className="mt-1">
                <Badge variant={user.disabled ? 'destructive' : 'good'}>
                  {user.disabled ? 'disabled' : 'active'}
                </Badge>
              </div>
            </div>
          </div>
          <Code className="block px-2.5 py-1.5 text-[11px]">ID: {user.id}</Code>

          {/* Actions */}
          <div className="mt-4">
            <SectionLabel className="text-[10.5px]">Actions</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className={user.disabled ? undefined : dangerButtonClass}
                onClick={handleToggleDisable}
                disabled={disableMutation.isPending || enableMutation.isPending}
              >
                {user.disabled ? 'Enable account' : 'Disable account'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleResetPassword}
                disabled={resetPwMutation.isPending}
              >
                Reset password
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleImpersonate}
                disabled={impersonationQuery.isFetching}
              >
                Impersonate
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={dangerButtonClass}
                onClick={handleRevokeSessions}
                disabled={revokeSessionsMutation.isPending}
              >
                Disconnect all devices
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={dangerButtonClass}
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
              >
                Delete user
              </Button>
            </div>
          </div>

          <Modal
            open={impersonationPanel !== null}
            onClose={() => setImpersonationPanel(null)}
            title={`Impersonate ${impersonationPanel?.targetEmail ?? ''}`}
            large
            footer={
              <Button variant="outline" size="sm" onClick={() => setImpersonationPanel(null)}>
                Close
              </Button>
            }
          >
            {impersonationPanel && (
              <div className="flex flex-col gap-3.5">
                <p className="m-0 text-[13px] text-faint [&_code]:mono [&_code]:text-dim">
                  Impersonation runs through the RFC 8693 token exchange. The exchange has to be
                  signed with <strong>your own admin access token</strong> as the{' '}
                  <code>subject_token</code>, which this console does not hold — so run the request
                  below from wherever you already have that token. The issued <code>id_token</code>{' '}
                  carries <code>act</code> with your subject, and the exchange is audited.
                </p>

                <div className="grid gap-1.5">
                  <PanelRow label="Token endpoint" value={impersonationPanel.tokenEndpoint} />
                  <PanelRow label="Client" value={impersonationPanel.clientId} />
                  <PanelRow label="Grant type" value={impersonationPanel.grantType} />
                  <PanelRow
                    label="Subject token type"
                    value={impersonationPanel.subjectTokenType}
                  />
                  <PanelRow label="Requested subject" value={impersonationPanel.requestedSubject} />
                </div>

                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-xs text-faint">Request</span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => copyToClipboard(impersonationPanel.curl, 'Command')}
                    >
                      Copy
                    </Button>
                  </div>
                  <pre className="mono m-0 rounded-md border border-border bg-panel-2 px-2 py-0.5 text-[11px] break-all whitespace-pre-wrap text-dim">
                    {impersonationPanel.curl}
                  </pre>
                </div>
              </div>
            )}
          </Modal>
        </div>
      )}
    </QueryBoundary>
  );
}

/** One label/value line of the impersonation panel. */
function PanelRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 text-xs sm:flex-row sm:gap-2.5">
      <span className="min-w-[140px] text-faint">{label}</span>
      <Code className="px-1.5 text-[11px]">{value}</Code>
    </div>
  );
}

// ── UserRolesContainer ────────────────────────────────────────────────────────

interface UserRolesContainerProps {
  userId: string;
  onMutated: () => void;
}

export function UserRolesContainer({ userId, onMutated }: UserRolesContainerProps) {
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data: user, isLoading, error, refetch } = useQuery(useUserQueryOptions(userId));
  const updateRolesMutation = useMutation(useUpdateUserMutationOptions(userId));
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const rolesManagedExternally = getConfig().features?.rolesManagedExternally === true;

  useEffect(() => {
    if (user) setSelectedRoles(user.globalRoles);
  }, [user]);

  const toggleRole = (name: string) => {
    setSelectedRoles((prev) =>
      prev.includes(name) ? prev.filter((r) => r !== name) : [...prev, name],
    );
  };

  async function handleUpdateRoles() {
    try {
      await updateRolesMutation.mutateAsync({ globalRoles: selectedRoles });
      toast.success('Roles updated');
      queryClient.invalidateQueries({ queryKey: authkitKeys.admin.user(userId) });
      onMutated();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div>
      <SectionLabel className="text-[10.5px]">Global Roles</SectionLabel>
      <QueryBoundary
        label="Roles"
        isLoading={isLoading}
        error={error}
        onRetry={refetch}
        skeleton={
          <div className="flex flex-col gap-2" aria-hidden>
            <Skeleton height={20} />
            <Skeleton height={20} />
          </div>
        }
      >
        {user && rolesManagedExternally && (
          <>
            <div className="mb-2 flex flex-wrap gap-1">
              {(user.roles ?? []).length === 0 ? (
                <Badge variant="neutral">no roles</Badge>
              ) : (
                (user.roles ?? []).map((r) => (
                  <Badge key={r} variant="brand">
                    {r}
                  </Badge>
                ))
              )}
            </div>
            <div className="text-xs text-faint">
              Roles come from the application (resolveTokenRoles) and are managed there.
            </div>
          </>
        )}
        {user && !rolesManagedExternally && (
          <>
            {selectedRoles.length === 0 && (
              <div className="mb-2 text-xs text-faint">No roles assigned</div>
            )}
            {user.globalRoles.map((r) => (
              <CheckboxRow
                key={r}
                checked={selectedRoles.includes(r)}
                onChange={() => toggleRole(r)}
                label={r}
              />
            ))}
            <Button
              size="sm"
              className="mt-2.5"
              onClick={handleUpdateRoles}
              disabled={updateRolesMutation.isPending}
            >
              {updateRolesMutation.isPending ? 'Saving…' : 'Save roles'}
            </Button>
          </>
        )}
      </QueryBoundary>
    </div>
  );
}

// ── UserSessionsContainer ─────────────────────────────────────────────────────

interface UserSessionsContainerProps {
  userId: string;
}

export function UserSessionsContainer({ userId }: UserSessionsContainerProps) {
  const {
    data: sessionsData,
    isLoading,
    error,
    refetch,
  } = useQuery(useUserSessionsQueryOptions(userId));
  const sessions = sessionsData?.sessions ?? [];

  return (
    <div>
      <SectionLabel className="text-[10.5px]">
        Sessions {!isLoading && !error ? `(${sessions.length})` : ''}
      </SectionLabel>
      <QueryBoundary
        label="Sessions"
        isLoading={isLoading}
        error={error}
        onRetry={refetch}
        skeleton={
          <div className="flex flex-col gap-2" aria-hidden>
            <Skeleton height={44} />
            <Skeleton height={44} />
          </div>
        }
      >
        {sessions.length === 0 ? (
          <div className="text-xs text-faint">No active sessions</div>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              className="agora-surface mb-2 rounded-lg border border-border px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  className="text-dim"
                  aria-hidden="true"
                >
                  <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
                  <circle cx="8" cy="8.5" r="2" />
                </svg>
                <span className="font-medium text-fg">{s.browser ?? 'Unknown browser'}</span>
                <span className="text-faint">{s.os}</span>
                <Code className="ml-auto">{s.ip ?? '—'}</Code>
              </div>
              {s.location && <div className="mt-1 text-[11px] text-faint">{s.location}</div>}
            </div>
          ))
        )}
      </QueryBoundary>
    </div>
  );
}

// ── UserDetailDrawer (composed from containers) ───────────────────────────────

interface UserDetailDrawerProps {
  userId: string;
  onClose: () => void;
  onMutated: () => void;
}

export function UserDetailDrawer({ userId, onClose, onMutated }: UserDetailDrawerProps) {
  const { data: user } = useQuery(useUserQueryOptions(userId));

  return (
    <Drawer open={true} onClose={onClose} title={user?.email ?? 'User detail'}>
      <div className="flex flex-col gap-5">
        <UserInfoContainer userId={userId} onMutated={onMutated} onClose={onClose} />
        <UserRolesContainer userId={userId} onMutated={onMutated} />
        <UserSessionsContainer userId={userId} />
      </div>
    </Drawer>
  );
}
