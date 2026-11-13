import { useQueryErrorResetBoundary } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ErrorBoundary, RegionError } from '../agora-kit/blocks/error-boundary';
import { errorStatus } from '../agora-kit/blocks/query-boundary';
import { SkeletonLines } from './Skeleton';

interface QueryBoundaryProps {
  /** Whether the primary query is loading */
  isLoading?: boolean;
  /** Fetch error from the query (not a render error) */
  error?: unknown;
  /** Called when the user clicks "Retry" in the fetch-error state */
  onRetry?: () => void;
  /** Shaped skeleton shown while isLoading is true */
  skeleton?: ReactNode;
  /** Region name for the error copy ("Users"). */
  label?: string;
  children: ReactNode;
}

/**
 * One data region's states, on the kit's blocks: shaped skeleton while loading, a retryable
 * {@link RegionError} on a fetch error (an access message on 401/403), then the content inside a
 * kit {@link ErrorBoundary} that also resets react-query's error state, so a render crash stays in
 * this region and "Retry" refetches.
 */
export function QueryBoundary({
  isLoading,
  error,
  onRetry,
  skeleton,
  label,
  children,
}: QueryBoundaryProps) {
  const { reset } = useQueryErrorResetBoundary();

  if (isLoading) return <>{skeleton ?? <SkeletonLines lines={4} />}</>;

  if (error) {
    const status = errorStatus(error);
    if (status === 401 || status === 403) {
      return (
        <RegionError
          title={status === 401 ? 'Signed out' : 'Not allowed'}
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
        title={label ? `${label} could not be loaded` : 'Something went wrong'}
        error={error}
        onRetry={() => {
          reset();
          onRetry?.();
        }}
      />
    );
  }

  return (
    <ErrorBoundary {...(label ? { label } : {})} onReset={reset}>
      {children}
    </ErrorBoundary>
  );
}
