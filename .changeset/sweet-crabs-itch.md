---
"@adonis-agora/authkit-client": patch
---

fix(maybeRefresh): deduplicate concurrent refresh token requests per session

When multiple requests arrive simultaneously and the access token is within
the REFRESH_SKEW_MS window, every request would independently fire a
refresh token grant to the IdP. Since refresh tokens rotate, only the first
succeeds — the remaining N-1 requests fail with an already-invalidated
refresh token, creating unnecessary load and log noise.

This commit introduces an in-memory dedup map keyed by `sessionId`:
concurrent requests to the same session share a single in-flight refresh
promise. Sessions without a `sessionId` (e.g. some test contexts) fall
back to the original behavior.