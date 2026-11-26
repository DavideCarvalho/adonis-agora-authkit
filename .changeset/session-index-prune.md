---
"@adonis-agora/authkit-client": patch
---

**Security:** `InMemorySessionIndex` (the default back-channel logout session index) no longer grows forever. Entries expire (`expiresAt` on the entry, or the `ttlMs` option, default 24 h), the index is capped (`maxEntries`, default 10,000, oldest evicted first), and the new optional `SessionIndex.unregister(sessionId)` drops a session that ended locally; the built-in logout calls it. It is still not meant for multi-instance production: pass a shared (e.g. Redis-backed) index there.
