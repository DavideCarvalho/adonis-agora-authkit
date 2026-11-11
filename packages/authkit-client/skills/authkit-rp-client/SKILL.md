---
name: authkit-rp-client
description: >-
  Integrate an AdonisJS app as an OpenID Connect relying party with
  @adonis-agora/authkit-client. Covers defineConfig, resolvers.jwt / pat / opaque,
  resolveUser (lucidMirror, identityToUser, createUserinfoResolver), ctx.auth via the
  required @adonisjs/auth peer (authkitClientGuard with sessionUserProvider or
  authkitIdentityProvider, middleware.auth(), auth.user), API guards with
  authkitClientGuard({ resolver }) for bearer JWT, DPoP, opaque and PAT, the session ->
  initialize_auth -> authkit_context_middleware ordering rule, ctx.authkit
  (getIdentity/hasGlobalRole/toSharedProps), registerOidcClient, backchannelLogout:
  { store }, and why app-role gating belongs to @adonis-agora/authz. Use when wiring a
  client app to the IdP, fixing a null identity or a first-login loop, choosing a user
  provider, protecting API routes, or adding back-channel logout.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/authkit-client"
  library_version: "0.18.0"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-authkit:packages/authkit-client/README.md"
  - "DavideCarvalho/adonis-authkit:packages/authkit-client/src/define_config.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-client/src/resolvers/factory.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-client/src/register_oidc_client.ts"
---

# OIDC relying-party (client) integration

`@adonis-agora/authkit-client` makes an AdonisJS app consume an OIDC provider (the
AuthKit IdP or any other) with session-based auth: PKCE authorization-code login,
locally-validated ID tokens (JWKS). `ctx.auth` is `@adonisjs/auth` (a required peer)
backed by the AuthKit session through `authkitClientGuard`; `ctx.authkit` carries the
AuthKit-only data. `configure` installs `@adonisjs/auth` if missing, publishes
`config/authkit_client.ts`, `config/auth.ts` (guard + `sessionUserProvider`, `--model`,
default `#models/user`; an existing file is left alone) and the named `auth` /
`silentAuth` middleware, and registers the providers plus `initialize_auth_middleware` and
`authkit_context_middleware`; the login/callback/logout routes come from
`registerOidcClient(router)`. (`configure` also publishes an `OidcSessionController` stub,
only for apps that must customise the flow.)

## Setup

```bash
node ace add @adonis-agora/authkit-client
```

```ts
// config/authkit_client.ts
import env from '#start/env'
import { defineConfig, lucidMirror, resolvers } from '@adonis-agora/authkit-client'
import AppUser from '#models/app_user'

const authkitClientConfig = defineConfig({
  issuer: env.get('AUTHKIT_ISSUER'),
  clientId: env.get('AUTHKIT_CLIENT_ID'),
  clientSecret: env.get('AUTHKIT_CLIENT_SECRET'),
  redirectUri: env.get('AUTHKIT_REDIRECT_URI'), // must point at the callback route
  resolver: resolvers.jwt({ tokenSource: 'session' }),
  // Creates the local row on first login; ctx.auth.user is this user.
  resolveUser: lucidMirror(AppUser, { sync: (i) => ({ email: i.email }) }),
})

export default authkitClientConfig
```

```ts
// config/auth.ts (written by configure)
import { defineConfig } from '@adonisjs/auth'
import { sessionUserProvider } from '@adonisjs/auth/session'
import { authkitClientGuard } from '@adonis-agora/authkit-client/auth'

export default defineConfig({
  default: 'web',
  guards: {
    web: authkitClientGuard({
      provider: sessionUserProvider({ model: () => import('#models/app_user') }),
    }),
  },
})
```

```ts
// start/routes.ts
import router from '@adonisjs/core/services/router'
import { registerOidcClient } from '@adonis-agora/authkit-client'

// /auth/login, /auth/callback, /auth/logout and /auth/backchannel-logout
registerOidcClient(router)
```

If you wire the scaffolded `OidcSessionController` instead, keep it on the manager:
`startSession(ctx, tokenSet)` in the callback and `endSession(ctx)` in the logout —
never a raw `session.put(sessionKey)` / `session.forget(sessionKey)`, which leaves a
parked impersonation credential alive.

Source: `packages/authkit-client/README.md`, `stubs/config/authkit_client.stub`.

## Core patterns

### Pattern 1 — `ctx.auth` per request, `ctx.authkit` for AuthKit-only data

```ts
// app/controllers/me_controller.ts
export default class MeController {
  async handle({ auth, authkit }: HttpContext) {
    const user = auth.getUserOrFail()             // the resolveUser user (sync, behind auth)
    const identity = await authkit.getIdentity()  // validated OIDC claims
    const isAdmin = authkit.hasGlobalRole('ADMIN') // sync — reads token claims
    return { user, identity, isAdmin }
  }
}

// start/routes.ts
router.get('/me', [MeController]).use(middleware.auth())
```

The guard's user comes from `resolveUser` first (so `lucidMirror` provisions on first
login; `ctx.auth.user` is the same object as `await ctx.authkit.getUser()`), then from the
provider. No local user table: `provider: authkitIdentityProvider()` makes `ctx.auth.user`
the `Identity`. `auth.getUserOrFail()` is synchronous and throws unless
`middleware.auth()`/`middleware.silentAuth()`/`auth.check()` ran.

Source: `packages/authkit-client/README.md` § Uso por request,
`src/host/authkit_client_guard.ts`.

### Pattern 1b — API routes (bearer JWT, DPoP, opaque, PAT)

```ts
// config/auth.ts
api: authkitClientGuard({
  provider: authkitIdentityProvider(),
  resolver: resolvers.jwt({ tokenSource: 'bearer' }), // Bearer <jwt> or DPoP <jwt> + DPoP proof
}),

// start/routes.ts
router.group(() => { /* … */ }).prefix('/api').use(middleware.auth({ guards: ['api'] }))
```

`resolver` replaces the configured resolver for that guard only; `resolvers.opaque({
tokenSource: 'bearer' })` and `resolvers.pat({ introspectionUrl, introspectionSecret })`
work the same way. A DPoP-bound token (`cnf.jkt`) sent as `Bearer` is refused.

### Pattern 2 — `resolveUser` per database topology

Identity always comes from the token; what varies is how the app model is fetched:

```ts
// Same DB, cross-schema FK: map to a local Lucid model
resolveUser: async (identity) => {
  return AppUser.query().where('authUserId', identity.userId).firstOrFail()
}

// Separate DBs: the IdP emits a fat ID token — claims-only, zero lookups
import { identityToUser } from '@adonis-agora/authkit-client'
resolveUser: identityToUser // { id, email, name?, avatarUrl?, globalRoles }

// Separate DBs + data beyond the claims: userinfo resolver against ${issuer}/me
import { createUserinfoResolver } from '@adonis-agora/authkit-client'
resolveUser: createUserinfoResolver({ issuer: env.get('AUTHKIT_ISSUER') })
```

Source: `packages/authkit-client/README.md` § Topologias de banco,
`src/user_resolvers.ts`.

### Pattern 3 — one-liner routes with `registerOidcClient`

Instead of hand-writing the controller trio, register PKCE + state, code exchange,
RP-initiated logout and role-based redirects in one call:

```ts
import router from '@adonisjs/core/services/router'
import { registerOidcClient } from '@adonis-agora/authkit-client'

registerOidcClient(router, {
  redirects: { byGlobalRole: { ADMIN: '/admin' }, default: '/' },
  // prefix defaults to /auth → /auth/login, /auth/callback, /auth/logout
  // backchannelLogout defaults to true → also registers POST /auth/backchannel-logout
})
```

Source: `src/register_oidc_client.ts` (`RegisterOidcClientOptions` + doc example).

### Pattern 4 — back-channel logout for cookie sessions

Pass a store and the kit derives the callback + enforcement middleware:

```ts
import { defineConfig, resolvers, lucidRevocationStore } from '@adonis-agora/authkit-client'

defineConfig({
  issuer: env.get('AUTHKIT_ISSUER'),
  clientId: env.get('AUTHKIT_CLIENT_ID'),
  redirectUri: env.get('AUTHKIT_REDIRECT_URI'),
  resolver: resolvers.jwt(),
  backchannelLogout: { store: lucidRevocationStore() },
})
```

Then apply `BackchannelRevocationMiddleware` (from
`@adonis-agora/authkit-client/backchannel_revocation_middleware`) so revoked
sessions are rejected per request. Custom needs: `onBackchannelLogout` receives the
validated `{ sid, sub }` (store runs first, then the hook).

Source: `src/define_config.ts` (`BackchannelLogoutInput`), README.

## Common mistakes

### HIGH — Session middleware running after `authkit_context_middleware`

```ts
// Wrong — resolver reads an empty session; every request looks anonymous
router.use([
  () => import('@adonis-agora/authkit-client/authkit_context_middleware'),
  () => import('@adonisjs/session/session_middleware'),
])
```

```ts
// Correct — session, then initialize_auth, then the AuthKit context middleware
router.use([
  () => import('@adonisjs/session/session_middleware'),
  () => import('@adonisjs/auth/initialize_auth_middleware'),
  () => import('@adonis-agora/authkit-client/authkit_context_middleware'),
])
```

With `resolvers.jwt({ tokenSource: 'session' })` (the default) the resolver reads
the token set from the `@adonisjs/session` store; if session middleware has not run
yet the token is never found and `getIdentity()` silently returns `null` — no error,
just a logged-out app.

Source: `packages/authkit-client/README.md` § Ordem de middleware (importante).

### HIGH — Putting app-role authorization in the client kit

```ts
// Wrong — expecting authkit to resolve app roles/permissions
if (authkit.hasGlobalRole('ADMIN')) { /* app-role check? */ }
const can = await authkit.checkPermission(user, 'posts.edit') // does not exist
```

```ts
// Correct — AuthKit authenticates + exposes token globalRoles; authz decides access
if (authkit.hasGlobalRole('ADMIN')) { /* global role from the token claims */ }
// App roles/permissions: configure resolveRoles in @adonis-agora/authz
// and enforce with authz/Bouncer route guards, not middleware.auth().
```

AuthKit only authenticates and knows the `globalRoles` claim; app roles (domain
tables) and permissions were deliberately moved out to `@adonis-agora/authz`.
`middleware.auth()` only enforces login.

Source: `packages/authkit-client/README.md` callout ("Autorização por app-role saiu
do AuthKit"), `stubs/config/authkit_client.stub` comment.

### MEDIUM — `resolvers.opaque` without a confidential client

```ts
// Wrong — public client: throws at resolver creation
resolver: resolvers.opaque({ introspectionUrl: '...' })
```

```ts
// Correct — opaque introspection requires the client secret
resolver: resolvers.opaque({
  tokenSource: 'bearer',
  cacheTtlMs: 30_000, // trade immediacy for fewer round-trips
})
```

The opaque resolver introspects with `clientId`/`clientSecret` and the factory
throws `resolvers.opaque requer um client confidencial (clientSecret)` when the
config lacks a secret — a public client cannot authenticate introspection.

With `cacheTtlMs`, a cached identity expires at the earlier of the TTL and the
token's `exp`, and the cache holds at most 10,000 tokens per resolver.

Source: `src/resolvers/factory.ts` (`resolvers.opaque` throw), README.

### MEDIUM — API routes on the session guard

```ts
// Wrong — the web guard reads the OIDC session; a Bearer header is ignored
router.group(() => { /* … */ }).prefix('/api').use(middleware.auth())
```

```ts
// Correct — an API guard with its own resolver
api: authkitClientGuard({
  provider: authkitIdentityProvider(),
  resolver: resolvers.jwt({ tokenSource: 'bearer' }),
}),
router.group(() => { /* … */ }).prefix('/api').use(middleware.auth({ guards: ['api'] }))
```

`tokenSource` decides where the token is read from: `'session'` (default, cookie
apps) vs `'bearer'` (`Authorization` header). The mismatched source yields a silent
`null` identity (a 401 / redirect), not an error.

Source: `packages/authkit-client/README.md` § Resolução de sessão,
`src/resolvers/factory.ts` (`JwtResolverFactoryConfig`).

See also: `authkit-idp-setup/SKILL.md` — the IdP side that issues these tokens, and
`authkit-react-auth/SKILL.md` — how the identity reaches the frontend.
