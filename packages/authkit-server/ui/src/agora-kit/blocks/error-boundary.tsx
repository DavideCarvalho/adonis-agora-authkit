import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertIcon, RefreshIcon } from '../icons';
import { cn } from '../lib/utils';
import { Button } from '../ui/button';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Custom fallback; receives the error and a reset. Default: {@link RegionError}. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Called on reset (e.g. refetch the region's queries) before the children re-render. */
  onReset?: () => void;
  /** When any of these change, a caught error is cleared (e.g. the route or the selected id). */
  resetKeys?: readonly unknown[];
  /** Label for the default fallback ("Workers", "Run detail"). */
  label?: string;
  className?: string;
}

interface State {
  error: Error | null;
}

/**
 * A React error boundary for a page or a region: a failing card renders its own retryable error
 * instead of blanking the page. Wrap every page AND every independently-fetched region.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    if (typeof console !== 'undefined') console.error('[agora-kit] region crashed', error, info);
  }

  override componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (!this.state.error) return;
    const a = prev.resetKeys ?? [];
    const b = this.props.resetKeys ?? [];
    if (a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))) this.reset();
  }

  reset = (): void => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <RegionError
        title={this.props.label ? `${this.props.label} failed to render` : 'Something broke here'}
        error={error}
        onRetry={this.reset}
        className={this.props.className}
      />
    );
  }
}

/** The error state of one region: what failed, the message, and a retry. */
export function RegionError({
  title,
  error,
  onRetry,
  className,
}: {
  title: string;
  error?: unknown;
  onRetry?: (() => void) | undefined;
  className?: string | undefined;
}) {
  const message = error instanceof Error ? error.message : error ? String(error) : undefined;
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-start gap-3 rounded-lg border border-bad/25 bg-bad/5 p-4 text-sm',
        className,
      )}
    >
      <div className="flex items-center gap-2 font-medium text-bad">
        <AlertIcon />
        {title}
      </div>
      {message && <p className="mono break-all text-[11px] text-fg-2">{message}</p>}
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshIcon />
          Retry
        </Button>
      )}
    </div>
  );
}
