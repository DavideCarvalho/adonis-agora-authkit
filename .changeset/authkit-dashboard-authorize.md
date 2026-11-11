---
'@adonis-agora/authkit-client': major
---

`authkitDashboardMiddleware` is removed: every `@adonis-agora` console takes `authorize` now, so use `authkitDashboardAuthorize()` in its place. `authkitDashboardAuthorize` tells the two denials apart: a visitor without a session gets `401` (`{ allowed: false, reason: 'unauthenticated' }`) instead of `403`, and with the new `loginPath` option is sent to the app's login (`{ redirectTo }`). Signed in without the role is still `403`.
