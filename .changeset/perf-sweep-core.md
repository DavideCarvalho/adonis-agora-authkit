---
"@adonis-agora/authkit-core": patch
---

Declare `"sideEffects": false` so bundlers can tree-shake the package in client bundles. It has no module-level side effects.
