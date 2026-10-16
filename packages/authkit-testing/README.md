# @adonis-agora/authkit-testing

Test helpers so **host apps** built on AuthKit can test auth flows without booting
an IdP. Mint real signed ID tokens validated by a local JWKS, fake the
`ctx.auth` authenticator, fake an account store, and build valid identities.

```sh
pnpm add -D @adonis-agora/authkit-testing
```

## API

### `createTestIdentity(overrides?)`

Returns a valid `Identity` with sane defaults.

```ts
import { createTestIdentity } from '@adonis-agora/authkit-testing'

const identity = createTestIdentity({ globalRoles: ['ADMIN'] })
```

### `mintTestIdToken({ issuer, clientId, claims?, key?, expiresInSeconds? })`

Mints a **real** RS256-signed JWT plus the public JWKS that validates it. Returns
`{ token, key, jwks }`.

```ts
import { mintTestIdToken, serveJwks } from '@adonis-agora/authkit-testing'
import { conventionEndpoints, resolvers } from '@adonis-agora/authkit-client'

const { token, jwks } = await mintTestIdToken({
  issuer: 'https://idp.test',
  clientId: 'my-app',
  claims: { sub: 'user-42', email: 'jane@test.dev', roles: ['ADMIN'] },
})

// Serve the JWKS in-process so resolvers.jwt({ jwksUri }) can validate it.
const served = await serveJwks(jwks)
const factory = resolvers.jwt({ jwksUri: served.jwksUri })
const resolver = await factory.resolver({
  issuer: 'https://idp.test',
  clientId: 'my-app',
  sessionKey: 'authkit',
  globalRolesClaim: 'roles',
  endpoints: async () => conventionEndpoints('https://idp.test'),
  logger: { warn: () => {} },
})
// ... use resolver in your host test, then:
await served.close()
```

The `JwtResolver` uses `createRemoteJWKSet`, so it needs a URL — `serveJwks()`
provides one locally with no external network. You can also reuse a single
keypair across tokens via `generateTestKeyPair()` + the `key` option, or get the
raw public JWKS object with `jwksFromKey(key)` / `testJwks(key)`.

### `fakeAuthenticator({ identity?, user? })`

Object satisfying the client's `Authenticator` surface, for injecting into
`ctx.auth` in controller tests. O AuthKit só autentica — autorização por role é
do `@adonis-agora/authz`, então o fake expõe só `hasGlobalRole` (roles do token).

```ts
import { fakeAuthenticator } from '@adonis-agora/authkit-testing'

const auth = fakeAuthenticator({
  identity: createTestIdentity({ globalRoles: ['ADMIN'] }),
})
auth.hasGlobalRole('ADMIN') // true
```

Pass `identity: null` to simulate an anonymous request.

### `fakeAccountStore(options?)`

A capability-aware fake `AccountStore`. The core methods are always present;
MFA, passkeys and account-security capabilities are opt-in so you can exercise
the server's `supportsMfa` / `supportsPasskeys` / `supportsAccountSecurity`
type guards.

```ts
import { fakeAccountStore } from '@adonis-agora/authkit-testing'

const store = fakeAccountStore({
  account: { id: 'u1', email: 'a@b.com', globalRoles: ['ADMIN'] },
  withMfa: true,
  overrides: { findById: async () => null },
})
```

## License

MIT
