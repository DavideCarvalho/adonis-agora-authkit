---
'@adonis-agora/authkit-server': minor
---

New `onAccountCreated` config hook, called once for every account the IdP creates: sign-up (password, or passwordless by link or code), a social sign-in that creates the account, the admin console / Admin API / dev tools, and `authkit:users:import`. It receives `{ account, source, provider?, client?, actorId? }`, runs after the account is final and before the flow continues, and never fires when a sign-in reuses an existing account. A throwing hook is logged and does not undo the account or break the flow.
