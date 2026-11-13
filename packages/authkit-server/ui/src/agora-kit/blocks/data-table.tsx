import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { Skeleton } from '../ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  /** Hide below this breakpoint (phone-width tables keep only what matters). */
  hideBelow?: 'sm' | 'md' | 'lg';
  align?: 'left' | 'right';
}

const HIDE: Record<NonNullable<Column<unknown>['hideBelow']>, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
};

/**
 * A data table (shadcn `Table` composition): typed columns, an optional row click, skeleton rows
 * while loading and an empty slot. Presentational: it never fetches.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  loading,
  skeletonRows = 5,
  empty,
  className,
  label,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  skeletonRows?: number;
  empty?: ReactNode;
  className?: string;
  label?: string;
}) {
  const cellClass = (c: Column<T>) =>
    cn(c.hideBelow && HIDE[c.hideBelow], c.align === 'right' && 'text-right', c.className);
  if (!loading && rows && rows.length === 0 && empty) return <>{empty}</>;
  return (
    <Table className={className} aria-label={label}>
      <TableHeader>
        <TableRow className="border-border hover:bg-transparent">
          {columns.map((c) => (
            <TableHead
              key={c.id}
              className={cn(
                'h-auto px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint',
                cellClass(c),
              )}
            >
              {c.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading || !rows
          ? Array.from({ length: skeletonRows }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows, never reordered
              <TableRow key={`s${i}`} aria-hidden className="hover:bg-transparent">
                {columns.map((c, ci) => (
                  <TableCell key={c.id} className={cn('px-3 py-3', cellClass(c))}>
                    <Skeleton className={cn('h-3', ci === 0 ? 'w-36' : 'w-16')} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          : rows.map((row) => (
              <TableRow
                key={rowKey(row)}
                className={cn('border-border hover:bg-hover', onRowClick && 'cursor-pointer')}
                {...(onRowClick
                  ? {
                      onClick: () => onRowClick(row),
                      onKeyDown: (e: React.KeyboardEvent) => {
                        if (e.key === 'Enter') onRowClick(row);
                      },
                      tabIndex: 0,
                    }
                  : {})}
              >
                {columns.map((c) => (
                  <TableCell
                    key={c.id}
                    className={cn('px-3 py-2.5 text-[12.5px] text-dim', cellClass(c))}
                  >
                    {c.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
      </TableBody>
    </Table>
  );
}
