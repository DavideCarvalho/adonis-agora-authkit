---
'@adonis-agora/authkit-server': minor
---

Passwordless signup also sends a code when `login.otp` is on, so a person can finish in the same browser instead of opening the link in another one.

The account still isn't created until the code or the link is confirmed. The code is bound to the interaction and the browser session, and a correct one leads to the same confirmation link. `mail.onMagicLink` now receives `code` with `kind: 'signup'`, and an e-mail that already has an account gets a login code too, so the response stays the same either way.
