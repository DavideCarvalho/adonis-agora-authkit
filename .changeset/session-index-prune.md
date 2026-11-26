---
'@adonis-agora/authkit-client': patch
---

`InMemorySessionIndex` now forgets sessions: entries expire (`expiresAt` on the entry, or `ttlMs`, default 24 h), the index has a cap (`maxEntries`, default 10 000, oldest evicted first), and the new optional `SessionIndex.unregister(sessionId)` drops a session that ended locally — the built-in logout calls it with `ctx.session.sessionId`. Still not for multi-instance production.
