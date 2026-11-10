---
"@adonis-agora/authkit-server": major
"@adonis-agora/authkit-client": major
"@adonis-agora/authkit-core": major
"@adonis-agora/authkit-react": major
"@adonis-agora/authkit-sdk": major
"@adonis-agora/authkit-testing": major
"@adonis-agora/authkit-vault-aws": major
"@adonis-agora/authkit-vault-azure": major
"@adonis-agora/authkit-vault-gcp": major
---

AuthKit 1.0. See the [Migrating to 1.0](https://github.com/DavideCarvalho/adonis-agora-authkit/blob/main/apps/docs/content/docs/migrating-to-1-0.mdx) guide.

Breaking changes (`@adonis-agora/authkit-server`):

- `withMfa` is removed. MFA state lives in the lib-owned `auth_mfa` table, so drop the mixin from your `AuthUser` model's `compose(...)`.
- `markSudo` is no longer exported. Grant sudo with `completeSudo(sudoContextFrom(ctx), methodId)`, which also writes the `sudo.confirmed` audit event, remembers the method and redirects to the validated `return_to`.
- The email-change confirmation link is sent through `mail.onEmailChangeConfirm` only. Without it, AuthKit sends its built-in email; `onEmailVerification` no longer receives email-change confirmations.

All packages:

- `@adonis-agora/*` peer ranges accept 1.x (`<2.0.0`): `durable`, `media`, `telescope` (authkit-server), `resilience` (authkit-client), `authkit-server` (authkit-sdk).
- Node.js `>=24` is required.
