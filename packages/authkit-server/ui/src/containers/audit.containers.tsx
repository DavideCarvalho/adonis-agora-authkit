import { type AuditEventEntry, useAuditQueryOptions } from '@adonis-agora/authkit-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { Panel } from '../agora-kit/blocks/panel';
import { XIcon } from '../agora-kit/icons';
import { Badge } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import { CursorPagination } from '../components/Pagination';
import { AdminTable, Cell, Code, Row, Surface } from '../components/primitives';
import { QueryBoundary } from '../components/QueryBoundary';
import { SkeletonTable } from '../components/Skeleton';

/** Badge tone of an audit event type (wider than the Overview's: success/block/created/updated). */
function eventTone(type: string): 'good' | 'destructive' | 'brand' | 'warn' | 'neutral' {
  if (type.includes('login') || type.includes('signin') || type.includes('success')) return 'good';
  if (
    type.includes('fail') ||
    type.includes('error') ||
    type.includes('locked') ||
    type.includes('block')
  )
    return 'destructive';
  if (type.includes('register') || type.includes('signup') || type.includes('created'))
    return 'brand';
  if (type.includes('settings') || type.includes('admin') || type.includes('updated'))
    return 'warn';
  return 'neutral';
}

const PAGE_SIZE = 30;

function auditParams(typeFilter: string, cursor: AuditCursor) {
  const type = typeFilter || undefined;
  if (cursor.before) return { type, before: cursor.before, last: PAGE_SIZE };
  if (cursor.after) return { type, after: cursor.after, first: PAGE_SIZE };
  return { type, first: PAGE_SIZE };
}

// ── AuditTableContainer ───────────────────────────────────────────────────────

/** Where the table is in the log: after / before a cursor, or the newest page. */
export interface AuditCursor {
  after?: string;
  before?: string;
}

interface AuditTableContainerProps {
  typeFilter: string;
  cursor: AuditCursor;
  onCursor: (c: AuditCursor) => void;
  selected: AuditEventEntry | null;
  onSelect: (ev: AuditEventEntry | null) => void;
  onUnavailable: () => void;
}

export function AuditTableContainer({
  typeFilter,
  cursor,
  onCursor,
  selected,
  onSelect,
  onUnavailable,
}: AuditTableContainerProps) {
  const [checkedUnavailable, setCheckedUnavailable] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    ...useAuditQueryOptions(auditParams(typeFilter, cursor)),
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
  const meta = data?.meta;

  const isNotFound =
    error &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status: number }).status === 404;
  const displayError = error && !isNotFound ? error : undefined;

  return (
    <Surface>
      <QueryBoundary
        label="Audit events"
        isLoading={isLoading}
        error={displayError}
        onRetry={refetch}
        skeleton={<SkeletonTable rows={8} cols={4} />}
      >
        {events.length === 0 ? (
          <EmptyState
            title="No events found"
            description={
              typeFilter ? 'No events match this filter' : 'No audit events recorded yet'
            }
            icon={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
                  strokeLinecap="round"
                />
              </svg>
            }
          />
        ) : (
          <>
            <AdminTable head={['Type', 'Account', 'IP', 'When']} label="Audit events">
              {events.map((ev) => (
                <Row
                  key={ev.id}
                  onClick={() => onSelect(selected?.id === ev.id ? null : ev)}
                  className={selected?.id === ev.id ? 'bg-hover' : undefined}
                >
                  <Cell>
                    <Badge variant={eventTone(ev.type)}>{ev.type}</Badge>
                  </Cell>
                  <Cell className="mono text-[11.5px]">
                    {ev.email ?? ev.accountId ?? <span className="text-faint">—</span>}
                  </Cell>
                  <Cell>
                    <Code>{ev.ip ?? '—'}</Code>
                  </Cell>
                  <Cell className="mono text-[11px] text-faint">
                    {ev.createdAt ? new Date(ev.createdAt).toLocaleString() : '—'}
                  </Cell>
                </Row>
              ))}
            </AdminTable>
            <CursorPagination
              hasPrev={!!meta?.hasPrev}
              hasNext={!!meta?.hasNext}
              onPrev={() => meta?.prevCursor && onCursor({ before: meta.prevCursor })}
              onNext={() => meta?.nextCursor && onCursor({ after: meta.nextCursor })}
            />
          </>
        )}
      </QueryBoundary>
    </Surface>
  );
}

// ── AuditEventDetailContainer ─────────────────────────────────────────────────

interface AuditEventDetailContainerProps {
  event: AuditEventEntry;
  onClose: () => void;
}

export function AuditEventDetailContainer({ event, onClose }: AuditEventDetailContainerProps) {
  return (
    <Panel
      title="Event Detail"
      action={
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close event detail">
          <XIcon />
        </Button>
      }
    >
      <pre className="mono overflow-auto text-[11.5px] leading-relaxed text-dim">
        {JSON.stringify(event, null, 2)}
      </pre>
    </Panel>
  );
}
