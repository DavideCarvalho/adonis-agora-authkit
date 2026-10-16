---
"@adonis-agora/authkit-client": patch
"@adonis-agora/authkit-server": patch
"@adonis-agora/authkit-react": patch
"@adonis-agora/authkit-sdk": patch
---

Publish peer dependencies as ranges again (`^7.5.0` instead of `7.5.0`, etc.). A Renovate pinning pass had turned the peer catalogs into exact versions, so any upstream patch release (e.g. `@adonisjs/core` 7.5.1) fell outside the accepted peer range.
