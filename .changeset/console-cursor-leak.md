---
'@adonis-agora/authkit-server': patch
---

Admin console: switching pages now clears the `after`/`before` cursors too. The Audit Log cursor no longer follows you to Sessions, where it failed with "Invalid cursor.".
