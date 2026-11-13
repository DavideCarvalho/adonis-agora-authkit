import { Pager } from '../agora-kit/blocks/pager';
import { ChevronLeftIcon, ChevronRightIcon } from '../agora-kit/icons';
import { Button } from '../agora-kit/ui/button';

interface PaginationProps {
  page: number;
  total: number;
  /** Page size — matches the `size` query param sent to the API. */
  size: number;
  onPage: (p: number) => void;
}

/** Offset pager for the list envelopes (the kit's `Pager`); hidden on a single page. */
export function Pagination({ page, total, size, onPage }: PaginationProps) {
  const lastPage = Math.ceil(total / size);
  if (lastPage <= 1) return null;
  return (
    <Pager
      meta={{ total, perPage: size, currentPage: page, lastPage }}
      onPage={onPage}
      className="border-t border-border px-4"
    />
  );
}

interface CursorPaginationProps {
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}

/** Previous / next buttons for a cursor-paged list (`meta.prevCursor` / `meta.nextCursor`). */
export function CursorPagination({ hasPrev, hasNext, onPrev, onNext }: CursorPaginationProps) {
  if (!hasPrev && !hasNext) return null;
  return (
    <div className="flex items-center justify-end gap-1.5 border-t border-border px-4 py-2">
      <Button variant="ghost" size="sm" disabled={!hasPrev} onClick={onPrev} aria-label="Newer">
        <ChevronLeftIcon />
        <span className="hidden sm:inline">Newer</span>
      </Button>
      <Button variant="ghost" size="sm" disabled={!hasNext} onClick={onNext} aria-label="Older">
        <span className="hidden sm:inline">Older</span>
        <ChevronRightIcon />
      </Button>
    </div>
  );
}
