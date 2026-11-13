---
"@adonis-agora/authkit-server": major
"@adonis-agora/authkit-react": major
"@adonis-agora/authkit-sdk": major
---

Lists use the `@adonis-agora/filter` wire format: `filter[field]=…`, `search`, `sort=-field`, then `page`/`size` or a cursor. A filter field, operator or sort a list does not support answers `400 { error: { code: 'invalid_list_query' } }`.

`@adonis-agora/authkit-server`:

- `GET {admin}/api/users` and Admin API `GET /users`: `?search&sort&page&size` (`sort` accepts `email` only) → `{ data, meta: { total, perPage, currentPage, lastPage, firstPage } }` (was `meta: { page, size, total }`).
- `GET {admin}/api/clients` and `GET /clients`: page with `?search&sort&page&size` (`sort`: `clientId`, `clientName`) → `{ data, meta, canList }`.
- `GET {admin}/api/orgs` and `GET /organizations`: page with `?search&sort&page&size` (`sort`: `name`, `slug`, `createdAt`, `memberCount`) → `{ data, meta }`.
- `GET {admin}/api/audit` and `GET /audit`: newest first, by cursor. `?filter[type]` (one or more), `?filter[subject]`, `after` / `before` + `first` / `last` → `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`. `?type`, `?subject`, `page` and `size` are gone.
- `GET {admin}/api/sessions`: `?filter[accountId]&search&sort&page&size` (`sort`: `loginTs`, `email`; default `-loginTs`) → `{ data, meta, supported, truncated, grants }` (was `{ supported, truncated, sessions, grants }` with `?accountId`).
- `GET {admin}/api/personal-agents/connections`: `filter[protocol]`, `filter[clientId]`, `filter[accountId]` (were flat `?protocol=`…) → `{ data, meta }` with the offset meta above.
- `GET {admin}/api/overview`: `auditTotal` is `null` when the audit sink cannot count.
- `AuditSink.list` pages by cursor: it takes `{ type?: string | string[], subject?, size?, after?, before? }` and returns `{ data, nextCursor, prevCursor, hasNext, hasPrev }` (newest first). New optional `AuditSink.count({ type?, subject? })`. `lucidAuditSink` implements both (keyset on `createdAt`, `id`). Custom sinks with `list` must follow the new shape.
- The `authkit_list_audit` dev tool takes `cursor` (the previous result's `next`) instead of `page`, and no longer returns `total`.
- The `authkit_get_overview` dev tool returns `auditTotal: null` when the audit sink cannot count.
- Removed exports: `ListMeta`, `PaginatedResponse`, `parseListPage`, `parseListSize`. New exports: `listAccountsPage`, `listAuditPage`, `listClientsPage`, `listOrgsPage`, the list filter classes and `CountAuditParams`.
- Depends on `@adonis-agora/filter`.

`@adonis-agora/authkit-react`:

- `client.admin.users.list({ search?, sort?, page?, size? })`, `clients.list(params?)`, `orgs.list(params?)` return `OffsetPage<T>` (`meta: { total, perPage, currentPage, lastPage, firstPage }`).
- `client.admin.sessions.list({ accountId?, search?, sort?, page?, size? })` (was `list(accountId?)`) returns `AdminSessionListResult` (`data` instead of `sessions`).
- `client.admin.audit.list({ type?, subject?, after?, before?, first?, last? })` returns `CursorPageResponse<AuditEventEntry>`; `page` / `size` are gone.
- `useSessionsQueryOptions(params?)`, `useClientsQueryOptions(params?)` and `useOrgsQueryOptions(params?)` take the list params; `authkitKeys.admin.sessions/clients/orgs` take them too.
- `ListMeta` is removed; `OffsetPage`, `OffsetPageMeta`, `CursorPageResponse`, `CursorPageMeta`, `AdminListParams`, `CursorListParams`, `AdminSessionListParams` and `AdminSessionListResult` are exported. `AdminOverview.auditTotal` is `number | null`.

`@adonis-agora/authkit-sdk`:

- `users.list`, `clients.list` and `organizations.list` take `{ search?, sort?, page?, size? }` and return `OffsetPage<T>` (`clients.list` adds `canList`).
- `audit.list({ type?, subject?, after?, before?, first?, last? })` returns `CursorPageResponse<AuthkitAuditEvent>`.
- `ListMeta` is removed; `OffsetPage`, `CursorPageResponse`, `OffsetListParams`, `CursorListParams`, `ListClientsParams` and `ListOrganizationsParams` are exported.
