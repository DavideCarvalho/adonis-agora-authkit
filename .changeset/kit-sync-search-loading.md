---
'@adonis-agora/authkit-server': patch
---

Console ⌘K shows its loading state: a spinner in the search box while a request is in flight, skeleton rows until the first answer, earlier hits kept but dimmed during a re-search, "Nothing found" only after an empty answer, and a quiet "didn't answer" line with Retry when the search fails. Synced with the shared console kit (DataTable `rowClassName`/`subRow`, ⌘K console-local `commands`, collapsible nav sections).
