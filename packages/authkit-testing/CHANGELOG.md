# @adonis-agora/authkit-testing

## 0.5.1

### Patch Changes

- Updated dependencies [813a321]
  - @adonis-agora/authkit-core@0.8.0

## 0.5.0

### Minor Changes

- 1f15367: `fakeAuthenticator()` covers the whole `Authenticator` surface again.

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

### Patch Changes

- 1f15367: Point `homepage` and `bugs.url` at the repository's current name.

  The repository was renamed to `adonis-agora-authkit`; `repository.url` followed,
  `homepage` and `bugs.url` did not. Every package therefore shipped a manifest
  that disagreed with itself, and the "Repository"/"Homepage" links on npm leaned
  on GitHub's rename redirect — which lasts only until someone claims the old
  name. All three fields now name the same repository.

- Updated dependencies [1f15367]
  - @adonis-agora/authkit-core@0.7.1

## 0.4.0

### Minor Changes

- c12bac9: Remove `hasAppRole`/`appRoles` from the fake `Authenticator` (`fakeAuthenticator`), matching the real
  `@adonis-agora/authkit-client` surface after app-role authorization moved out of AuthKit. The fake now
  exposes only `hasGlobalRole` (token roles). 0.x breaking.

## 0.3.0

### Minor Changes

- 0542665: Re-scope to @adonis-agora/authkit-\* (join the Agora ecosystem)

### Patch Changes

- Updated dependencies [0542665]
  - @adonis-agora/authkit-core@0.7.0

## 0.2.5

### Patch Changes

- Updated dependencies [93eaf69]
- Updated dependencies [e2582b8]
  - @adonis-agora/authkit-core@0.6.0

## 0.2.4

### Patch Changes

- Updated dependencies [df4b41f]
  - @adonis-agora/authkit-core@0.5.0

## 0.2.3

### Patch Changes

- Updated dependencies
  - @adonis-agora/authkit-core@0.4.0

## 0.2.2

### Patch Changes

- Updated dependencies
  - @adonis-agora/authkit-core@0.3.1

## 0.2.1

### Patch Changes

- Updated dependencies
  - @adonis-agora/authkit-core@0.3.0

## 0.2.0

### Minor Changes

- 1872a30: DX & ops infra:
  - New package `@adonis-agora/authkit-testing` — test helpers for host apps:
    `createTestIdentity`, `mintTestIdToken` + `serveJwks`/`testJwks`/`jwksFromKey`
    (real RS256 tokens validated by a local JWKS), `fakeAuthenticator`, and a
    capability-aware `fakeAccountStore`.
  - `node ace authkit:doctor` — validates host config and prints ✅/⚠️/❌ findings
    (issuer/mountPath, clients, accountStore capabilities, session, shield, ally,
    rate-limit, admin, webauthn, jwks). Non-zero exit on errors.
  - `node ace authkit:rotate-keys` — rotates managed JWKS signing keys via a new
    file-backed keystore (`jwks: { source: 'managed', store }`), keeping the last
    N public keys so pre-rotation tokens still verify.

### Patch Changes

- Updated dependencies [1872a30]
  - @adonis-agora/authkit-core@0.2.0
