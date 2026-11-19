---
"@adonis-agora/authkit-server": patch
---

The `defineConfig` provider now describes the infrastructure AuthKit uses (`Symbol.for('@adonis-agora/stack')`): the OIDC and session adapters, the keystore, the Lucid account, PAT and audit stores (which describe themselves), AuthKit's tables when they live apart from the accounts, and a self-describing `crypto.kms`. Telescope's Architecture page shows "authkit: accounts → PostgreSQL" without any app code.
