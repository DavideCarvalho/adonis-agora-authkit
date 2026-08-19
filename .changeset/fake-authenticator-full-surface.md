---
'@adonis-agora/authkit-testing': minor
---

`fakeAuthenticator()` covers the whole `Authenticator` surface again.

The client's `Authenticator` grew `getUserOrFail()` and `toSharedProps()`, but
`FakeAuthenticatorLike` did not — so injecting the fake into a `ctx.auth` typed
as `Authenticator` stopped type-checking, which is the one job the fake has.
Both methods now exist on the fake, with the same fail-closed semantics as the
real one: `getUserOrFail()` throws when there is no session (or no user), and
`toSharedProps()` returns `null` when there is no session and
`{ user, globalRoles }` when there is.

A compile-time assignment against the real `Authenticator` type now guards the
surface, so the next method added to the real class fails the testing package's
typecheck instead of failing silently in host apps.
