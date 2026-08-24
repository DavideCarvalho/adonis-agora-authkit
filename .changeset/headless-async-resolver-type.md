---
"@adonis-agora/authkit-server": patch
---

Fix `headless.resolveAccountId` type to accept a `Promise`

The host resolver is commonly async (e.g. `await ctx.auth.getUserOrFail()` to
return the account `user.id`). The signature published in `0.61.0` was sync
(`(ctx) => string | null`), which broke the app's typecheck for an `async`
resolver. The type now accepts `string | null | Promise<string | null>` — the
controller already `await`s the return. No runtime change.