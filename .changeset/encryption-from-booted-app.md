---
'@adonis-agora/authkit-server': patch
---

The keystore and the TOTP encrypter now get the app's `encryption` service from the booted app the provider captured, instead of importing `@adonisjs/core/services/encryption`. When it can't be loaded, the keystore error now carries the real cause (`AuthKit keystore: serviço de encryption (APP_KEY) indisponível: <cause>`, with `error.cause`) instead of only "indisponível", and a failed load is no longer kept for the life of the process.
