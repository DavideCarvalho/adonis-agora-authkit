---
'@adonis-agora/authkit-server': patch
---

Fix the `schema` docblock, which under-counted the auto-managed tables.

It listed six (`authkit_oidc_payloads`, `auth_settings`, `auth_password_history`
"and the three organization ones"), while `TABLES` in `schema/ensure.ts` has
eight — `auth_mfa` and `auth_session_revocations` were missing. A reader sizing
up what `autoManage: false` puts on their plate got the wrong answer. The
docblock now names all eight and points at the array that actually decides,
and calls out `authkit_keystore` as created on demand by `LucidKeystoreVault`
rather than by this mechanism.
