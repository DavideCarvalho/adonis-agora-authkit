# @adonis-agora/authkit-vault-gcp

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

## 0.4.0

### Minor Changes

- [#269](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/269) [`b0ca480`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/b0ca4802419aba93a9f913775f697cc4075cff88) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Drop Node 20, which reached end-of-life on 2026-04-30, and Node 22, which AdonisJS 7 does not support (it requires Node >=24): `engines.node` is now `>=24`. The supported Node lines are 24 and 26, and CI runs the test suite on each of them.

## 0.3.1

### Patch Changes

- 1f15367: Point `homepage` and `bugs.url` at the repository's current name.

  The repository was renamed to `adonis-agora-authkit`; `repository.url` followed,
  `homepage` and `bugs.url` did not. Every package therefore shipped a manifest
  that disagreed with itself, and the "Repository"/"Homepage" links on npm leaned
  on GitHub's rename redirect — which lasts only until someone claims the old
  name. All three fields now name the same repository.

## 0.3.0

### Minor Changes

- 0542665: Re-scope to @adonis-agora/authkit-\* (join the Agora ecosystem)

## 0.2.0

### Minor Changes

- a39352e: feat: packages de cofre do keystore JWKS para AWS Secrets Manager, GCP Secret Manager
  e Azure Key Vault. Cada um exporta `createKeystoreVault(cfg)`; o SDK da cloud é peer
  OPCIONAL (lazy-import). Consumidos pelo authkit-server via o driver `jwks.store`.
