---
'@adonis-agora/authkit-server': minor
---

Poppy: `poppyEmailCodeSignIn()`, a ready-made Mediated Sign-In. The agent asks for the account's
email, AuthKit emails a 6-digit code (new `mail.onPoppySignInCode` hook, or the default mailer with
branding and en/pt-BR copy) and the agent submits it — no `verify` to write. No account
enumeration (same answer for unknown, disabled, ineligible or rate-limited emails, email sent
without awaiting), per-email hourly cap, `eligible` filter.
