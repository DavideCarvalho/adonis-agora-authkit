import { type AuditEventEntry, useAuditQueryOptions } from '@adonis-agora/authkit-react';
import { useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Pagination } from '../components/Pagination';
import { QueryBoundary } from '../components/QueryBoundary';
import { SkeletonPanelTable } from '../components/Skeleton';

function eventBadgeClass(type: string) {
  if (type.includes('login') || type.includes('signin') || type.includes('success'))
    return 'badge-green';
  if (
    type.includes('fail') ||
    type.includes('error') ||
    type.includes('locked') ||
    type.includes('block')
  )
    return 'badge-red';
  if (type.includes('register') || type.includes('signup') || type.includes('created'))
    return 'badge-accent';
  if (type.includes('settings') || type.includes('admin') || type.includes('updated'))
    return 'badge-amber';
  return 'badge-muted';
}

const PAGE_SIZE = 30;

// ── AuditTableContainer ───────────────────────────────────────────────────────

interface AuditTableContainerProps {
  typeFilter: string;
  page: number;
  onPage: (p: number) => void;
  selected: AuditEventEntry | null;
  onSelect: (ev: AuditEventEntry | null) => void;
  onUnavailable: () => void;
}

export function AuditTableContainer({
  typeFilter,
  page,
  onPage,
  selected,
  onSelect,
  onUnavailable,
}: AuditTableContainerProps) {
  const [checkedUnavailable, setCheckedUnavailable] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    ...useAuditQueryOptions({ type: typeFilter || undefined, page, size: PAGE_SIZE }),
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

  const events = data?.data ?? [];
  const total = data?.total ?? 0;

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
        skeleton={<SkeletonPanelTable rows={8} cols={4} />}
      >
        {events.length === 0 ? (
          <div className="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                strokeLinecap="round"
              />
            </svg>
            <h4>No events found</h4>
            <p>{typeFilter ? 'No events match this filter' : 'No audit events recorded yet'}</p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Account</th>
                  <th>IP</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id} onClick={() => onSelect(selected?.id === ev.id ? null : ev)}>
                    <td>
                      <span className={`badge ${eventBadgeClass(ev.type)}`}>{ev.type}</span>
                    </td>
                    <td>
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5 }}>
                        {ev.email ?? ev.accountId ?? (
                          <span style={{ color: 'var(--faint)' }}>—</span>
                        )}
                      </span>
                    </td>
                    <td>
                      <span className="code">{ev.ip ?? '—'}</span>
                    </td>
                    <td>
                      <span
                        style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--faint)' }}
                      >
                        {ev.createdAt ? new Date(ev.createdAt).toLocaleString() : '—'}
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

// ── AuditEventDetailContainer ─────────────────────────────────────────────────

interface AuditEventDetailContainerProps {
  event: AuditEventEntry;
  onClose: () => void;
}

export function AuditEventDetailContainer({ event, onClose }: AuditEventDetailContainerProps) {
  return (
    <div className="panel" style={{ padding: '14px 16px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 10,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 13 }}>Event Detail</div>
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <pre
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 11.5,
          color: 'var(--muted)',
          overflow: 'auto',
          lineHeight: 1.6,
        }}
      >
        {JSON.stringify(event, null, 2)}
      </pre>
    </div>
  );
}

// Re-export count
export function useAuditTotal(typeFilter: string, page: number) {
  const { data } = useQuery(
    useAuditQueryOptions({ type: typeFilter || undefined, page, size: PAGE_SIZE }),
  );
  return data?.total ?? 0;
}
