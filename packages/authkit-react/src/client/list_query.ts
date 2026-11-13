import { filterQuery } from '@adonis-agora/filter-client';
import type { AdminListParams, CursorListParams } from './types.js';

type Filters = Record<string, string | readonly string[] | undefined | null>;

/**
 * The query string (`?…`, or `''`) of a list request, in the `@adonis-agora/filter` wire
 * format: `filter[field]=v` / `filter[field][]=…`, `search`, `sort`, then `page`/`size` or
 * `after`/`before` + `first`/`last`.
 */
export function listQuery(
  params: AdminListParams & CursorListParams = {},
  filters: Filters = {},
): string {
  const q = filterQuery();
  for (const [field, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'string') q.equals(field, value);
    else if (value.length === 1) q.equals(field, value[0]);
    else if (value.length > 1) q.in(field, [...value]);
  }
  if (params.search) q.search(params.search);
  for (const raw of (params.sort ?? '').split(',')) {
    const s = raw.trim();
    if (s) q.sort(s.replace(/^-/, ''), s.startsWith('-') ? 'desc' : 'asc');
  }
  if (params.page !== undefined || params.size !== undefined) {
    q.page(params.page ?? 1, params.size ?? 20);
  }
  if (params.after) q.after(params.after);
  else if (params.before) q.before(params.before);
  if (params.first !== undefined) q.first(params.first);
  if (params.last !== undefined) q.last(params.last);
  const qs = q.toQueryString();
  return qs ? `?${qs}` : '';
}
