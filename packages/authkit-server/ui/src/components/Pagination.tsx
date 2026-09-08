import React from 'react';

interface PaginationProps {
  page: number;
  total: number;
  /** Page size — matches the `size` query param sent to the API. */
  size: number;
  onPage: (p: number) => void;
}

export function Pagination({ page, total, size, onPage }: PaginationProps) {
  const pages = Math.ceil(total / size);
  if (pages <= 1) return null;

  const start = (page - 1) * size + 1;
  const end = Math.min(page * size, total);

  return (
    <div className="pagination">
      <span className="pag-info">
        {start}–{end} of {total}
      </span>
      <button className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M10 12L6 8l4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <span style={{ fontFamily: 'var(--mono)', fontSize: '11px', color: 'var(--muted)' }}>
        {page} / {pages}
      </span>
      <button className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M6 12l4-4-4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
