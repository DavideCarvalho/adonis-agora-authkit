---
"@adonis-agora/authkit-server": minor
---

fix(signup): passwordless signup no longer creates the account before the e-mail is confirmed.

The signup POST used to create the account, then send the magic link. A failed send left an account behind, and anyone could create an account (and fire `account.created`) for someone else's e-mail. Now, for an e-mail without an account, the POST only sends a confirmation link carrying e-mail + name in a token encrypted with the app's APP_KEY (15 min, its own purpose). The account is created by the new `GET /auth/interaction/:uid/signup/confirm` when the owner opens the link, with `emailVerified: true`, and the login continues through the existing magic link flow (status, maintenance and second-factor gates). If the account already exists when the link is opened, the link is refused, which makes it single-use without database state. E-mails that already have an account still get a login magic link, and the response stays the same either way.

`mail.onMagicLink` receives `kind: 'signup'` for the confirmation link; hosts that ignore it keep working. The `signup` audit event and `account.created` now fire on confirmation.

Password signup: when the login right after creating the account fails, the new account is deleted (stores with `deleteAccount`), instead of leaving an "e-mail already registered" account nobody logged into.
