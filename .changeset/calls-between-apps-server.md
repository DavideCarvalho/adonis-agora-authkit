---
'@adonis-agora/authkit-server': minor
'@adonis-agora/authkit-react': minor
---

Calls between apps: a service tenant can be granted other apps. Each grant (`apps` on the client: app name → capabilities) lets it get JWT access tokens for `urn:agora:app:<name>`, with its own `partition` and the capabilities of that grant. Grant from the admin console ("Apps it can call"), the Admin API (`PUT`/`DELETE /clients/:id/apps/:app`, or `serviceTenant.apps` on create/update) or the CLI (`authkit:client create --app=billing=invoices:read`, `grant-app`, `revoke-app`). On by default with `serviceTenants` (`serviceTenants: {}` turns on only this); `serviceTenants.apps: false` turns it off, `apps.expiresIn` sets the token lifetime (default 300 s). `serviceTenants.resources` is now optional.
