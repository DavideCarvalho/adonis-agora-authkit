---
'@adonis-agora/authkit-server': minor
'@adonis-agora/authkit-react': minor
---

The admin console's Sessions page pages by cursor, most recent activity first, and the overview no longer counts the whole audit trail.

- `GET {prefix}/api/sessions?first=&after=` (no `filter[accountId]`) answers `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev }, supported, truncated, grants }`. On the database adapter each page is one seek on `(expires_at, id)` through the new optional adapter method `listRecent({ limit, after })`, with no total and nothing else loaded. Without `listRecent` (Redis), or with a search, the page walks the bounded listing by position. `page`/`size` keep the offset envelope.
- `AdminSessionsService.listRecentSessions` / `canListRecent`. `listAllSessions` now keeps the 500 most recent logins when it truncates, instead of the first 500 by id.
- `authkit-react`: `client.admin.sessions.listRecent({ first, after, search })` and `useRecentSessionsQueryOptions`. The console's Sessions page uses them, keeps the walked cursors in the URL (`?after=…`) and no longer shows a session total.
- `GET {prefix}/api/overview` and the `authkit_get_overview` dev tool count audit events up to 1,000 through the new optional sink method `countUpTo`. Past that, `auditTotal` is `1000` and `auditTotalCapped` is `true` (shown as "1,000+"). A sink without `countUpTo` reports `null` instead of running a full `COUNT(*)`. The Lucid sink implements it.
- New opt-in migration `add_authkit_session_list_index` (published by `configure`), plus `createAuthkitSessionListIndex` / `dropAuthkitSessionListIndex`. It indexes `authkit_oidc_payloads` on `(model_name, expires_at, id)`, built `CONCURRENTLY` on Postgres. Run it once on existing installs (see Admin console → Sessions & revocation).
