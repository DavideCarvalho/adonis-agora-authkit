import {
  applyCustomFilter,
  BaseFilter,
  type CursorPageResponse,
  cursorPage,
  InvalidColumnFilterError,
  type OffsetPage,
  offsetPage,
  parseCursorParams,
  parsePageParams,
  type ResolvedSortItem,
  resolveSort,
} from '@adonis-agora/filter';
import type { HttpContext } from '@adonisjs/core/http';
import type { AccountStore, AuthAccount } from '../accounts/account_store.js';
import type { AuditSink, StoredAuditEvent } from '../audit/audit_sink.js';
import { ADMIN_LIST_HTTP_DEFAULT_SIZE, ADMIN_LIST_MAX_SIZE } from '../pagination.js';
import { apiError } from './admin_api/dto.js';

/**
 * The list wire format of the admin console, the Admin REST API and the account API:
 * `@adonis-agora/filter`'s. `filter[field]=v` (or `filter[field][]=a&filter[field][]=b`),
 * `search=term`, `sort=-field`, then either `page`/`size` (offset lists, answered with
 * `{ data, meta: { total, perPage, currentPage, lastPage, firstPage } }`) or
 * `after`/`before` + `first`/`last` (the audit log, answered with
 * `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`).
 *
 * An unknown filter field, an unsupported operator or a sort the list cannot do throws
 * `InvalidColumnFilterError`; {@link listQueryError} turns it into a 400.
 */

/** A decoded query string (`ctx.request.qs()`), or the same shape built by hand. */
export type ListQuery = Record<string, unknown>;

/** Page size policy of every authkit list: 20 by default, at most 200. */
const SIZE_POLICY = { defaultSize: ADMIN_LIST_HTTP_DEFAULT_SIZE, maxSize: ADMIN_LIST_MAX_SIZE };

/** What a filter class fills in: field → the values it must match (one = equals, several = any). */
export class ListDraft {
  readonly where = new Map<string, string[]>();

  /** The values of `field`, or `undefined` when the request does not filter on it. */
  get(field: string): string[] | undefined {
    return this.where.get(field);
  }

  /** The single value of `field` (the first one when several were sent). */
  first(field: string): string | undefined {
    return this.where.get(field)?.[0];
  }
}

/** A repeated param arrives as an array, a single one as a scalar, `a,b` already split. */
function asValues(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : value !== null && typeof value === 'object'
      ? Object.values(value)
      : [value];
  return list
    .filter((v) => v !== undefined && v !== null && String(v).trim() !== '')
    .map((v) => String(v).trim());
}

/**
 * Base of every authkit list filter: each field method accepts `equals` / `in` and narrows the
 * draft to those values. A blank value is the same as no filter.
 */
abstract class ValuesFilter extends BaseFilter<ListDraft> {
  declare $query: ListDraft;

  protected narrow(field: string, value: unknown, operator: string): void {
    if (operator !== 'equals' && operator !== 'in' && operator !== 'isAnyOf') {
      throw new InvalidColumnFilterError(`"${field}" does not support the "${operator}" operator.`);
    }
    const values = asValues(value);
    if (values.length > 0) this.$query.where.set(field, values);
  }
}

/** Lists with no filter fields (users, clients, organizations): any `filter[...]` is a 400. */
export class NoListFilter extends ValuesFilter {}

/** `GET …/audit`: `filter[type]` (one or more event types) and `filter[subject]` (an account id). */
export class AuditListFilter extends ValuesFilter {
  type(value: unknown, operator: string): void {
    this.narrow('type', value, operator);
  }

  subject(value: unknown, operator: string): void {
    this.narrow('subject', value, operator);
  }
}

/** `GET {admin}/api/sessions`: `filter[accountId]`. */
export class SessionListFilter extends ValuesFilter {
  accountId(value: unknown, operator: string): void {
    this.narrow('accountId', value, operator);
  }
}

/** `GET {admin}/api/personal-agents/connections`: `filter[protocol|clientId|accountId]`. */
export class ConnectionListFilter extends ValuesFilter {
  protocol(value: unknown, operator: string): void {
    this.narrow('protocol', value, operator);
  }

  clientId(value: unknown, operator: string): void {
    this.narrow('clientId', value, operator);
  }

  accountId(value: unknown, operator: string): void {
    this.narrow('accountId', value, operator);
  }
}

type ListFilterClass = new () => ValuesFilter;

/** Runs `cls` over the request's filters. Throws `InvalidColumnFilterError` on a bad one. */
export async function readListFilter(qs: ListQuery, cls: ListFilterClass): Promise<ListDraft> {
  const draft = new ListDraft();
  await applyCustomFilter(draft, cls, { request: { qs: () => ({ ...qs }) } });
  return draft;
}

/** The trimmed `search` term, or `''`. */
export function readSearch(qs: ListQuery): string {
  return typeof qs.search === 'string' ? qs.search.trim() : '';
}

/**
 * The request's sort, checked against what the list can do. `fixed` is for a list whose store
 * has a single order: only that order is accepted.
 */
export function readSort<F extends string>(
  qs: ListQuery,
  options: { sortable: readonly F[]; default?: string; fixed?: boolean },
): ResolvedSortItem<F>[] {
  const sort = resolveSort(qs.sort as string | undefined, {
    sortable: options.sortable,
    ...(options.default !== undefined && { default: options.default }),
  });
  if (options.fixed && options.default !== undefined) {
    const wanted = resolveSort(options.default, { sortable: options.sortable });
    const same =
      sort.length === wanted.length &&
      sort.every((s, i) => s.field === wanted[i]?.field && s.direction === wanted[i]?.direction);
    if (!same) {
      throw new InvalidColumnFilterError(
        `This list is always sorted by "${options.default}"; it cannot be sorted otherwise.`,
      );
    }
  }
  return sort;
}

/** `page` (1-based) and `size` (default 20, at most 200). */
export function readPage(qs: ListQuery): { page: number; size: number } {
  return parsePageParams(qs, SIZE_POLICY);
}

/** `after` / `before` and the page size (`first` / `last`, default 20, at most 200). */
export function readCursor(qs: ListQuery): { after?: string; before?: string; size: number } {
  const { after, before, size } = parseCursorParams(qs, SIZE_POLICY);
  return { ...(after !== undefined && { after }), ...(before !== undefined && { before }), size };
}

/**
 * Maps a refused list query (`InvalidColumnFilterError`) to `400 { error: { code:
 * 'invalid_list_query', message } }`; anything else is rethrown.
 */
export function listQueryError(ctx: HttpContext, error: unknown) {
  if (error instanceof InvalidColumnFilterError) {
    return ctx.response.badRequest(apiError('invalid_list_query', error.message));
  }
  throw error;
}

/** Runs `handler`, answering a refused list query with a 400 (see {@link listQueryError}). */
export async function withListQuery<T>(ctx: HttpContext, handler: () => Promise<T>) {
  try {
    return await handler();
  } catch (error) {
    return listQueryError(ctx, error);
  }
}

// ─── In-memory lists ──────────────────────────────────────────────────────────

type Accessor<T> = (row: T) => string | number | null | undefined;

/** Sorts a copy of `rows` by `sort`, through `accessors` (nulls last). */
export function sortRows<T, F extends string>(
  rows: readonly T[],
  sort: readonly ResolvedSortItem<F>[],
  accessors: Record<F, Accessor<T>>,
): T[] {
  if (sort.length === 0) return [...rows];
  return [...rows].sort((a, b) => {
    for (const { field, direction } of sort) {
      const av = accessors[field](a);
      const bv = accessors[field](b);
      if (av === bv) continue;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
      if (cmp !== 0) return direction === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
}

/** Keeps the rows where some of `fields` contains `search` (case-insensitive). */
export function searchRows<T>(rows: readonly T[], search: string, fields: Accessor<T>[]): T[] {
  const term = search.toLowerCase();
  if (!term) return [...rows];
  return rows.filter((row) =>
    fields.some((f) => {
      const v = f(row);
      return v !== null && v !== undefined && String(v).toLowerCase().includes(term);
    }),
  );
}

/** One offset page of an array the store returns whole. */
export function pageRows<T>(rows: readonly T[], qs: ListQuery): OffsetPage<T> {
  const { page, size } = readPage(qs);
  const start = (page - 1) * size;
  return offsetPage(rows.slice(start, start + size), { total: rows.length, page, size });
}

// ─── Lists shared by the console, the Admin API and the embedded SDK ─────────

/** `GET /users`: `search` (email), `sort=email` only (the store's order), `page`/`size`. */
export async function listAccountsPage(
  store: AccountStore,
  qs: ListQuery,
): Promise<OffsetPage<AuthAccount>> {
  await readListFilter(qs, NoListFilter);
  readSort(qs, { sortable: ['email'], default: 'email', fixed: true });
  const { page, size } = readPage(qs);
  const result = await store.listAccounts({ search: readSearch(qs), page, size });
  return offsetPage(result.data, { total: result.total, page, size });
}

/**
 * `GET /audit`, newest first: `filter[type]`, `filter[subject]`, `sort=-createdAt` only,
 * `after`/`before` + `first`/`last`.
 */
export async function listAuditPage(
  sink: AuditSink,
  qs: ListQuery,
): Promise<CursorPageResponse<StoredAuditEvent>> {
  if (typeof sink.list !== 'function') throw new Error('The audit sink cannot be queried.');
  const filter = await readListFilter(qs, AuditListFilter);
  readSort(qs, { sortable: ['createdAt'], default: '-createdAt', fixed: true });
  const { after, before, size } = readCursor(qs);
  const type = filter.get('type');
  const subject = filter.first('subject');
  const page = await sink.list({
    ...(type && { type }),
    ...(subject && { subject }),
    ...(after !== undefined && { after }),
    ...(before !== undefined && { before }),
    size,
  });
  return cursorPage(page.data, {
    nextCursor: page.nextCursor,
    prevCursor: page.prevCursor,
    hasNext: page.hasNext,
    hasPrev: page.hasPrev,
  });
}

/** The OIDC client fields the clients list searches and sorts on. */
interface ClientRow {
  clientId: string;
  clientName?: string | null;
}

/** `GET /clients`: `search` (client id or name), `sort=clientId|clientName`, `page`/`size`. */
export async function listClientsPage<T extends ClientRow>(
  clients: readonly T[],
  qs: ListQuery,
): Promise<OffsetPage<T>> {
  await readListFilter(qs, NoListFilter);
  const sort = readSort(qs, { sortable: ['clientId', 'clientName'], default: 'clientId' });
  const found = searchRows(clients, readSearch(qs), [(c) => c.clientId, (c) => c.clientName]);
  return pageRows(
    sortRows(found, sort, { clientId: (c) => c.clientId, clientName: (c) => c.clientName }),
    qs,
  );
}

/** The organization fields the organizations list searches and sorts on. */
interface OrgRow {
  id: string;
  name: string;
  slug: string;
  createdAt?: unknown;
  memberCount?: number;
}

function isoOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const iso = (value as { toISO?: () => string | null }).toISO?.();
  return iso ?? String(value);
}

/**
 * `GET /organizations`: `search` (name or slug), `sort=name|slug|createdAt|memberCount`,
 * `page`/`size`.
 */
export async function listOrgsPage<T extends OrgRow>(
  orgs: readonly T[],
  qs: ListQuery,
): Promise<OffsetPage<T>> {
  await readListFilter(qs, NoListFilter);
  const sort = readSort(qs, {
    sortable: ['name', 'slug', 'createdAt', 'memberCount'],
    default: 'name',
  });
  const found = searchRows(orgs, readSearch(qs), [(o) => o.name, (o) => o.slug]);
  return pageRows(
    sortRows(found, sort, {
      name: (o) => o.name,
      slug: (o) => o.slug,
      createdAt: (o) => isoOf(o.createdAt),
      memberCount: (o) => o.memberCount ?? 0,
    }),
    qs,
  );
}
