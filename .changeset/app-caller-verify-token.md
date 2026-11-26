---
'@adonis-agora/authkit-client': minor
---

`AppCallerVerifier.verifyToken(token)` verifies a service token that arrived outside HTTP (Redis, queues) with the same checks as the inbound middleware — audience `urn:agora:app:<service.name>`, environment pinning — and returns the `AgoraCaller` or `null` (a bad token never throws). `callerOf` uses it. The `AppCallerVerifier` type is now exported.
