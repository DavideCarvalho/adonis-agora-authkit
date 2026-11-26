---
'@adonis-agora/authkit-server': minor
'@adonis-agora/authkit-client': patch
---

authkit-server serves calls between apps in-process. Without authkit-client in the app (e.g. the Agora Hub), it binds an `authkit.client`-compatible object: `appCallTokens().token(app)`/`reset()` minted by its own token endpoint for this app's service client (new `serviceTenants.apps.client`; default: the service tenant whose `partition` is the package.json name, the same without its npm scope, or AdonisJS `appName`, else the only service tenant granted other apps; a clear error naming the config line when none or several match), with grants checked exactly as for remote tokens; `appCallerVerifier().verifyToken()` with its own keys; `appKey()`/`publishAppKey()` on its own `auth_app_keys` table. authkit-client, when installed, wins. The `/api/apps/*` endpoints never return a stack trace: a missing table answers `503 schema_missing` with the fix, anything else `500 server_error`, both logged. The doctor's missing-tables fix names the migration to add. authkit-client: a failed key publish is logged once, at the first failure, with the HTTP status and what fixes it, then retried quietly.
