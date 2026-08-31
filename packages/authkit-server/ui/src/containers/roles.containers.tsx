import type { RoleCatalogEntry } from '@adonis-agora/authkit-react';
import { useRolesQueryOptions } from '@adonis-agora/authkit-react';
import { useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';
import { QueryBoundary } from '../components/QueryBoundary';
import { SkeletonPanelTable } from '../components/Skeleton';

const PROTECTED = 'ADMIN';

// ── RolesTableContainer ───────────────────────────────────────────────────────

interface RolesTableContainerProps {
  onEdit: (r: RoleCatalogEntry) => void;
  onDelete: (r: RoleCatalogEntry) => void;
  onUnavailable: () => void;
}

export function RolesTableContainer({ onEdit, onDelete, onUnavailable }: RolesTableContainerProps) {
  const [checkedUnavailable, setCheckedUnavailable] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    ...useRolesQueryOptions(),
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
  const roles = data?.data ?? [];

  return (
    <div className="panel">
      <QueryBoundary
        isLoading={isLoading}
        error={
          error &&
          !(
            typeof error === 'object' &&
            'status' in error &&
            (error as { status: number }).status === 404
          )
            ? error
            : undefined
        }
        onRetry={refetch}
        skeleton={<SkeletonPanelTable rows={4} cols={4} />}
      >
        {roles.length === 0 ? (
          <div className="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="8" r="4" />
              <path d="M2 20a10 10 0 0120 0" />
            </svg>
            <h4>No roles yet</h4>
            <p>Create roles to assign permissions to users</p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Description</th>
                  <th>Type</th>
                  <th style={{ width: 80 }} />
                </tr>
              </thead>
              <tbody>
                {roles.map((r) => (
                  <tr key={r.name} style={{ cursor: 'default' }}>
                    <td>
                      <span
                        style={{
                          fontFamily: 'var(--mono)',
                          fontWeight: 600,
                          color: r.name === PROTECTED ? 'var(--accent)' : 'var(--text)',
                        }}
                      >
                        {r.name}
                      </span>
                    </td>
                    <td>
                      <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                        {r.description ?? '—'}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`badge ${'builtin' in r && (r as { builtin?: boolean }).builtin ? 'badge-accent' : 'badge-muted'}`}
                      >
                        {'builtin' in r && (r as { builtin?: boolean }).builtin
                          ? 'built-in'
                          : 'custom'}
                      </span>
                    </td>
                    <td className="no-click" style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn btn-sm" onClick={() => onEdit(r)}>
                          Edit
                        </button>
                        {r.name !== PROTECTED && (
                          <button className="btn btn-sm btn-danger" onClick={() => onDelete(r)}>
                            <svg
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                            >
                              <path
                                d="M2 4.5h12M5.5 4.5V3h5v1.5M10.5 4.5v8a1 1 0 01-1 1h-3a1 1 0 01-1-1v-8"
                                strokeLinecap="round"
                              />
                            </svg>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </QueryBoundary>
    </div>
  );
}
