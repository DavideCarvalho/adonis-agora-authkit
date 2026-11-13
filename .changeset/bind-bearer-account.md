---
'@adonis-agora/authkit-server': patch
---

The `authkit.server` service gains `bindBearerAccount(ctx, accountId)`. Code that verified an authkit access token outside `oidcBearerGuard` (for example `@adonis-agora/agent`'s dev MCP endpoint) calls it to put the caller on the request: `getAccountId(ctx)` and `realAccountId(ctx)` then return that account, and `impersonationState(ctx)` reports no impersonation. A console session on the same request still wins.
