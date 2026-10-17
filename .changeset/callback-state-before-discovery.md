---
"@adonis-agora/authkit-client": patch
---

`AuthkitClientManager.completeAuthorization` checks that a callback belongs to the pending authorization (`missing_pending`, `state_mismatch`) before it discovers the IdP. A stale or forged callback that arrived while discovery was failing surfaced as an `OidcDiscoveryError` (a 500 in `registerOidcClient`) instead of a restartable `OidcCallbackError` that sends the user back to login.
