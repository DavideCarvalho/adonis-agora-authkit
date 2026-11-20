---
"@adonis-agora/authkit-server": patch
---

The app catalog keeps taking new apps on a table without the new `created_at` column — a server with `schema.autoManage: false` whose identity tables nobody migrates (e.g. a second server sharing them). The insert falls back to writing without it (that entry's `createdAt` is `null`) and tries the column again a minute later.
