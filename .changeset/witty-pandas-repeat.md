---
"@adonis-agora/authkit-server": minor
---

feat(adapters): `adapters.redis()` without `connection` uses the app default

`RedisAdapterConfig.connection` is now optional. Omitted, the resolver uses
the app's DEFAULT redis connection (`manager.connection()`, i.e.
`config/redis.ts#connection`) — the same one the app session uses. This is
the recommended form for `session: { adapter: adapters.redis() }`: both
session layers land on the same connection by construction, with no
duplicated string to drift apart. Explicit `connection` still works for a
dedicated Redis.
