---
'@adonis-agora/authkit-client': minor
'@adonis-agora/authkit-server': minor
---

`registerOidcClient` now mounts everything a relying party needs so identity stays on the identity server: `GET {prefix}/signup` (same flow as login, with the standard `prompt=create`) and redirects to the issuer's pages, keeping the rest of the path and the query string — `/account` and `/account/*`, `{prefix}/forgot-password`, `{prefix}/reset-password[/*]`, `{prefix}/admin[/*]`. The targets come from the issuer's discovery (`authkit_*_uri`), falling back to the authkit-server defaults on the issuer origin; redirects never leave that origin. When authkit-server runs in the same app the redirects are not mounted. New `oidcClientRoutes(options)` exports the same handlers (`login`, `signup`, `callback`, `logout`, `backchannelLogout`, `account`, `forgotPassword`, `resetPassword`, `admin`) for apps that mount routes themselves.

authkit-server honours `prompt=create`: with no IdP session the interaction opens on the sign-up screen (login screen when public sign-up is closed), and discovery advertises it in `prompt_values_supported`. Discovery also publishes `authkit_account_uri`, `authkit_account_home_uri`, `authkit_admin_uri` (when the admin console is mounted and enabled), `authkit_forgot_password_uri` and `authkit_reset_password_uri`.
