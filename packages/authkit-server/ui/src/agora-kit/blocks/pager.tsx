import { ChevronLeftIcon, ChevronRightIcon } from '../icons';
import { cn } from '../lib/utils';
import { Button } from '../ui/button';
import { Pagination, PaginationContent, PaginationItem } from '../ui/pagination';

/** The offset envelope's `meta` (`@adonis-agora/filter` `offsetPage`). */
export interface OffsetMeta {
  total: number;
  perPage: number;
  currentPage: number;
  lastPage: number;
  firstPage?: number;
}

/** The cursor envelope's `meta` (`@adonis-agora/filter` `cursorPage`). */
export interface CursorMeta {
  nextCursor: string | null;
  prevCursor: string | null;
  hasNext: boolean;
  hasPrev: boolean;
}

/** Offset pager for `{ data, meta: { total, perPage, currentPage, lastPage } }` (shadcn `Pagination`). */
export function Pager({
  meta,
  onPage,
  className,
}: {
  meta: OffsetMeta;
  onPage: (page: number) => void;
  className?: string;
}) {
  const { currentPage, lastPage, total, perPage } = meta;
  const from = total === 0 ? 0 : (currentPage - 1) * perPage + 1;
  const to = Math.min(total, currentPage * perPage);
  return (
    <div className={cn('flex items-center justify-between gap-3 px-1 py-2', className)}>
      <span className="mono tnum text-[11px] text-dim">
        {from}–{to} of {total}
      </span>
      <Pagination className="mx-0 w-auto">
        <PaginationContent>
          <PaginationItem>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Previous page"
              disabled={currentPage <= (meta.firstPage ?? 1)}
              onClick={() => onPage(currentPage - 1)}
            >
              <ChevronLeftIcon />
              <span className="hidden sm:inline">Previous</span>
            </Button>
          </PaginationItem>
          <PaginationItem>
            <span className="mono tnum px-2 text-[11px] text-fg-2">
              {currentPage} / {Math.max(lastPage, 1)}
            </span>
          </PaginationItem>
          <PaginationItem>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Next page"
              disabled={currentPage >= lastPage}
              onClick={() => onPage(currentPage + 1)}
            >
              <span className="hidden sm:inline">Next</span>
              <ChevronRightIcon />
            </Button>
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}

/** Cursor pager: one "Load more" for `{ data, meta: { nextCursor, hasNext } }` feeds. */
export function LoadMore({
  hasNext,
  loading,
  onLoadMore,
  className,
  label = 'Load more',
}: {
  hasNext: boolean;
  loading?: boolean;
  onLoadMore: () => void;
  className?: string;
  label?: string;
}) {
  if (!hasNext && !loading) return null;
  return (
    <div className={cn('flex justify-center py-3', className)}>
      <Button variant="outline" size="sm" disabled={loading || !hasNext} onClick={onLoadMore}>
        {loading ? 'Loading…' : label}
      </Button>
    </div>
  );
}
