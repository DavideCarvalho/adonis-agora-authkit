# @adonis-agora/authkit-testing

## 1.0.0-rc.1

### Patch Changes

- fix(deps): update dependency jose to v6.2.16 ([#454](https://github.com/DavideCarvalho/adonis-agora-authkit/issues/454))

## 1.0.0-rc.0

### Major Changes

- [#436](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/436) [`c942fe3`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/c942fe30483346217c9c89112e13db0d4a65c647) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - AuthKit 1.0. See the [Migrating to 1.0](https://github.com/DavideCarvalho/adonis-agora-authkit/blob/main/apps/docs/content/docs/migrating-to-1-0.mdx) guide.
  
  Breaking changes (`@adonis-agora/authkit-server`):
  
  - `withMfa` is removed. MFA state lives in the lib-owned `auth_mfa` table, so drop the mixin from your `AuthUser` model's `compose(...)`.
  - `markSudo` is no longer exported. Grant sudo with `completeSudo(sudoContextFrom(ctx), methodId)`, which also writes the `sudo.confirmed` audit event, remembers the method and redirects to the validated `return_to`.
  - The email-change confirmation link is sent through `mail.onEmailChangeConfirm` only. Without it, AuthKit sends its built-in email; `onEmailVerification` no longer receives email-change confirmations.
  - The `clients` option of `defineConfig` is removed. Create clients in the admin console, through the Admin API or with `node ace authkit:clients:create` (new `--client-secret` flag keeps an existing secret). `buildImpersonationPanel(cfg, targetId, clients)` now requires `clients`, and the impersonation curl always shows the `<CLIENT_SECRET>` placeholder.
  - `inertiaRenderer({ prefix, views })`: `views` is required. Screens not listed render with the built-in Edge view. `AuthkitScreen` is now the exact union of the screens AuthKit renders (adds `throttled`, `agents/consent`, `agents/done`; no arbitrary strings), and every screen's props are exported: `AuthkitScreenProps['<view>']` plus named types (`LoginProps`, `SessionExpiredProps`, …). The controllers are checked against them. Hosts declare screens of their own by augmenting `AuthkitScreenProps` (`declare module '@adonis-agora/authkit-server'`).
  - The Admin API client body reads `grantTypes` only; the `grants` alias is gone (responses still return `grants`).
  - `lucidAccountStore` always mounts password history over the model's connection (`auth_password_history`).
  - `/account/orgs/json`, `/account/orgs/invitations/json` and `/account/orgs/:id/json` are removed; use `/account/api/orgs/*`.
  - `GET /account/api/apps` entries gain `name` and `logoUrl`.
  
  - The admin console reads its config from a `<script type="application/json" id="authkit-admin-config">` data block (CSP-safe) instead of an inline `window.__AUTHKIT__` script; the dev fallback is gone.
  - The admin client DTO returns `grantTypes` (was `grants`), plus `clientName` and `logoUri`, which the console and the Admin API can now set (`null` removes them, as it does `backchannelLogoutUri`). `GET {admin}/api/clients/:id` exists.
  - Anonymous JSON callers of the admin and account JSON APIs get `401` (and `403` without an admin role) instead of a redirect to the login page.
  - Fixes: the Redis adapter's `list()` honours the connection `keyPrefix` (sessions, apps and admin lists were empty); a password login posted without a password is an invalid-credentials answer, not a 500.
  
  Breaking changes (`@adonis-agora/authkit-core`):
  
  - `ClientConfig` and `ResolvedAuthServerConfig.clients` are removed.
  
  Breaking changes (`@adonis-agora/authkit-client`):
  
  - `@adonisjs/auth` is a required peer. `ctx.auth` is `@adonisjs/auth`, backed by the AuthKit session through `authkitClientGuard`; `ctx.authkit` (from `authkit_context_middleware`) carries the AuthKit-only data (identity, `hasGlobalRole`, active org, `toSharedProps`).
  - `authkit_middleware`, `auth_middleware` and `silent_auth_middleware` (and their subpaths) are removed: `ctx.auth` comes from `@adonisjs/auth`, and `middleware.auth()` / `silentAuth` are the `#middleware/auth_middleware` / `#middleware/silent_auth_middleware` files `node ace configure` publishes. `require_org_middleware` stays. `@adonis-agora/authkit-client/types` no longer declares `HttpContext.auth`; type `ctx.authkit.getUser()` through the `AuthkitUserType` interface.
  - `node ace configure @adonis-agora/authkit-client` installs `@adonisjs/auth` when missing (`--no-install` prints the command), writes `config/auth.ts` with `authkitClientGuard` + `sessionUserProvider` (`--model`, default `#models/user`; an existing file is left alone and the guard to add is printed), registers `@adonisjs/auth/auth_provider`, `initialize_auth_middleware` + `authkit_context_middleware`, and publishes the named `auth` / `silentAuth` middleware.
  - `authkitClientGuard` takes its user from `resolveUser` when one is configured (so `lucidMirror` provisions the row on first login, and what it loads is on `ctx.auth.user`, the same instance as `ctx.authkit.getUser()`), with the provider as the fallback.
  - New `authkitIdentityProvider()`: a user provider with no database; `ctx.auth.user` is the AuthKit `Identity`.
  - New `authkitClientGuard({ provider, resolver })` option: a per-guard resolver for API routes (bearer JWT, opaque, PAT).
  - `resolvers.jwt({ tokenSource: 'bearer' })` accepts `Authorization: DPoP <jwt>` with a valid `DPoP` proof for `cnf.jkt`-bound tokens, and refuses DPoP-bound tokens sent as `Bearer`.
  - `UnauthorizedAccessConstructor` is no longer exported, and `AuthkitClientGuard` no longer takes an exception class; it always throws `@adonisjs/auth`'s `E_UNAUTHORIZED_ACCESS`.
  
  Breaking changes (`@adonis-agora/authkit-sdk`):
  
  - `clients.*` return `grantTypes` (was `grants`), plus `clientName` and `logoUri`.
  
  Breaking changes (`@adonis-agora/authkit-react`):
  
  - `createAuthkitClient()` no longer reads `window.__AUTHKIT__`: pass `baseUrl` for `client.admin.*` and `csrfToken`.
  - Admin response types match the server: `users.remove` / `clients.remove` → `{ ok, deleted }`, `users.resetPassword` → `{ ok, email }`, `users.disable` / `enable` → the user, `SettingListResult.locked`; `AdminClient.grants` → `grantTypes` (+ `clientName`, `logoUri`); `UpdateUserInput` is `{ globalRoles? }`, `CreateUserInput` takes no `null`.
  - New: `client.account.agents.list()` / `revoke()`, `useAccountAgentsQueryOptions`, `useRevokeAccountAgentMutationOptions`.
  - Peers: `react` / `react-dom` `^19.0.0`, `@inertiajs/react` `^2.0.0 || ^3.0.0`.
  
  - `useProfile`, `useSessions`, `useAuthorizedApps`, `useOrganizations`, `useOrganization`, `useOrgInvitations`, `useSwitchOrganization` and their types are removed, with the `profile`, `sessions`, `apps`, `orgs` and `orgInvitations` keys of `endpoints`. Use the query options (`useMeQueryOptions`, `useAccountSessionsQueryOptions`, `useAppsQueryOptions`, `useAccountOrgsQueryOptions`, …).
  - `UserProfile`, `AuthorizedApps`, `OrganizationSwitcher` and `OrganizationProfile` need `QueryClientProvider` and `AuthkitClientProvider`.
  
  All packages:
  
  - `@adonis-agora/*` peer ranges accept 1.x and its release candidates (`<2.0.0 || >=1.0.0-rc.0 <2.0.0`): `durable`, `media`, `telescope` (authkit-server), `resilience` (authkit-client), `authkit-server` (authkit-sdk).
  - Node.js `>=24` is required (tested on 24 and 26).

### Patch Changes

- Updated dependencies [[`c942fe3`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/c942fe30483346217c9c89112e13db0d4a65c647)]:
  - @adonis-agora/authkit-core@1.0.0-rc.0

## 0.6.4

### Patch Changes

- fix(deps): update dependency jose to v6.2.15 ([#405](https://github.com/DavideCarvalho/adonis-agora-authkit/issues/405))

## 0.6.3

### Patch Changes

- fix(deps): update dependency jose to v6.2.14 ([#388](https://github.com/DavideCarvalho/adonis-agora-authkit/issues/388))

## 0.6.2

### Patch Changes

- Updated dependencies [[`1b9c90c`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/1b9c90ced4356d2c754e850e307954455ddeeb3a)]:
  - @adonis-agora/authkit-core@0.10.1

## 0.6.1

### Patch Changes

- fix(deps): update dependency jose to v6.2.13 ([#323](https://github.com/DavideCarvalho/adonis-agora-authkit/issues/323))

## 0.6.0

### Minor Changes

- [#269](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/269) [`b0ca480`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/b0ca4802419aba93a9f913775f697cc4075cff88) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Drop Node 20, which reached end-of-life on 2026-04-30, and Node 22, which AdonisJS 7 does not support (it requires Node >=24): `engines.node` is now `>=24`. The supported Node lines are 24 and 26, and CI runs the test suite on each of them.

### Patch Changes

- Updated dependencies [[`b0ca480`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/b0ca4802419aba93a9f913775f697cc4075cff88)]:
  - @adonis-agora/authkit-core@0.10.0

## 0.5.3

### Patch Changes

- Updated dependencies [[`94644e6`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/94644e6b1d8d10e0fd3c4b57706cce46b70412cb)]:
  - @adonis-agora/authkit-core@0.9.0

## 0.5.2

### Patch Changes

- bc32ea4: Bump runtime dependencies to their latest releases.
  
  - `@simplewebauthn/server` and `@simplewebauthn/browser` go to `14.x`. The committed
    `src/host/assets/webauthn.js` bundle was regenerated from the new `@simplewebauthn/browser`
    (the `check:webauthn-bundle` guard would have caught the drift otherwise). The `authkit-react`
    peer was **widened** to `^13.3.0 || ^14.0.0` instead of moved, so apps still on 13 keep
    installing cleanly.
  - `oidc-provider` 9.12.0 → 9.12.2 and `jose` 6.2.10 → 6.2.12 (patch releases on the token/JWT path).
  
  No API change on our side: typecheck, tests, packaging smoke and the WebAuthn bundle check all pass.

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
