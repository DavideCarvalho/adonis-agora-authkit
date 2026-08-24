---
name: authkit-idp-setup
description: >-
  Set up the @adonis-agora/authkit-server OIDC/OAuth2 Authorization Server (Identity
  Provider) in an AdonisJS app. Covers `node ace add @adonis-agora/authkit-server`,
  defineConfig({ issuer, adapter, jwks, ttl, globalRolesClaim, accountStore }) with
  adapters.redis({ connection }) vs adapters.database({ connection? }),
  lucidAccountStore(AuthUser), JWKS management ({ source: 'managed' | 'jwks' } or
  'auto', keystore store file/drive/lucid/redis/hashicorp vaults plus
  @adonis-agora/authkit-vault-aws/azure/gcp createKeystoreVault add-ons),
  registerOidcRoutes(router, { mountPath?, metrics?, dashboard? }), mounting consoles
  via registerAuthHost(router, { admin, adminApi, account... }) or config.routes,
  and AUTHKIT_ISSUER / observability env. Use when booting an IdP app, wiring
  config/authkit.ts, choosing a persistence adapter, managing signing keys, or
  debugging 404s on /oidc, /account/*, /admin.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/authkit-server"
  library_version: "0.60.0"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-authkit:README.md"
  - "DavideCarvalho/adonis-authkit:packages/authkit-server/README.md"
  - "DavideCarvalho/adonis-authkit:packages/authkit-server/src/define_config.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-server/src/register_routes.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-server/stubs/config/authkit.stub"
---

# Setting up the AuthKit Authorization Server

`@adonis-agora/authkit-server` turns an AdonisJS app into an OpenID Connect /
OAuth2 Authorization Server (IdP) on top of `oidc-provider`. Setup has three
independent pieces that all must exist before anything works: **config**
(`config/authkit.ts` via `defineConfig`), **OIDC routes** (`registerOidcRoutes`),
and the host routes/consoles (`registerAuthHost` or `config.routes`). The login
screens are a separate concern — see `authkit-interactions`.

## Setup

Install and run the configurator:

```bash
node ace add @adonis-agora/authkit-server
```

`configure` publishes `config/authkit.ts`, the model `app/models/auth_user.ts`, the
interaction controller stub and registers the provider. Then wire the routes:

```ts
// start/routes.ts
import router from '@adonisjs/core/services/router'
import { registerOidcRoutes } from '@adonis-agora/authkit-server'

registerOidcRoutes(router) // mounts the oidc-provider catch-all at /oidc
```

Point `AUTHKIT_ISSUER` at `<host>/oidc` — the issuer must end with the mount path.

Source: `packages/authkit-server/README.md`, `src/register_routes.ts`.

## Core patterns

### Pattern 1 — `defineConfig`: issuer, adapter, accountStore

```ts
// config/authkit.ts
import env from '#start/env'
import AuthUser from '#models/auth_user'
import { defineConfig, adapters, lucidAccountStore } from '@adonis-agora/authkit-server'

const authServerConfig = defineConfig({
  issuer: env.get('AUTHKIT_ISSUER'),
  adapter: adapters.redis({ connection: 'main' }), // or adapters.database()
  jwks: { source: 'managed', algorithm: 'RS256' },
  ttl: { accessToken: '15m', refreshToken: '30d' },
  globalRolesClaim: 'roles',
  accountStore: lucidAccountStore(AuthUser),
})

export default authServerConfig
```

`adapter` is where oidc-provider persists grants/tokens/codes: `adapters.redis({
connection })` requires `@adonisjs/redis` configured; `adapters.database({
connection? })` uses Lucid and requires running the `authkit_oidc_payloads`
migration. `accountStore` is the identity contract — `lucidAccountStore(AuthUser)`
derives `findAccount`/`verifyCredentials` from your user model.

Source: `stubs/config/authkit.stub`, `src/define_config.ts` (`AuthServerConfigInput`),
`src/adapters/factory.ts`, README § Persistência.

### Pattern 2 — signing keys: managed JWKS, `'auto'`, and inline keys

```ts
defineConfig({
  issuer: env.get('AUTHKIT_ISSUER'),
  adapter: adapters.redis({ connection: 'main' }),
  // Ephemeral-friendly: AUTHKIT_JWKS inline JSON wins, else file-managed keystore.
  jwks: 'auto',
  accountStore: lucidAccountStore(AuthUser),
})
```

Explicit forms: `{ source: 'managed' }` generates/rotates/persists the private
keystore (`rotationDays`, `algorithm`, `encrypt`, and `store` choosing where the
blob lives); `{ source: 'jwks', keys }` supplies keys inline.

The managed keystore's `store` accepts a path shortcut (`store: 'tmp/keystore.json'`)
or `{ driver: ... }`: built-in vaults are `file`, `drive` (a `@adonisjs/drive` disk),
`lucid` (table created on first write), `redis`, and `hashicorp`; for cloud secret
managers install the add-ons `@adonis-agora/authkit-vault-aws` / `-azure` / `-gcp`
and pass their `createKeystoreVault(...)` result as `store` (any object with a
`read()` method is accepted). With no `store` at all, keys are ephemeral per boot.

Rotation tooling ships as `node ace authkit:rotate-keys`; health checks via
`node ace authkit:doctor`.

Source: `src/keys/keystore_manager.ts` (`resolveKeystoreVault`),
`packages/authkit-core/src/types/server_config.ts` (`JwksConfig`), index.ts exports.

### Pattern 3 — mounting consoles with `registerAuthHost` (or `config.routes`)

```ts
// start/routes.ts
import router from '@adonisjs/core/services/router'
import { registerOidcRoutes, registerAuthHost } from '@adonis-agora/authkit-server'

registerOidcRoutes(router)
const authkitRoutes = registerAuthHost(router, {
  mountPath: '/oidc',
  admin: true,    // admin console under /admin
  adminApi: true, // Admin REST API under /api/authkit/v1
})
// Hand authkitRoutes to your frontend instead of hardcoding hrefs.
router.get('/', async ({ inertia }) => inertia.render('home', { authkitRoutes }))
```

Alternatively set `routes: true` in `config/authkit.ts` to auto-mount in the
provider's `boot()` (before `start/routes.ts`) — then do NOT also call
`registerAuthHost` manually (double registration crashes the boot). Policy flags
(`admin`, `adminApi`, `social`, `rateLimit`) declared in `defineConfig` LOCK the
on/off switch: `registerAuthHost` may only adjust structural prefixes.

Observability routes are opt-in on the OIDC mount itself:
`registerOidcRoutes(router, { metrics: true, dashboard: true })` mounts
`GET /authkit/metrics` (JSON snapshot) and `GET /authkit/dashboard` (embedded HTML).

Source: `src/host/register_auth_host.ts` (`AuthHostOptions`, policy-vs-structural),
`src/define_config.ts` (`routes`, `admin`, `adminApi` JSDoc), server README
§ Observabilidade.

## Common mistakes

### CRITICAL — Issuer not ending with the mount path

```ts
// Wrong — issuer says /oauth but routes mount at default /oidc
defineConfig({ issuer: 'https://idp.example.com/oauth' })
registerOidcRoutes(router) // mounts /oidc/*
```

```ts
// Correct — issuer ends exactly at the mount path
defineConfig({ issuer: 'https://idp.example.com/oidc' })
registerOidcRoutes(router) // default mountPath '/oidc' matches the issuer
```

oidc-provider routes internally UNDER the issuer URL, so a trailing mismatch makes
discovery and every protocol endpoint unreachable while the app otherwise boots fine.

Source: `packages/authkit-server/README.md` § Montar as rotas OIDC;
`src/host/register_auth_host.ts` (`mountPath` doc: "Deve casar com o final do issuer").

### HIGH — Consoles/account screens 404 because no host routes were mounted

```ts
// Wrong — only the protocol endpoints exist; /account/* and /admin are dead
registerOidcRoutes(router)
```

```ts
// Correct — mount the host surface too (or set config.routes: true)
registerOidcRoutes(router)
registerAuthHost(router, { mountPath: '/oidc', admin: true })
```

`registerOidcRoutes` only registers the oidc-provider catch-all; everything else
(account console `/account/*`, admin console, Admin API, sudo routes) exists solely
after `registerAuthHost` runs or `config.routes` auto-mounts them. Conversely,
calling `registerAuthHost` while `config.routes: true` double-registers named routes
and throws at boot — pick one.

Source: `src/define_config.ts` (`routes` JSDoc: "duplo registro ... derrubam o boot"),
`src/register_routes.ts`.

### HIGH — `jwks: 'auto'` in production without AUTHKIT_JWKS

```ts
// Wrong — prod deploy with no AUTHKIT_JWKS env: falls back to a file keystore in tmp/
jwks: 'auto'
```

```ts
// Correct — explicit managed keystore persisted in a durable vault for prod
jwks: {
  source: 'managed',
  algorithm: 'RS256',
  store: { driver: 'lucid' }, // or redis/drive/hashicorp/vault add-on
}
```

`'auto'` prefers the `AUTHKIT_JWKS` env JSON but silently degrades to
`tmp/authkit_jwks.json` on disk — on ephemeral filesystems every restart mints new
signing keys and every issued token fails validation after redeploy.

Source: `src/define_config.ts` (`jwks` JSDoc: "'auto' (recomendado p/ deploys
efêmeros)... senão cai no managed persistido em arquivo"),
`packages/authkit-core/src/types/server_config.ts`.

See also: `authkit-interactions/SKILL.md` — after setup, the authorization flow ends
at the interaction screens, which the host must register and render itself.
