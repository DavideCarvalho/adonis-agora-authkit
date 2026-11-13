import { filterQuery } from '@adonis-agora/filter-client';
import type { CursorListParams, ListAuditParams, OffsetListParams } from './types.js';

/** The `sort` string as builder calls: `'-createdAt,name'` → desc createdAt, asc name. */
function sortItems(sort: string | undefined): Array<{ field: string; desc: boolean }> {
  return (sort ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) =>
      s.startsWith('-') ? { field: s.slice(1), desc: true } : { field: s, desc: false },
    );
}

/**
 * The query string of an offset list (`search`, `sort`, `page`, `size`), in the
 * `@adonis-agora/filter` wire format.
 */
export function offsetListQuery(params: OffsetListParams = {}): string {
  const q = filterQuery();
  if (params.search) q.search(params.search);
  for (const { field, desc } of sortItems(params.sort)) q.sort(field, desc ? 'desc' : 'asc');
  if (params.page !== undefined || params.size !== undefined) {
    q.page(params.page ?? 1, params.size ?? 20);
  }
  const qs = q.toQueryString();
  return qs ? `?${qs}` : '';
}

function applyCursor(q: ReturnType<typeof filterQuery>, params: CursorListParams): void {
  if (params.after) q.after(params.after);
  else if (params.before) q.before(params.before);
  if (params.first !== undefined) q.first(params.first);
  if (params.last !== undefined) q.last(params.last);
}

/** The query string of `audit.list`: `filter[type]`, `filter[subject]` and the cursor params. */
export function auditListQuery(params: ListAuditParams = {}): string {
  const q = filterQuery();
  const types = params.type === undefined ? [] : ([] as string[]).concat(params.type);
  if (types.length === 1) q.equals('type', types[0]);
  else if (types.length > 1) q.in('type', types);
  if (params.subject) q.equals('subject', params.subject);
  applyCursor(q, params);
  const qs = q.toQueryString();
  return qs ? `?${qs}` : '';
}

/** The same lists as decoded query objects, for the embedded driver. */
export function offsetListObject(params: OffsetListParams = {}): Record<string, unknown> {
  return {
    ...(params.search !== undefined && { search: params.search }),
    ...(params.sort !== undefined && { sort: params.sort }),
    ...(params.page !== undefined && { page: params.page }),
    ...(params.size !== undefined && { size: params.size }),
  };
}

export function auditListObject(params: ListAuditParams = {}): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (params.type !== undefined) filter.type = params.type;
  if (params.subject !== undefined) filter.subject = params.subject;
  return {
    ...(Object.keys(filter).length > 0 && { filter }),
    ...(params.after !== undefined && { after: params.after }),
    ...(params.before !== undefined && { before: params.before }),
    ...(params.first !== undefined && { first: params.first }),
    ...(params.last !== undefined && { last: params.last }),
  };
}
