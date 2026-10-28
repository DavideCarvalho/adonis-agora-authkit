---
"@adonis-agora/authkit-server": minor
"@adonis-agora/authkit-react": minor
---

"Last used" badge on the login screen. The server remembers, in a cookie on the device (`authkit_last_login`, httpOnly, no identity in it), the primary method the last login used — password, magic link, email code, passkey, a social provider or a custom method — and passes it as `lastUsedLoginMethod` to every `login` render. The built-in Edge screen marks the matching button; Inertia hosts use the new `<LastUsedBadge>` / `isLastUsedLoginMethod()` from authkit-react. It is per device on purpose: a per-account hint would tell anyone who types an email how that account signs in. Opt out with `login: { lastUsedMethod: false }`.

Also fixes cookies written during the final login request being dropped: `interactionFinished` ends the raw response before AdonisJS flushes its headers, so `completeLogin` now relays pending `Set-Cookie` headers first. This affected the "trust this device" cookie set after a successful second factor.
