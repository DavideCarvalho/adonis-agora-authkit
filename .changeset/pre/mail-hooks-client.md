---
'@adonis-agora/authkit-server': minor
---

Mail hooks now say which app the email is for. `onMagicLink`, `onEmailVerification`, `onOtpUnlock`, `onNewLogin` and `onNewDeviceLogin` receive an optional `client: { clientId, appName? }` when the flow belongs to an OIDC client (`appName` from `branding.clients[clientId].appName`, else the client's `client_name`). The default emails use `branding.clients[clientId]` for the brand name and accent when the client has one, falling back to `branding.default`. Hooks that ignore the field keep working.
