---
"@adonis-agora/authkit-server": patch
---

The app catalog keeps taking new apps on a table without the new `created_at` column — a server with `schema.autoManage: false` whose identity tables nobody migrates (e.g. a second server sharing them). The insert checks the catalog (`hasColumn`, never a failing statement that would abort a transaction) and writes without the column when it is missing (that entry's `createdAt` is `null`), checking again a minute later.
