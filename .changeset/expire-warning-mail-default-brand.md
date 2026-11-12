---
'@adonis-agora/authkit-server': patch
---

The `authkit:accounts:expire-scan --warn` inactivity warning now goes through the default mailer like every other built-in email: the `mail.onAccountExpirationWarning` hook still wins, otherwise it is sent in the host locale with the host branding (new `mail.account_expiration.*` messages, en + pt-BR) instead of a hardcoded English email.

`branding` without `default` (or without `firstParty`) is now resolved once: the default brand falls back to `branding.company`, then `'AuthKit'`, the same precedence the mailer used. Screens without a known client (session expired, throttled, login/consent for an unlisted client) now show the company name and a theme accent instead of the generic fallback, and a missing `firstParty` no longer crashes the consent check. `BrandingConfigInput` makes both fields optional in `defineConfig`.
