import type { AdminClient } from '@adonis-agora/authkit-react';
import { useClientsQueryOptions } from '@adonis-agora/authkit-react';
import { useQuery } from '@tanstack/react-query';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { Badge } from '../agora-kit/ui/badge';
import { Button } from '../agora-kit/ui/button';
import { Code, dangerButtonClass, Notice } from '../components/primitives';
import { QueryBoundary } from '../components/QueryBoundary';
import { Skeleton } from '../components/Skeleton';

const ALL_CLIENTS = { page: 1, size: 200 } as const;

/** One client card's surface (authkit `.panel`, padded). */
const cardClass = 'agora-surface agora-rise rounded-lg border border-border px-4 py-3.5';

// ── Skeleton for client cards ─────────────────────────────────────────────────

function ClientCardSkeleton() {
  return (
    <div className={`${cardClass} flex flex-col gap-2`} aria-hidden>
      <div className="flex items-center gap-2">
        <Skeleton width="30%" height={13} />
        <Skeleton width={60} height={18} borderRadius={20} />
      </div>
      <div className="flex gap-1.5">
        <Skeleton width={100} height={18} borderRadius={20} />
        <Skeleton width={80} height={18} borderRadius={20} />
      </div>
      <Skeleton width="50%" height={11} />
    </div>
  );
}

function ClientsListSkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
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
  onToggleDisabled: (c: AdminClient) => void;
}

export function ClientsListContainer({
  onEdit,
  onDelete,
  onRegenerate,
  onToggleDisabled,
}: ClientsListContainerProps) {
  // The console lists every client on one screen: one page of the largest size the API allows.
  const { data, isLoading, error, refetch } = useQuery(useClientsQueryOptions(ALL_CLIENTS));
  const clients = data?.data ?? [];
  const canList = data?.canList ?? true;

  return (
    <QueryBoundary
      label="Clients"
      isLoading={isLoading}
      error={error}
      onRetry={refetch}
      skeleton={<ClientsListSkeleton />}
    >
      {!canList ? (
        <Notice>
          Client store does not support listing (no dynamic registration adapter configured).
        </Notice>
      ) : clients.length === 0 ? (
        <EmptyState
          icon={
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M18 13l4-3.5L18 6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M22 9.5H9M6 5H4a1 1 0 00-1 1v12a1 1 0 001 1h2" strokeLinecap="round" />
            </svg>
          }
          title="No clients yet"
          description="Create an OAuth 2.0 / OIDC client to get started"
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          {clients.map((c) => (
            <div key={c.clientId} className={cardClass}>
              <div className="flex flex-col items-start gap-3.5 sm:flex-row">
                {c.logoUri && (
                  <img src={c.logoUri} alt="" className="size-8 rounded-md object-contain" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    {c.clientName && (
                      <span className="text-[13px] font-semibold text-fg">{c.clientName}</span>
                    )}
                    <span className="mono text-[13px] font-semibold break-all text-fg">
                      {c.clientId}
                    </span>
                    <Badge variant={c.confidential ? 'brand' : 'neutral'}>
                      {c.confidential ? 'confidential' : 'public'}
                    </Badge>
                    {c.serviceTenant && (
                      <Badge variant="brand" title="Service tenant partition">
                        tenant: {c.serviceTenant.partition}
                      </Badge>
                    )}
                    {c.disabled && <Badge variant="neutral">disabled</Badge>}
                  </div>
                  {c.serviceTenant && c.serviceTenant.capabilities.length > 0 && (
                    <div className="mb-1.5 flex flex-wrap gap-1">
                      {c.serviceTenant.capabilities.map((cap) => (
                        <Code key={cap}>{cap}</Code>
                      ))}
                    </div>
                  )}
                  <div className="mb-1.5 flex flex-wrap gap-1">
                    {c.grantTypes.map((g) => (
                      <Badge key={g} variant="neutral">
                        {g}
                      </Badge>
                    ))}
                  </div>
                  {c.redirectUris.length > 0 && (
                    <div className="flex flex-wrap gap-1 text-[11px] text-faint">
                      {c.redirectUris.map((u) => (
                        <Code key={u}>{u}</Code>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button variant="outline" size="sm" onClick={() => onEdit(c)}>
                    Edit
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => onToggleDisabled(c)}>
                    {c.disabled ? 'Enable' : 'Disable'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onRegenerate(c)}
                    title="Regenerate secret"
                    aria-label="Regenerate secret"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      aria-hidden="true"
                    >
                      <path d="M2 8a6 6 0 016-6 6 6 0 014.24 1.76L14 5" strokeLinecap="round" />
                      <path
                        d="M14 2v3h-3M14 8a6 6 0 01-6 6 6 6 0 01-4.24-1.76L2 11"
                        strokeLinecap="round"
                      />
                      <path d="M2 14v-3h3" strokeLinecap="round" />
                    </svg>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className={dangerButtonClass}
                    onClick={() => onDelete(c)}
                    aria-label="Delete client"
                    title="Delete client"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      aria-hidden="true"
                    >
                      <path
                        d="M2 4.5h12M5.5 4.5V3h5v1.5M10.5 4.5v8a1 1 0 01-1 1h-3a1 1 0 01-1-1v-8"
                        strokeLinecap="round"
                      />
                    </svg>
                  </Button>
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
  const { data } = useQuery(useClientsQueryOptions(ALL_CLIENTS));
  return data?.meta.total ?? 0;
}
