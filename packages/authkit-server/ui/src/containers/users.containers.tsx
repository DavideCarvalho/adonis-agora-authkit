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
import React, { useEffect, useState } from 'react';
import { Drawer } from '../components/Drawer';
import { Modal } from '../components/Modal';
import { Pagination } from '../components/Pagination';
import { QueryBoundary } from '../components/QueryBoundary';
import { SkeletonDrawerSection, SkeletonPanelTable } from '../components/Skeleton';
import { useToast } from '../lib/toast';

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
    useUsersQueryOptions({ search, page, limit: 20 }),
  );
  const users = data?.data ?? [];
  const total = data?.total ?? 0;

  return (
    <>
      {/* Sub-count shown outside the boundary */}
      {!isLoading && !error && (
        <div style={{ marginBottom: 4 }}>
          <span className="page-sub" style={{ fontSize: 12, color: 'var(--faint)' }}>
            {total.toLocaleString()} accounts
          </span>
        </div>
      )}

      <div className="panel">
        <QueryBoundary
          isLoading={isLoading}
          error={error}
          onRetry={refetch}
          skeleton={<SkeletonPanelTable rows={6} cols={3} />}
        >
          {users.length === 0 ? (
            <div className="empty-state">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c0-4.42 3.58-8 8-8s8 3.58 8 8" />
              </svg>
              <h4>No users found</h4>
              <p>{search ? 'Try a different search term' : 'No accounts registered yet'}</p>
            </div>
          ) : (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Roles</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} onClick={() => onSelectUser(u.id)}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <div className="avatar" style={{ width: 26, height: 26, fontSize: 10 }}>
                            {u.email.slice(0, 2).toUpperCase()}
                          </div>
                          <div>
                            <div style={{ color: 'var(--text)', fontWeight: 500, fontSize: 12.5 }}>
                              {u.email}
                            </div>
                            {u.name && (
                              <div style={{ color: 'var(--faint)', fontSize: 11 }}>{u.name}</div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {u.globalRoles.length === 0 ? (
                            <span className="badge badge-muted">no roles</span>
                          ) : (
                            u.globalRoles.map((r) => (
                              <span key={r} className="badge badge-accent">
                                {r}
                              </span>
                            ))
                          )}
                        </div>
                      </td>
                      <td>
                        <span className={`badge ${u.disabled ? 'badge-red' : 'badge-green'}`}>
                          {u.disabled ? 'disabled' : 'active'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ padding: '0 16px 12px' }}>
                <Pagination page={page} total={total} perPage={20} onPage={onPage} />
              </div>
            </div>
          )}
        </QueryBoundary>
      </div>
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
      skeleton={
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: '50%',
                background: 'var(--bg3)',
                backgroundImage:
                  'linear-gradient(90deg, var(--bg3) 0%, var(--bg2) 40%, var(--bg3) 100%)',
                backgroundSize: '200% 100%',
                animation: 'sk-shimmer 1.6s ease-in-out infinite',
              }}
            />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div
                style={{
                  height: 14,
                  width: '60%',
                  borderRadius: 6,
                  background: 'var(--bg3)',
                  backgroundImage:
                    'linear-gradient(90deg, var(--bg3) 0%, var(--bg2) 40%, var(--bg3) 100%)',
                  backgroundSize: '200% 100%',
                  animation: 'sk-shimmer 1.6s ease-in-out infinite',
                }}
              />
              <div
                style={{
                  height: 11,
                  width: '40%',
                  borderRadius: 6,
                  background: 'var(--bg3)',
                  backgroundImage:
                    'linear-gradient(90deg, var(--bg3) 0%, var(--bg2) 40%, var(--bg3) 100%)',
                  backgroundSize: '200% 100%',
                  animation: 'sk-shimmer 1.6s ease-in-out infinite',
                }}
              />
            </div>
          </div>
        </div>
      }
    >
      {user && (
        <div>
          {/* Info */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div className="avatar" style={{ width: 44, height: 44, fontSize: 15 }}>
              {user.email.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{user.email}</div>
              {user.name && <div style={{ color: 'var(--faint)', fontSize: 12 }}>{user.name}</div>}
              <div style={{ marginTop: 4 }}>
                <span className={`badge ${user.disabled ? 'badge-red' : 'badge-green'}`}>
                  {user.disabled ? 'disabled' : 'active'}
                </span>
              </div>
            </div>
          </div>
          <div className="code" style={{ fontSize: 11, padding: '6px 10px' }}>
            ID: {user.id}
          </div>

          {/* Actions */}
          <div style={{ marginTop: 16 }}>
            <div
              style={{
                fontSize: 10.5,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--faint)',
                fontWeight: 600,
                marginBottom: 8,
              }}
            >
              Actions
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <button
                className={`btn btn-sm ${user.disabled ? '' : 'btn-danger'}`}
                onClick={handleToggleDisable}
                disabled={disableMutation.isPending || enableMutation.isPending}
              >
                {user.disabled ? 'Enable account' : 'Disable account'}
              </button>
              <button
                className="btn btn-sm"
                onClick={handleResetPassword}
                disabled={resetPwMutation.isPending}
              >
                Reset password
              </button>
              <button
                className="btn btn-sm"
                onClick={handleImpersonate}
                disabled={impersonationQuery.isFetching}
              >
                Impersonate
              </button>
              <button
                className="btn btn-sm btn-danger"
                onClick={handleRevokeSessions}
                disabled={revokeSessionsMutation.isPending}
              >
                Disconnect all devices
              </button>
              <button
                className="btn btn-sm btn-danger"
                onClick={handleDelete}
                disabled={deleteMutation.isPending}
              >
                Delete user
              </button>
            </div>
          </div>

          <Modal
            open={impersonationPanel !== null}
            onClose={() => setImpersonationPanel(null)}
            title={`Impersonate ${impersonationPanel?.targetEmail ?? ''}`}
            large
            footer={
              <button className="btn btn-sm" onClick={() => setImpersonationPanel(null)}>
                Close
              </button>
            }
          >
            {impersonationPanel && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--faint)' }}>
                  Impersonation runs through the RFC 8693 token exchange. The exchange has to be
                  signed with <strong>your own admin access token</strong> as the{' '}
                  <code>subject_token</code>, which this console does not hold — so run the request
                  below from wherever you already have that token. The issued <code>id_token</code>{' '}
                  carries <code>act</code> with your subject, and the exchange is audited.
                </p>

                <div style={{ display: 'grid', gap: 6 }}>
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
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      marginBottom: 6,
                    }}
                  >
                    <span style={{ fontSize: 12, color: 'var(--faint)' }}>Request</span>
                    <button
                      className="btn btn-sm"
                      onClick={() => copyToClipboard(impersonationPanel.curl, 'Command')}
                    >
                      Copy
                    </button>
                  </div>
                  <pre
                    className="code"
                    style={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
                  >
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
    <div style={{ display: 'flex', gap: 10, fontSize: 12 }}>
      <span style={{ color: 'var(--faint)', minWidth: 140 }}>{label}</span>
      <span className="code" style={{ fontSize: 11, padding: '2px 6px', wordBreak: 'break-all' }}>
        {value}
      </span>
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
      <div
        style={{
          fontSize: 10.5,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--faint)',
          fontWeight: 600,
          marginBottom: 8,
        }}
      >
        Global Roles
      </div>
      <QueryBoundary
        isLoading={isLoading}
        error={error}
        onRetry={refetch}
        skeleton={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[1, 2].map((i) => (
              <div
                key={i}
                style={{
                  height: 20,
                  borderRadius: 6,
                  background: 'var(--bg3)',
                  backgroundImage:
                    'linear-gradient(90deg, var(--bg3) 0%, var(--bg2) 40%, var(--bg3) 100%)',
                  backgroundSize: '200% 100%',
                  animation: 'sk-shimmer 1.6s ease-in-out infinite',
                }}
              />
            ))}
          </div>
        }
      >
        {user && (
          <>
            {selectedRoles.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--faint)', marginBottom: 8 }}>
                No roles assigned
              </div>
            )}
            {user.globalRoles.map((r) => (
              <label key={r} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={selectedRoles.includes(r)}
                  onChange={() => toggleRole(r)}
                />
                <div>
                  <div className="chk-label">{r}</div>
                </div>
              </label>
            ))}
            <button
              className="btn btn-primary btn-sm"
              style={{ marginTop: 10 }}
              onClick={handleUpdateRoles}
              disabled={updateRolesMutation.isPending}
            >
              {updateRolesMutation.isPending ? <span className="spinner sm" /> : 'Save roles'}
            </button>
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
      <div
        style={{
          fontSize: 10.5,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--faint)',
          fontWeight: 600,
          marginBottom: 8,
        }}
      >
        Sessions {!isLoading && !error ? `(${sessions.length})` : ''}
      </div>
      <QueryBoundary
        isLoading={isLoading}
        error={error}
        onRetry={refetch}
        skeleton={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[1, 2].map((i) => (
              <div
                key={i}
                style={{
                  height: 44,
                  borderRadius: 8,
                  background: 'var(--bg3)',
                  backgroundImage:
                    'linear-gradient(90deg, var(--bg3) 0%, var(--bg2) 40%, var(--bg3) 100%)',
                  backgroundSize: '200% 100%',
                  animation: 'sk-shimmer 1.6s ease-in-out infinite',
                }}
              />
            ))}
          </div>
        }
      >
        {sessions.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--faint)' }}>No active sessions</div>
        ) : (
          sessions.map((s) => (
            <div key={s.id} className="panel" style={{ marginBottom: 8, padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="var(--muted)"
                  strokeWidth="1.6"
                >
                  <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
                  <circle cx="8" cy="8.5" r="2" />
                </svg>
                <span style={{ color: 'var(--text)', fontWeight: 500 }}>
                  {s.browser ?? 'Unknown browser'}
                </span>
                <span style={{ color: 'var(--faint)' }}>{s.os}</span>
                <span className="code ml-auto">{s.ip ?? '—'}</span>
              </div>
              {s.location && (
                <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 4 }}>
                  {s.location}
                </div>
              )}
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <UserInfoContainer userId={userId} onMutated={onMutated} onClose={onClose} />
        <UserRolesContainer userId={userId} onMutated={onMutated} />
        <UserSessionsContainer userId={userId} />
      </div>
    </Drawer>
  );
}
