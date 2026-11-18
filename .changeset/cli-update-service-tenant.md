---
'@adonis-agora/authkit-server': patch
---

`authkit:client update` now edits a service tenant, like the console and the Admin API: `--add-capability` / `--remove-capability` change one capability and keep the rest, `--capability` replaces the list, `--environment` sets it (`--environment=` clears it) and `--partition` changes it. The secret is kept, so the apps that already use it keep working.
