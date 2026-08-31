import type { AdminClient } from '@adonis-agora/authkit-react';
import { useClientsQueryOptions } from '@adonis-agora/authkit-react';
import { useQuery } from '@tanstack/react-query';
import React from 'react';
import { QueryBoundary } from '../components/QueryBoundary';
import { Skeleton } from '../components/Skeleton';

// ── Skeleton for client cards ─────────────────────────────────────────────────

function ClientCardSkeleton() {
  return (
    <div
      style={{
        background: 'var(--bg2)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Skeleton width="30%" height={13} />
        <Skeleton width={60} height={18} borderRadius={20} />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <Skeleton width={100} height={18} borderRadius={20} />
        <Skeleton width={80} height={18} borderRadius={20} />
      </div>
      <Skeleton width="50%" height={11} />
    </div>
  );
}

function ClientsListSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {[1, 2, 3].map((i) => (
        <ClientCardSkeleton key={i} />
      ))}
    </div>
  );
}

// ── ClientsListContainer ──────────────────────────────────────────────────────

interface ClientsListContainerProps {
  onEdit: (c: AdminClient) => void;
  onDelete: (c: AdminClient) => void;
  onRegenerate: (c: AdminClient) => void;
}

export function ClientsListContainer({
  onEdit,
  onDelete,
  onRegenerate,
}: ClientsListContainerProps) {
  const { data, isLoading, error, refetch } = useQuery(useClientsQueryOptions());
  const clients = data?.data ?? [];
  const canList = data?.canList ?? true;

  return (
    <QueryBoundary
      isLoading={isLoading}
      error={error}
      onRetry={refetch}
      skeleton={<ClientsListSkeleton />}
    >
      {!canList ? (
        <div className="error-box">
          Client store does not support listing (no dynamic registration adapter configured).
        </div>
      ) : clients.length === 0 ? (
        <div className="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M18 13l4-3.5L18 6" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M22 9.5H9M6 5H4a1 1 0 00-1 1v12a1 1 0 001 1h2" strokeLinecap="round" />
          </svg>
          <h4>No clients yet</h4>
          <p>Create an OAuth 2.0 / OIDC client to get started</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {clients.map((c) => (
            <div key={c.clientId} className="panel" style={{ padding: '14px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span
                      style={{
                        fontFamily: 'var(--mono)',
                        fontWeight: 600,
                        fontSize: 13,
                        color: 'var(--text)',
                      }}
                    >
                      {c.clientId}
                    </span>
                    <span className={`badge ${c.confidential ? 'badge-accent' : 'badge-muted'}`}>
                      {c.confidential ? 'confidential' : 'public'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                    {c.grants.map((g) => (
                      <span key={g} className="badge badge-muted">
                        {g}
                      </span>
                    ))}
                  </div>
                  {c.redirectUris.length > 0 && (
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--faint)',
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 4,
                      }}
                    >
                      {c.redirectUris.map((u) => (
                        <span key={u} className="code">
                          {u}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button className="btn btn-sm" onClick={() => onEdit(c)}>
                    Edit
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => onRegenerate(c)}
                    title="Regenerate secret"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M2 8a6 6 0 016-6 6 6 0 014.24 1.76L14 5" strokeLinecap="round" />
                      <path
                        d="M14 2v3h-3M14 8a6 6 0 01-6 6 6 6 0 01-4.24-1.76L2 11"
                        strokeLinecap="round"
                      />
                      <path d="M2 14v-3h3" strokeLinecap="round" />
                    </svg>
                  </button>
                  <button className="btn btn-sm btn-danger" onClick={() => onDelete(c)}>
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path
                        d="M2 4.5h12M5.5 4.5V3h5v1.5M10.5 4.5v8a1 1 0 01-1 1h-3a1 1 0 01-1-1v-8"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </QueryBoundary>
  );
}

// Re-export count for the page header
export function useClientsCount() {
  const { data } = useQuery(useClientsQueryOptions());
  return data?.data.length ?? 0;
}
