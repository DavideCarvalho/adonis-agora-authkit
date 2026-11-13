import type { RoleCatalogEntry } from '@adonis-agora/authkit-react';
import { useRolesQueryOptions } from '@adonis-agora/authkit-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { cn } from '../agora-kit/lib/utils';
import { Badge } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import { AdminTable, Cell, dangerButtonClass, Row, Surface } from '../components/primitives';
import { QueryBoundary } from '../components/QueryBoundary';
import { SkeletonTable } from '../components/Skeleton';

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

  const builtin = (r: RoleCatalogEntry) =>
    'builtin' in r && (r as { builtin?: boolean }).builtin === true;

  return (
    <Surface>
      <QueryBoundary
        label="Roles"
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
        skeleton={<SkeletonTable rows={4} cols={4} />}
      >
        {roles.length === 0 ? (
          <EmptyState
            title="No roles yet"
            description="Create roles to assign permissions to users"
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="8" r="4" />
                <path d="M2 20a10 10 0 0120 0" />
              </svg>
            }
          />
        ) : (
          <AdminTable head={['Name', 'Description', 'Type', '']} label="Roles">
            {roles.map((r) => (
              <Row key={r.name}>
                <Cell>
                  <span
                    className={cn(
                      'mono font-semibold',
                      r.name === PROTECTED ? 'text-brand' : 'text-fg',
                    )}
                  >
                    {r.name}
                  </span>
                </Cell>
                <Cell className="text-xs whitespace-normal text-dim">{r.description ?? '—'}</Cell>
                <Cell>
                  <Badge variant={builtin(r) ? 'brand' : 'neutral'}>
                    {builtin(r) ? 'built-in' : 'custom'}
                  </Badge>
                </Cell>
                <Cell className="w-20 text-right">
                  <div className="flex justify-end gap-1.5">
                    <Button variant="outline" size="sm" onClick={() => onEdit(r)}>
                      Edit
                    </Button>
                    {r.name !== PROTECTED && (
                      <Button
                        variant="outline"
                        size="sm"
                        className={dangerButtonClass}
                        onClick={() => onDelete(r)}
                        aria-label={`Delete role ${r.name}`}
                      >
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
                      </Button>
                    )}
                  </div>
                </Cell>
              </Row>
            ))}
          </AdminTable>
        )}
      </QueryBoundary>
    </Surface>
  );
}
