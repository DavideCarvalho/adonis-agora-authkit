---
'@adonis-agora/authkit-server': patch
---

The package barrel no longer carries `HttpContext.adminApiKeyId` into consumers.

`index.ts` re-exported `ACCOUNT_SESSION_KEY` from the account-auth middleware,
and that module side-effect-imports `../augmentations.js` to type its own
`ctx.session`. So importing anything from `@adonis-agora/authkit-server` also
loaded this package's `declare module '@adonisjs/core/http' { adminApiKeyId?: string }`
into the consumer's type program.

Nothing broke, and that is the point of fixing it. `adminApiKeyId` is a name only
this library claims, so the merge had nobody to collide with — nomenclature luck,
not design. The sibling client package shipped the identical shape over `auth`, a
name every app declares, and took a consumer from 24 type errors to 351 with
nothing pointing at the cause. The next property added here should not have to be
audited for how exotic its name happens to be.

`ACCOUNT_SESSION_KEY` now lives in its own import-free module,
`src/host/account_session_key.ts`, which the barrel and the nineteen internal
call sites read from. The middleware re-exports it, so nothing about the public
surface changes: same export, same value, same path for consumers.

The augmentation-isolation guard was tightened to match. It asserted that no
consumer entrypoint reaches `HttpContext.auth`; it now asserts that the barrel
reaches **no** `HttpContext` augmentation at all, which is the bar that does not
depend on picking safe names. Verified against a packed tarball in a consumer
project: before, `ctx.adminApiKeyId` type-checks in an app that never asked for
it; after, it does not — while all four container bindings still resolve through
the provider, checked with member-level probes and a control run confirming an
undeclared key fails.
