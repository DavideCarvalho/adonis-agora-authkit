---
name: authkit-rp-client
description: >-
  Integrate an AdonisJS app as an OpenID Connect relying party with
  @adonis-agora/authkit-client. Covers defineConfig({ issuer, clientId, redirectUri,
  resolver }), resolvers.jwt({ tokenSource }) / resolvers.pat / resolvers.opaque,
  resolveUser topologies (identityToUser, createUserinfoResolver, local Lucid model),
  the authkit_middleware + @adonisjs/session ordering rule, ctx.auth
  (getIdentity/getUser/hasGlobalRole), registerOidcClient(router, { prefix, redirects,
  afterLogin, loginMiddleware }), backchannelLogout: { store } +
  BackchannelRevocationMiddleware, AUTHKIT_REDIRECT_URI, and why app-role gating
  belongs to @adonis-agora/authz instead. Use when wiring a client app to the IdP,
  fixing null identity, choosing a user-resolution topology, or adding back-channel
  logout.
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
locally-validated ID tokens (JWKS), typed `ctx.auth` per request. `configure`
publishes `config/authkit_client.ts`, `OidcSessionController` (login/callback/logout)
and registers the provider + middleware.

## Setup

```bash
node ace add @adonis-agora/authkit-client
```

```ts
// config/authkit_client.ts
import env from '#start/env'
import { defineConfig, resolvers } from '@adonis-agora/authkit-client'

const authkitClientConfig = defineConfig({
  issuer: env.get('AUTHKIT_ISSUER'),
  clientId: env.get('AUTHKIT_CLIENT_ID'),
  clientSecret: env.get('AUTHKIT_CLIENT_SECRET'),
  redirectUri: env.get('AUTHKIT_REDIRECT_URI'), // must point at the callback route
  resolver: resolvers.jwt({ tokenSource: 'session' }),
})

export default authkitClientConfig
```

```ts
// start/routes.ts
import router from '@adonisjs/core/services/router'
import OidcSessionController from '#controllers/oidc_session_controller'

router.get('/auth/login', [OidcSessionController, 'login'])
router.get('/auth/callback', [OidcSessionController, 'callback'])
router.post('/auth/logout', [OidcSessionController, 'logout'])
```

Source: `packages/authkit-client/README.md`, `stubs/config/authkit_client.stub`.

## Core patterns

### Pattern 1 — `ctx.auth` per request

The `authkit_middleware` populates `ctx.auth`; identity comes from the validated
token, the user from your `resolveUser`:

```ts
router.get('/me', async ({ auth }) => {
  const identity = await auth.getIdentity() // validated OIDC claims, or null
  const user = await auth.getUser()         // app model via resolveUser
  const isAdmin = auth.hasGlobalRole('ADMIN') // sync — reads token claims
  return { identity, user, isAdmin }
})
```

`getIdentity()` resolves once per request and memoizes; `authenticate()` throws when
anonymous; `check()` returns a boolean. `identity` (getter) is only populated after
the first async call — prefer `getIdentity()`.

Source: `packages/authkit-client/README.md` § Uso por request,
`src/authenticator.ts` (`Authenticator`).

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
import middleware from '#start/kernel'
import { registerOidcClient } from '@adonis-agora/authkit-client'

registerOidcClient(router, {
  loginMiddleware: middleware.guest(),
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

### HIGH — Session middleware running after `authkit_middleware`

```ts
// Wrong — resolver reads an empty session; every request looks anonymous
router.use([middleware.authkit(), middleware.session()])
```

```ts
// Correct — @adonisjs/session MUST run BEFORE the authkit middleware
router.use([middleware.session(), middleware.authkit()])
```

With `resolvers.jwt({ tokenSource: 'session' })` (the default) the resolver reads
the token set from the `@adonisjs/session` store; if session middleware has not run
yet the token is never found and `getIdentity()` silently returns `null` — no error,
just a logged-out app.

Source: `packages/authkit-client/README.md` § Ordem de middleware (importante).

### HIGH — Putting app-role authorization in the client kit

```ts
// Wrong — expecting authkit to resolve app roles/permissions
if (auth.hasGlobalRole('ADMIN')) { /* app-role check? */ }
const can = await authkit.checkPermission(user, 'posts.edit') // does not exist
```

```ts
// Correct — AuthKit authenticates + exposes token globalRoles; authz decides access
if (auth.hasGlobalRole('ADMIN')) { /* global role from the token claims */ }
// App roles/permissions: configure resolveRoles in @adonis-agora/authz
// and enforce with authz/Bouncer route guards, not authkit_middleware.
```

AuthKit only authenticates and knows the `globalRoles` claim; app roles (domain
tables) and permissions were deliberately moved out to `@adonis-agora/authz`.
The `authkit_middleware` only enforces login.

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

Source: `src/resolvers/factory.ts` (`resolvers.opaque` throw), README.

### MEDIUM — Bearer resolver in a browser session app (or vice versa)

```ts
// Wrong — SPA/API app still using the default session source
resolver: resolvers.jwt() // tokenSource defaults to 'session'
```

```ts
// Correct — pick the source matching the transport
resolver: resolvers.jwt({ tokenSource: 'bearer' }) // reads Authorization header
```

`tokenSource` decides where the ID token is read from: `'session'` (default, cookie
apps) vs `'bearer'` (`Authorization` header for SPA/API callers). The mismatched
source yields a silent `null` identity, not an error.

Source: `packages/authkit-client/README.md` § Resolução de sessão,
`src/resolvers/factory.ts` (`JwtResolverFactoryConfig`).

See also: `authkit-idp-setup/SKILL.md` — the IdP side that issues these tokens, and
`authkit-react-auth/SKILL.md` — how the identity reaches the frontend.
