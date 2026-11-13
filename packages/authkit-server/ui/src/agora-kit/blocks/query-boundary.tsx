import type { ReactNode } from 'react';
import { ErrorBoundary, RegionError } from './error-boundary';

/** What a QueryBoundary needs from a query — a TanStack Query result fits as-is, any fetch layer
 *  can produce it. */
export interface QueryLike<T> {
  data: T | undefined;
  error: unknown;
  isPending: boolean;
  refetch?: () => unknown;
}

/** HTTP status carried by an error (`status` / `statusCode` / `response.status`), when there is one. */
export function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const v of [e.status, e.statusCode, e.response?.status]) if (typeof v === 'number') return v;
  return undefined;
}

/**
 * Render a data region through its four states: shaped skeleton while pending, a retryable error
 * (an access-denied message on 401/403), a designed empty state, then the content. The content is
 * also wrapped in an {@link ErrorBoundary}, so a render crash stays inside this region.
 */
export function QueryBoundary<T>({
  query,
  skeleton,
  isEmpty,
  empty,
  label,
  children,
}: {
  query: QueryLike<T>;
  /** Shaped like the final layout (rows, cards, chart block) — never a spinner on its own. */
  skeleton: ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  /** Region name for the error copy ("Schedules"). */
  label: string;
  children: (data: T) => ReactNode;
}) {
  if (query.error && query.data === undefined) {
    const status = errorStatus(query.error);
    if (status === 401 || status === 403) {
      return (
        <RegionError
          title={status === 401 ? 'Signed out' : `You can't see ${label.toLowerCase()} here`}
          error={
            status === 401
              ? 'Your session ended. Sign in again to continue.'
              : 'Your account is not allowed to read this.'
          }
        />
      );
    }
    return (
      <RegionError
        title={`${label} could not be loaded`}
        error={query.error}
        {...(query.refetch ? { onRetry: () => void query.refetch?.() } : {})}
      />
    );
  }
  if (query.data === undefined) return <>{skeleton}</>;
  if (empty !== undefined && isEmpty?.(query.data)) return <>{empty}</>;
  const data = query.data;
  return (
    <ErrorBoundary
      label={label}
      {...(query.refetch ? { onReset: () => void query.refetch?.() } : {})}
    >
      {children(data)}
    </ErrorBoundary>
  );
}
