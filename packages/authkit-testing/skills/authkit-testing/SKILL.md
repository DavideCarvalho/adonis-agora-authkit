---
name: authkit-testing
description: >-
  Test AuthKit host apps without booting an IdP using @adonis-agora/authkit-testing.
  Covers createTestIdentity (valid Identity defaults), fakeAuthenticator (fake
  ctx.authkit: identity:null for anonymous, user for ctx.auth via authkitClientGuard,
  getUserOrFail/toSharedProps semantics), fakeAccountStore (capability flags
  withMfa/withPasskeys/withAccountSecurity + overrides), and real RS256 tokens with
  mintTestIdToken + serveJwks + resolvers.jwt (tokenSource, issuer/aud matching,
  generateTestKeyPair/jwksFromKey key reuse, closing the served JWKS).
  Use when writing controller, middleware or resolver tests for an app on
  @adonis-agora/authkit-client or authkit-server, or when a test identity resolves to null.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/authkit-testing"
  library_version: "1.0.1"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-authkit:packages/authkit-testing/README.md"
  - "DavideCarvalho/adonis-authkit:packages/authkit-testing/src/authenticator.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-testing/src/account_store.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-testing/src/jwt.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-testing/src/identity.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-client/src/resolvers/factory.ts"
  - "DavideCarvalho/adonis-authkit:apps/docs/content/docs/testing.mdx"
---

# Testing AuthKit host apps

`@adonis-agora/authkit-testing` lets a host app test auth flows with no IdP running.
It has two levels: **fakes** (`fakeAuthenticator`, `fakeAccountStore`,
`createTestIdentity`) for controller and service tests, and **real tokens**
(`mintTestIdToken` + `serveJwks`) for resolver-level tests where the JWT signature
is actually verified. The fakes reproduce the client/server surfaces structurally,
so the package has no runtime dependency on either.

## Setup

```bash
pnpm add -D @adonis-agora/authkit-testing
```

Everything is exported from the package root:

```ts
import {
  createTestIdentity,
  fakeAccountStore,
  fakeAuthenticator,
  generateTestKeyPair,
  jwksFromKey,
  mintTestIdToken,
  serveJwks,
  testJwks,
} from '@adonis-agora/authkit-testing'
```

Source: `packages/authkit-testing/index.ts`.

## Core patterns

### Pattern 1 — fake `ctx.authkit` in controller tests

`fakeAuthenticator({ identity?, user? })` returns the `Authenticator` surface
`ctx.authkit` exposes. `identity` defaults to `createTestIdentity()`; pass `null`
for an anonymous request. `user` defaults to the identity itself.

```ts
import { createTestIdentity, fakeAuthenticator } from '@adonis-agora/authkit-testing'

const admin = fakeAuthenticator({
  identity: createTestIdentity({ userId: 'user-42', globalRoles: ['ADMIN'] }),
})
admin.hasGlobalRole('ADMIN') // true

const anonymous = fakeAuthenticator({ identity: null })
await anonymous.check() // false
await anonymous.toSharedProps() // null — the "no session" signal for the frontend
```

With no identity, `authenticate()` and `getUserOrFail()` throw; `getUserOrFail()`
also throws when an identity is present but `user` is `null`/`undefined`.
`resolvesUser` is `true` only when you passed a `user` key.

Source: `src/authenticator.ts`, `src/identity.ts`.

### Pattern 2 — drive `ctx.auth` through `authkitClientGuard`

The guard reads `ctx.authkit`, so the same fake authenticates `ctx.auth`: with `user`,
`ctx.auth.user` is that user; without it, the guard asks its provider by the
identity's `userId`. Set the fake **before** creating the authenticator:

```ts no-check
const user = await UserFactory.create()
const ctx = await testUtils.createHttpContext()
ctx.authkit = fakeAuthenticator({ identity: createTestIdentity({ userId: user.id }), user }) as any
ctx.auth = (await app.container.make('auth.manager')).createAuthenticator(ctx)

await ctx.auth.authenticate()
```

Source: `packages/authkit-testing/README.md` (`fakeAuthenticator`),
`apps/docs/content/docs/testing.mdx` § Controllers that read `ctx.auth`.

### Pattern 3 — real signed tokens through `resolvers.jwt`

`mintTestIdToken({ issuer, clientId, claims?, key?, expiresInSeconds? })` signs a
real RS256 JWT (`iss` = issuer, `aud` = clientId, default `sub`/`email`) and returns
`{ token, key, jwks }`. `JwtResolver` fetches keys with `createRemoteJWKSet`, so it
needs a URL: `serveJwks(jwks)` serves `GET /.well-known/jwks.json` on an ephemeral
`127.0.0.1` port and returns `{ jwksUri, server, close }`.

```ts
import { conventionEndpoints, resolvers } from '@adonis-agora/authkit-client'
import { mintTestIdToken, serveJwks } from '@adonis-agora/authkit-testing'

const { token, jwks } = await mintTestIdToken({
  issuer: 'https://idp.test',
  clientId: 'my-app',
  claims: { sub: 'user-42', email: 'jane@test.dev', roles: ['ADMIN'] },
})
const served = await serveJwks(jwks)

const resolver = await resolvers
  .jwt({ jwksUri: served.jwksUri, tokenSource: 'bearer' })
  .resolver({
    issuer: 'https://idp.test',
    clientId: 'my-app', // checked against the token's `aud`
    sessionKey: 'authkit',
    globalRolesClaim: 'roles', // claim the roles were minted under
    endpoints: async () => conventionEndpoints('https://idp.test'),
    logger: { warn: () => {} },
  })

const ctx = { request: { header: () => `Bearer ${token}` } } as any
const identity = await resolver.resolve(ctx)
// identity?.userId === 'user-42', identity?.globalRoles → ['ADMIN']

await served.close()
```

Reuse one keypair across many tokens with `generateTestKeyPair(kid?)` + the `key`
option; `jwksFromKey(key)` (alias of `testJwks(key)`) returns the public `{ keys }`.

Source: `src/jwt.ts`, `packages/authkit-client/src/resolvers/factory.ts` (`jwt`).

### Pattern 4 — capability-aware `fakeAccountStore`

The core methods (`findById`, `verifyCredentials`, `findByEmail`, `create`,
provider-identity linking, reset/verification tokens, `listAccounts`,
`setGlobalRoles`) are always present. MFA, passkeys and account-security methods
are opt-in so the server's `supportsMfa` / `supportsPasskeys` /
`supportsAccountSecurity` guards flip:

```ts
import { fakeAccountStore } from '@adonis-agora/authkit-testing'

const store = fakeAccountStore({
  account: { id: 'u1', email: 'jane@acme.dev', globalRoles: ['ADMIN'] },
  withMfa: true,
  overrides: { findById: async () => null }, // force the "not found" branch
})
```

`verifyCredentials` ignores the password and matches on email only. The default
account is `{ id: 'u1', email: 'a@b.com', globalRoles: ['ADMIN'] }`.

Source: `src/account_store.ts`.

## Common mistakes

### HIGH — Putting the fake on `ctx.auth` instead of `ctx.authkit`

```ts no-check
// Wrong — ctx.auth is the @adonisjs/auth authenticator; the guard never sees this
ctx.auth = fakeAuthenticator({ identity }) as any
```

```ts no-check
// Correct — the fake replaces ctx.authkit; ctx.auth is derived from it by the guard
ctx.authkit = fakeAuthenticator({ identity, user }) as any
ctx.auth = (await app.container.make('auth.manager')).createAuthenticator(ctx)
```

`fakeAuthenticator` mirrors the client's `Authenticator` (what `ctx.authkit`
exposes), not Adonis' `ctx.auth`. `authkitClientGuard` reads `ctx.authkit`, so a fake
assigned elsewhere leaves the request unauthenticated.

Source: `src/authenticator.ts` (`FakeAuthenticatorLike` JSDoc), README `fakeAuthenticator`.

### HIGH — Sending a Bearer header to a resolver that reads the session

```ts no-check
// Wrong — tokenSource defaults to 'session': the header is ignored, resolve() → null
const factory = resolvers.jwt({ jwksUri: served.jwksUri })
await (await factory.resolver(rc)).resolve({ request: { header: () => `Bearer ${token}` } } as any)
```

```ts no-check
// Correct — read the Authorization header explicitly
const factory = resolvers.jwt({ jwksUri: served.jwksUri, tokenSource: 'bearer' })
```

`resolvers.jwt` defaults `tokenSource` to `'session'` (the session's id token under
`sessionKey`); only `'bearer'` turns on Authorization-header parsing.

Source: `packages/authkit-client/src/resolvers/factory.ts` (`tokenSource ?? 'session'`,
`authorizationHeader: tokenSource === 'bearer'`).

### MEDIUM — Minting with an issuer/clientId/roles claim the resolver does not expect

```ts no-check
// Wrong — aud 'web' vs clientId 'my-app', roles under 'groups' vs globalRolesClaim 'roles'
await mintTestIdToken({ issuer: 'https://idp.test', clientId: 'web', claims: { groups: ['ADMIN'] } })
```

`iss` must equal the resolver's endpoints issuer and `aud` its `clientId`, or
verification fails and `resolve()` returns `null`; roles under another claim
resolve to empty `globalRoles`. Mint with the same `issuer`, `clientId` and
`globalRolesClaim` you pass to `.resolver(...)`.

Source: `src/jwt.ts` (`MintTestIdTokenOptions` JSDoc), `resolvers/factory.ts` (`audience: rc.clientId`).

### MEDIUM — Leaving served JWKS servers open

```ts no-check
// Wrong — every serveJwks() binds a new port that stays open after the test
const served = await serveJwks(jwks)
```

```ts no-check
// Correct — close it in teardown
const served = await serveJwks(jwks)
cleanup(() => served.close())
```

Each call starts a real `node:http` server; unclosed ones leak sockets and can keep
the test runner from exiting.

Source: `src/jwt.ts` (`ServedJwks.close`: "chame no `group.teardown`").

### MEDIUM — Treating capability flags as full implementations

`withMfa` / `withPasskeys` / `withAccountSecurity` add only a few stub methods
(e.g. `getMfaState` → `{ enabled: false }`) so the `supports*` guards pass. Code that
calls further capability methods (`startTotpEnrollment`, …) must get them via
`overrides`, or it hits `undefined is not a function`.

Source: `src/account_store.ts`, `apps/docs/content/docs/testing.mdx` (`fakeAccountStore` callout).

See also: `authkit-rp-client` (`@adonis-agora/authkit-client`) — the resolvers and
`ctx.authkit` surface these helpers stand in for.
