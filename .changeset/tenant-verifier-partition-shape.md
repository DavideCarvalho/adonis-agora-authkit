---
"@adonis-agora/authkit-server": minor
---

The in-process `authkitTenantVerifier` / `AuthkitTenantVerifier` now return the same shape as authkit-client's verifier: `{ partition, environment?, capabilities, clientId, expiresAt }` (was `{ tenant, capabilities?, environment? }`). `capabilities` is always an array (`[]` when the token has none). The exported types are renamed without alias: `VerifiedTenant` → `VerifiedTenantToken`, `TenantVerifierInput` → `TenantVerifierRequest` (which also takes an advisory `partition`). Needs `@adonis-agora/durable` 1.0.0-rc with the `partition` verifier contract.
