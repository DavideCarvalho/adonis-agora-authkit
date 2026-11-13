import { useSessionsQueryOptions } from '@adonis-agora/authkit-react';
import { useQuery } from '@tanstack/react-query';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { Badge } from '../agora-kit/ui/badge';
import { Pagination } from '../components/Pagination';
import { AdminTable, Cell, Code, Row, Surface } from '../components/primitives';
import { QueryBoundary } from '../components/QueryBoundary';
import { SkeletonTable } from '../components/Skeleton';

const PAGE_SIZE = 20;

interface SessionsTableContainerProps {
  page: number;
  onPage: (p: number) => void;
}

function SessionsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function SessionsTableContainer({ page, onPage }: SessionsTableContainerProps) {
  const { data, isLoading, error, refetch } = useQuery(
    useSessionsQueryOptions({ page, size: PAGE_SIZE }),
  );
  const sessions = data?.data ?? [];
  const total = data?.meta.total ?? 0;

  return (
    <Surface>
      <QueryBoundary
        label="Sessions"
        isLoading={isLoading}
        error={error}
        onRetry={refetch}
        skeleton={<SkeletonTable rows={8} cols={6} />}
      >
        {sessions.length === 0 ? (
          <EmptyState
            icon={<SessionsIcon />}
            title="No active sessions"
            description="No users are currently logged in"
          />
        ) : (
          <>
            <AdminTable
              head={['Account', 'Browser / OS', 'IP', 'Location', 'Login', 'Methods']}
              label="Sessions"
            >
              {sessions.map((s) => (
                <Row key={s.id}>
                  <Cell>
                    <div className="flex flex-col gap-0.5">
                      {s.email && <span className="text-xs font-medium text-fg">{s.email}</span>}
                      <span className={`mono text-[11px]${s.email ? ' text-faint' : ''}`}>
                        {s.accountId}
                      </span>
                    </div>
                  </Cell>
                  <Cell>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-xs font-medium text-fg">{s.browser ?? '—'}</span>
                      <span className="text-[11px] text-faint">{s.os ?? ''}</span>
                    </div>
                  </Cell>
                  <Cell>
                    <Code>{s.ip ?? '—'}</Code>
                  </Cell>
                  <Cell className="text-[11.5px] text-dim">{s.location ?? '—'}</Cell>
                  <Cell className="mono text-[11px] text-faint">
                    {s.loginTs ? new Date(s.loginTs).toLocaleString() : '—'}
                  </Cell>
                  <Cell>
                    <div className="flex flex-wrap gap-1">
                      {s.amr.length === 0 ? (
                        <Badge variant="neutral">—</Badge>
                      ) : (
                        s.amr.map((m) => (
                          <Badge key={m} variant="neutral">
                            {m}
                          </Badge>
                        ))
                      )}
                    </div>
                  </Cell>
                </Row>
              ))}
            </AdminTable>
            <Pagination page={page} total={total} size={PAGE_SIZE} onPage={onPage} />
          </>
        )}
      </QueryBoundary>
    </Surface>
  );
}

// Re-export total for the page header
export function useSessionsTotal() {
  const { data } = useQuery(useSessionsQueryOptions({ page: 1, size: PAGE_SIZE }));
  return data?.meta.total ?? 0;
}
