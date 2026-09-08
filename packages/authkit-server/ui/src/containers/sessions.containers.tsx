import { useSessionsQueryOptions } from '@adonis-agora/authkit-react';
import { useQuery } from '@tanstack/react-query';
import React from 'react';
import { Pagination } from '../components/Pagination';
import { QueryBoundary } from '../components/QueryBoundary';
import { SkeletonPanelTable } from '../components/Skeleton';

const PAGE_SIZE = 20;

interface SessionsTableContainerProps {
  page: number;
  onPage: (p: number) => void;
}

export function SessionsTableContainer({ page, onPage }: SessionsTableContainerProps) {
  const { data, isLoading, error, refetch } = useQuery(useSessionsQueryOptions());
  const allSessions = data?.sessions ?? [];
  const total = allSessions.length;
  const sessions = allSessions.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="panel">
      <QueryBoundary
        isLoading={isLoading}
        error={error}
        onRetry={refetch}
        skeleton={<SkeletonPanelTable rows={8} cols={6} />}
      >
        {sessions.length === 0 ? (
          <div className="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <h4>No active sessions</h4>
            <p>No users are currently logged in</p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Browser / OS</th>
                  <th>IP</th>
                  <th>Location</th>
                  <th>Login</th>
                  <th>Methods</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id} style={{ cursor: 'default' }}>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        {s.email && (
                          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>
                            {s.email}
                          </span>
                        )}
                        <span
                          className="mono text-sm"
                          style={{ color: s.email ? 'var(--faint)' : undefined }}
                        >
                          {s.accountId}
                        </span>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ color: 'var(--text)', fontWeight: 500, fontSize: 12 }}>
                          {s.browser ?? '—'}
                        </span>
                        <span style={{ color: 'var(--faint)', fontSize: 11 }}>{s.os ?? ''}</span>
                      </div>
                    </td>
                    <td>
                      <span className="code">{s.ip ?? '—'}</span>
                    </td>
                    <td>
                      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                        {s.location ?? '—'}
                      </span>
                    </td>
                    <td>
                      <span
                        style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--faint)' }}
                      >
                        {s.loginTs ? new Date(s.loginTs).toLocaleString() : '—'}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {s.amr.length === 0 ? (
                          <span className="badge badge-muted">—</span>
                        ) : (
                          s.amr.map((m) => (
                            <span key={m} className="badge badge-muted">
                              {m}
                            </span>
                          ))
                        )}
                      </div>
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

// Re-export total for the page header
export function useSessionsTotal() {
  const { data } = useQuery(useSessionsQueryOptions());
  return data?.sessions.length ?? 0;
}
