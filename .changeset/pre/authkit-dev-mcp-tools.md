---
'@adonis-agora/authkit-server': minor
'@adonis-agora/authkit-poppy': patch
---

Developer tools over MCP. When the app runs `@adonis-agora/agent`'s dev tools endpoint (`/mcp/agora`), the admin console's data is served there with no config: `authkit_get_overview`, `authkit_list_users`, `authkit_get_user`, `authkit_list_user_sessions`, `authkit_list_user_grants`, `authkit_list_orgs`, `authkit_get_org`, `authkit_list_clients`, `authkit_list_audit`, and the destructive actions `authkit_revoke_user_sessions` and `authkit_disable_user` (hidden until the endpoint allows actions; audited with `mcp:<caller>` as actor). Access follows `admin.authorize`; when it allows the MCP request, `admin.roles` is not checked. Without `admin.authorize`, production refuses and other environments need an AuthKit sign-in holding one of `admin.roles`.

`@adonis-agora/authkit-poppy` offers the `agora:dev` scope when the app serves those dev tools (`devTools` option to force it on or off). The consent screen never ticks it for the person, and Mediated Sign-In can't grant it. The personal-agent consent screen supports opt-in scopes (`optIn`, `descriptionKey` on each scope of `agents/consent`).
