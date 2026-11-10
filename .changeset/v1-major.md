---
"@adonis-agora/authkit-server": major
"@adonis-agora/authkit-client": major
"@adonis-agora/authkit-core": major
"@adonis-agora/authkit-react": major
"@adonis-agora/authkit-sdk": major
"@adonis-agora/authkit-testing": major
"@adonis-agora/authkit-vault-aws": major
"@adonis-agora/authkit-vault-azure": major
"@adonis-agora/authkit-vault-gcp": major
---

AuthKit 1.0. See the [Migrating to 1.0](https://github.com/DavideCarvalho/adonis-agora-authkit/blob/main/apps/docs/content/docs/migrating-to-1-0.mdx) guide.

Breaking changes (`@adonis-agora/authkit-server`):

- `withMfa` is removed. MFA state lives in the lib-owned `auth_mfa` table, so drop the mixin from your `AuthUser` model's `compose(...)`.
- `markSudo` is no longer exported. Grant sudo with `completeSudo(sudoContextFrom(ctx), methodId)`, which also writes the `sudo.confirmed` audit event, remembers the method and redirects to the validated `return_to`.
- The email-change confirmation link is sent through `mail.onEmailChangeConfirm` only. Without it, AuthKit sends its built-in email; `onEmailVerification` no longer receives email-change confirmations.
- The `clients` option of `defineConfig` is removed. Create clients in the admin console, through the Admin API or with `node ace authkit:clients:create` (new `--client-secret` flag keeps an existing secret). `buildImpersonationPanel(cfg, targetId, clients)` now requires `clients`, and the impersonation curl always shows the `<CLIENT_SECRET>` placeholder.
- `inertiaRenderer({ prefix, views })`: `views` is required. Screens not listed render with the built-in Edge view.
- The Admin API client body reads `grantTypes` only; the `grants` alias is gone (responses still return `grants`).
- `lucidAccountStore` always mounts password history over the model's connection (`auth_password_history`).
- `/account/orgs/json`, `/account/orgs/invitations/json` and `/account/orgs/:id/json` are removed; use `/account/api/orgs/*`.
- `GET /account/api/apps` entries gain `name` and `logoUrl`.

Breaking changes (`@adonis-agora/authkit-core`):

- `ClientConfig` and `ResolvedAuthServerConfig.clients` are removed.

Breaking changes (`@adonis-agora/authkit-client`):

- `@adonisjs/auth` is a required peer. `ctx.auth` is `@adonisjs/auth`, backed by the AuthKit session through `authkitClientGuard`; `ctx.authkit` (from `authkit_context_middleware`) carries the AuthKit-only data (identity, `hasGlobalRole`, active org, `toSharedProps`).
- `authkit_middleware` and the `./authkit_middleware` subpath are removed. `@adonis-agora/authkit-client/types` no longer declares `HttpContext.auth`; type `ctx.authkit.getUser()` through the `AuthkitUserType` interface.
- `node ace configure @adonis-agora/authkit-client` installs `@adonisjs/auth` when missing (`--no-install` prints the command), writes `config/auth.ts` with `authkitClientGuard` + `sessionUserProvider` (`--model`, default `#models/user`; an existing file is left alone and the guard to add is printed), registers `@adonisjs/auth/auth_provider`, `initialize_auth_middleware` + `authkit_context_middleware`, and publishes the named `auth` / `silentAuth` middleware.
- `authkitClientGuard` takes its user from `resolveUser` when one is configured (so `lucidMirror` provisions the row on first login, and what it loads is on `ctx.auth.user`, the same instance as `ctx.authkit.getUser()`), with the provider as the fallback.
- New `authkitIdentityProvider()`: a user provider with no database; `ctx.auth.user` is the AuthKit `Identity`.
- New `authkitClientGuard({ provider, resolver })` option: a per-guard resolver for API routes (bearer JWT, opaque, PAT).
- `resolvers.jwt({ tokenSource: 'bearer' })` accepts `Authorization: DPoP <jwt>` with a valid `DPoP` proof for `cnf.jkt`-bound tokens, and refuses DPoP-bound tokens sent as `Bearer`.
- `UnauthorizedAccessConstructor` is no longer exported, and `AuthkitClientGuard` no longer takes an exception class; it always throws `@adonisjs/auth`'s `E_UNAUTHORIZED_ACCESS`.

Breaking changes (`@adonis-agora/authkit-react`):

- `useProfile`, `useSessions`, `useAuthorizedApps`, `useOrganizations`, `useOrganization`, `useOrgInvitations`, `useSwitchOrganization` and their types are removed, with the `profile`, `sessions`, `apps`, `orgs` and `orgInvitations` keys of `endpoints`. Use the query options (`useMeQueryOptions`, `useAccountSessionsQueryOptions`, `useAppsQueryOptions`, `useAccountOrgsQueryOptions`, …).
- `UserProfile`, `AuthorizedApps`, `OrganizationSwitcher` and `OrganizationProfile` need `QueryClientProvider` and `AuthkitClientProvider`.

All packages:

- `@adonis-agora/*` peer ranges accept 1.x and its release candidates (`<2.0.0 || >=1.0.0-rc.0 <2.0.0`): `durable`, `media`, `telescope` (authkit-server), `resilience` (authkit-client), `authkit-server` (authkit-sdk).
- Node.js `>=24` is required (tested on 24 and 26).
