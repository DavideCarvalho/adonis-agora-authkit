---
"@adonis-agora/authkit-server": patch
---

Performance: fewer queries and round trips on several paths.

- `listOrgsForAccount` (Lucid store) loads every org of the account in one query instead of one query per membership. It runs on the account orgs page, `GET /account/api/orgs`, the account export and the admin org list. The result and its order are unchanged.
- With `acceptIdpSession`, the RP guard no longer renews the IdP session (an UPDATE plus a `Set-Cookie`) on every request. A linked session that was renewed with the current TTL less than 60 s ago is left as it is. The session lookup, the account checks and revocation still run on every request. A session that would outlive the current TTL is still renewed, which shortens it, and a restore always renews.
- `RedisAdapter.consume` reads the payload and its TTL in one pipelined round trip instead of two.
- `DatabaseAdapter.upsert` checks whether the row exists without reading its payload back.
