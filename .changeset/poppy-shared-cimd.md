---
"@adonis-agora/authkit-poppy": patch
---

The SSRF-safe fetch and the agent metadata/JWKS cache now come from `@adonis-agora/authkit-server`, which uses the same code for MCP Client ID Metadata Documents. Behaviour is unchanged. `isBlockedAddress`, `SafeFetchError` and `safeFetchJson` are still exported from this package.
