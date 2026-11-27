---
"@adonis-agora/authkit-server": minor
"@adonis-agora/authkit-core": patch
---

Managed signing keys are now shared and persistent by default. With `jwks: { source: 'managed' }` and no `store`, an app that has `@adonisjs/lucid` configured keeps its keystore in the database (`{ driver: 'lucid' }`, table `authkit_keystore`), so every process of the app (web, `durable:work`, other workers) signs with the same keys and restarts keep them. Before, each process generated its own ephemeral key: tokens issued by one process were rejected by another (for example by `authkitTenantVerifier()`), and every restart invalidated the tokens tenants had cached. The first boot of several processes at once converges on one key. Without Lucid the key stays ephemeral as before; `store: false` keeps it ephemeral on purpose, and a database keystore that cannot be used falls back to the old behavior with a warning. When a managed key has no shared store, the boot logs a warning in production and `agora:doctor` reports an error there. The `configure` stubs and the docs now set `store: { driver: 'lucid' }` explicitly.
