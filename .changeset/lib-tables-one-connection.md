---
'@adonis-agora/authkit-server': patch
'@adonis-agora/authkit-sdk': patch
---

Every table AuthKit owns now uses one Lucid connection: `schema.connection` (default: the primary connection). Before, some of them followed other connections, so with the account model on a named connection the boot created a table on one connection and the code read it on another:

- `auth_settings` (runtime settings, the settings CLI, `authkit:expire-scan`, the SDK's embedded driver) followed the account model's connection.
- `auth_mfa` and `auth_password_history` used the account model's connection.
- The built-in organization models had no connection, so they always used the primary one.
- `adapters.database()` and the `lucid` keystore without their own `connection` used the primary connection.

They all use `schema.connection` now; `adapters.database({ connection })` and `jwks.store: { driver: 'lucid', connection }` still win when set. The app's account table stays on the account model's connection, and the boot adds the `login_methods` column there. If your app had `schema.connection` unset and the account model on a named connection, those tables move to the primary connection: set `schema.connection` to the connection where they already are.
