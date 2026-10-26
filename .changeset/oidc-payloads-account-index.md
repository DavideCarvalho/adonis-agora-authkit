---
"@adonis-agora/authkit-server": minor
---

Per-account session operations no longer read the whole OIDC store. `authkit_oidc_payloads` gains an indexed `account_id` column and an `expires_at` index (added by `ensureAuthkitSchema`, which runs on boot with `schema.autoManage`; with `autoManage: false`, run `ensureAuthkitSchema` in a migration to get them). Each index is checked by name and created when missing, independently of the column, so a table whose `account_id` was added by hand still gets both; `ensureAuthkitSchema`'s report lists the indexes it created under `indexed`. The database adapter answers the new optional `listByAccount`/`listByGrantIds` adapter methods in SQL, so single-session login, the account sessions page and `revokeAll` read only the account's rows; rows written before the column existed are still found and get classified on read. Expired rows are pruned every 10 minutes. The Redis adapter reads each `SCAN` page with one `MGET`.

The runtime-settings cache now actually caches across requests: the account and admin guards no longer query `auth_settings` on every request. Writes through any `RuntimeSettings` instance invalidate the shared cache.

`lucidPatStore` writes a token's `lastUsedAt` at most once a minute instead of on every request.

Fix: the database adapter now works on MySQL. It wrote and compared `expires_at` as an ISO-8601 string ending in `Z`, which MySQL rejects for `TIMESTAMP` columns ("Incorrect datetime value"), so every write failed. It now binds a `Date` (serialized by the driver in the database's own format) on every dialect except SQLite, which keeps the ISO text it already stores.

Fix: `ensureAuthkitSchema` inside a host migration. It checked whether each table and column existed by selecting from it, and on Postgres a SELECT on a missing table (such as an absent account table) aborts the migration's transaction, so every later statement failed. Existence is now read from the catalog (`to_regclass`/`pg_attribute` on Postgres, `information_schema` on MySQL, `sqlite_master`/`pragma_table_info` on SQLite). It also accepts the migration's own client (`ensureAuthkitSchema(this.db)`, as documented), not only the `Database` manager.
