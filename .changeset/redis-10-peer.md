---
'@adonis-agora/authkit-server': patch
---

Accept `@adonisjs/redis` 10 as a peer (`^9.2 || ^10`), alongside `@adonisjs/session` 8.1 and
`@adonisjs/lock` 2.1 which already require it. TOTP now goes through `otplib` 13 and JOSE through
`jose` 6 internally — no change to the public API.
