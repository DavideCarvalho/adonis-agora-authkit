---
"@adonis-agora/authkit-server": patch
---

Admin console: going to another console (switcher, ⌘K, search results, sidebar links) keeps this page's `?app=` and `?tenant=`, so the picked app and organization follow you. The console kit copy is updated from the canonical kit (shared `ScopeMenu` / `ScopeChip` header picker, `app-mode` block, `globalThis.fetch` in console data).
