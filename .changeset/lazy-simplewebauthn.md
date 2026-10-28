---
"@adonis-agora/authkit-server": patch
---

Load `@simplewebauthn/server` on the first passkey ceremony instead of at import time. Importing the package no longer evaluates it (~290 modules, ~4.5 MB of heap per process), which most processes — queue workers, ace commands, apps without passkeys — never need. The `webauthnCeremonies` override seam and every public export are unchanged.
