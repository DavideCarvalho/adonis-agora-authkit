---
'@adonis-agora/authkit-server': patch
---

Default emails (new login / new device alerts, password reset, verification, magic link, sudo link, OTP unlock, email change, security notices, org invitations, `sendAuthkitCodeEmail`) now always use the host's `i18n.locale` and `branding`. They used to read the config through `ctx.containerResolver.app`, which a real request's container resolver does not have, so they silently fell back to English and the "AuthKit" brand. The mailer now uses the resolved config the caller already has, or resolves the `authkit.server` binding, and logs a warning once when it cannot find the config. The header falls back to `branding.company` when `branding.default` is absent.
