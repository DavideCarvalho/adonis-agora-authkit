---
"@adonis-agora/authkit-server": minor
---

Per-account session operations no longer read the whole OIDC store. `authkit_oidc_payloads` gains an indexed `account_id` column and an `expires_at` index (added by `ensureAuthkitSchema`, which runs on boot with `schema.autoManage`; with `autoManage: false`, run `ensureAuthkitSchema` in a migration to get them). The database adapter answers the new optional `listByAccount`/`listByGrantIds` adapter methods in SQL, so single-session login, the account sessions page and `revokeAll` read only the account's rows; rows written before the column existed are still found and get classified on read. Expired rows are pruned every 10 minutes. The Redis adapter reads each `SCAN` page with one `MGET`.

The runtime-settings cache now actually caches across requests: the account and admin guards no longer query `auth_settings` on every request. Writes through any `RuntimeSettings` instance invalidate the shared cache.

`lucidPatStore` writes a token's `lastUsedAt` at most once a minute instead of on every request.
