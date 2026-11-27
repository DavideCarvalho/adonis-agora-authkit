---
name: authkit-poppy
description: >-
  Serve the Personal Agent Protocol ("Poppy" 1.0) from an AdonisJS IdP with
  @adonis-agora/authkit-poppy. Covers `node ace add` (no provider, no env: the
  configure hook only prints POPPY_CONFIG_SNIPPET), the poppy() extension under
  `personalAgents.extensions` of authkit-server's defineConfig (organization,
  scopes/scopeHints, signIn direct/device/mediated, poppyEmailCodeSignIn, agent,
  apis, prefix, replay, rateLimit, dpop, allowInsecureClientIds), the lib-owned
  auth_poppy_* tables (ensurePoppySchema), and protecting your own routes with
  poppyAuth()/poppyOf()/verifyPoppyRequest(). Use when making an app reachable by
  personal AI agents, wiring Poppy sign-in, guarding an API with the Poppy-Session
  header, or debugging invalid_session / replay / boot errors from poppy().
license: MIT
metadata:
  type: core
  library: "@adonis-agora/authkit-poppy"
  library_version: "1.0.0"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-authkit:packages/authkit-poppy/README.md"
  - "DavideCarvalho/adonis-authkit:packages/authkit-poppy/configure.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-poppy/src/config.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-poppy/src/extension.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-poppy/src/resource.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-poppy/src/replay.ts"
  - "DavideCarvalho/adonis-authkit:apps/docs/content/docs/personal-agents-poppy.mdx"
---

# Personal agents with Poppy

`@adonis-agora/authkit-poppy` plugs the Personal Agent Protocol into
`@adonis-agora/authkit-server` as a `personalAgents.extensions` entry. A personal
agent identifies itself by an HTTPS `client_id`, sends a per-request signed
`Poppy-Session` JWT (signed-out), and gets account access through plain OAuth
served under `/poppy` (Direct = code + PKCE, Device = RFC 8628, Mediated = opt-in
extension grant). The package version follows the spec: `1.x` implements Poppy `1.x`.

## Setup

```sh
node ace add @adonis-agora/authkit-server   # prerequisite
node ace add @adonis-agora/authkit-poppy
```

The configure hook has no provider and writes no env: it refuses to run without
`@adonis-agora/authkit-server`, then only **prints** `POPPY_CONFIG_SNIPPET`. You add
the extension to `config/authkit.ts` yourself:

```ts no-check
// config/authkit.ts
import { defineConfig } from '@adonis-agora/authkit-server'
import { poppy } from '@adonis-agora/authkit-poppy'

export default defineConfig({
  // ...issuer, adapter, jwks, accountStore
  personalAgents: {
    // PACT's `audience` is optional: omit it for a Poppy-only app.
    extensions: [
      poppy({
        organization: { name: 'Acme', domain: 'acme.com' }, // host only, no scheme
        scopes: { 'orders:read': 'See your orders', 'orders:write': 'Exchange items' },
      }),
    ],
  },
})
```

Tables `auth_poppy_*` (sessions, tokens, requests, delegated keys, jtis,
operations, …) are created at boot with AuthKit's own when `schema.autoManage` is
on. If you manage the schema in migrations, add `ensurePoppySchema` next to
`ensureAuthkitSchema` (pass the same `{ schema }` when `schema.name` is set):

```ts no-check
// database/migrations/xxxx_authkit_schema.ts
import { BaseSchema } from '@adonisjs/lucid/schema'
import { ensureAuthkitSchema } from '@adonis-agora/authkit-server'
import { ensurePoppySchema } from '@adonis-agora/authkit-poppy'

export default class extends BaseSchema {
  async up() {
    await ensureAuthkitSchema(this.db)
    await ensurePoppySchema(this.db)
  }
}
```

Source: `configure.ts` (`POPPY_CONFIG_SNIPPET`, `configure`), `src/tables.ts`,
docs `personal-agents-poppy.mdx` § Enabling it.

## Core patterns

### Pattern 1 — the `poppy()` options that matter

```ts
import { poppy, poppyEmailCodeSignIn } from '@adonis-agora/authkit-poppy'

export const poppyExtension = poppy({
  organization: { name: 'Acme', domain: 'acme.com', aliases: ['acme.co.uk'] },
  prefix: '/poppy', // default; also the issuer path. Not under the OIDC mountPath.
  scopes: { 'orders:read': 'See your orders', 'orders:write': 'Exchange items' },
  scopeHints: {
    'orders:read': { changes: 'none', personal_data: true },
    'orders:write': { changes: 'irreversible', personal_data: true },
  },
  signIn: {
    direct: true, // default on
    device: { scopes: ['orders:read'] }, // default on; `{ scopes }` restricts it
    // Off unless configured. Ready-made: email + 6-digit code, no account enumeration.
    mediated: poppyEmailCodeSignIn({ scopes: ['orders:read'] }),
  },
  apis: [{ type: 'openapi', url: 'https://api.acme.com/openapi.json', description: 'Orders' }],
  replay: { redis: 'main' }, // default 'database'
})
```

- `scopes` is required unless both `signIn.direct` and `signIn.device` are `false`
  (it defaults to `personalAgents.delegation.scopes` when PACT declares them).
- `signIn.<type>.scopes` must reference declared scope ids; `scopeHints.<id>`
  needs `changes` (`none|reversible|irreversible`) and boolean `personal_data`.
- `agent.protocols[]` / `apis[]` entries require `type` and `description`.
- All of these are validated in `poppy()` → `resolvePoppyConfig` and throw
  `authkit-poppy: poppy().…` at boot.

Source: `src/config.ts` (`PoppyConfigInput`, `resolvePoppyConfig` `fail(...)` calls).

### Pattern 2 — protect your routes with `poppyAuth()` / `poppyOf()`

```ts
import router from '@adonisjs/core/services/router'
import { poppyAuth, poppyOf } from '@adonis-agora/authkit-poppy'

router
  .get('/orders', async (ctx) => {
    const principal = poppyOf(ctx)! // set by poppyAuth on success
    return { accountId: principal.accountId, scopes: principal.scopes }
  })
  .use(poppyAuth({ scopes: ['orders:read'] }))
```

`poppyAuth(options)` verifies the `Poppy-Session` JWT and its delegation, the
`Poppy-Version`, the `jti` (replay), and — when an access token is present — its
client, DPoP binding, `resource` and scopes. On failure it writes the protocol
error itself (`invalid_session`/`session_ended`/`version_unsupported` as 400 JSON,
401/403 with `WWW-Authenticate`, 429 with `Retry-After`). Options: `scopes` (all
required), `signedIn`, `resource`, `extension`. Outside a route middleware use
`verifyPoppyRequest(ctx | { method, url, headers }, options)` and handle the
`{ ok: false }` result with `writePoppyAuthError(ctx, result)`.

Source: `src/resource.ts` (`poppyAuth`, `poppyOf`), `src/service.ts`
(`PoppyVerifyOptions`).

### Pattern 3 — rendering the consent screens

Direct and Device approval render through your `config.render` as `agents/consent`
and `agents/done`. With `inertiaRenderer`, list them in `views` or they fall back
to the built-in Edge screens:

```ts no-check
render: inertiaRenderer({ prefix: 'authkit', views: ['login', 'agents/consent', 'agents/done'] })
```

Source: docs `personal-agents-poppy.mdx` § Theming the consent screens.

## Common mistakes

### HIGH — `replay: 'memory'` with more than one instance

```ts no-check
// Wrong — each process keeps its own jti set; a captured Session JWT or client
// assertion replays against a different instance
poppy({ organization, scopes, replay: 'memory' })
```

```ts no-check
// Correct — shared store: the default lib-owned table, or Redis
poppy({ organization, scopes }) // replay: 'database' (auth_poppy_jtis)
poppy({ organization, scopes, replay: { redis: 'main' } })
```

Every verified request claims a `jti` (Session JWTs included), so the store sees
one write per request: Redis is the cheaper choice under load. `memoryReplayStore`
is documented "only works with one instance". The default `rateLimit` is also
in-memory per process; pass your own `PoppyLimiter` for a fleet-wide limit.

Source: `src/replay.ts` (`memoryReplayStore`, `databaseReplayStore`,
`redisReplayStore`), `src/config.ts` (`replay`, `rateLimit` JSDoc).

### HIGH — Forgetting CSRF exemption for your own Poppy-guarded routes

```ts no-check
// Wrong — POST /orders/:id/exchanges is guarded by poppyAuth but still behind
// shield's CSRF check: every agent POST fails before poppyAuth runs
csrf: { enabled: true, exceptRoutes: (ctx) => authkitCsrfExceptions(ctx.request.url()) }
```

```ts no-check
// Correct — authkitCsrfExceptions only covers AuthKit's own agent endpoints
// (/poppy/oauth/*, /poppy/browser-session*, /poppy/feedback, /poppy/operations);
// exempt your agent-facing API paths too
csrf: {
  enabled: true,
  exceptRoutes: (ctx) =>
    authkitCsrfExceptions(ctx.request.url()) || ctx.request.url().startsWith('/orders'),
}
```

Agents call with no browser and no CSRF token. The extension registers
`csrfExemptPaths` for its own routes only; `poppyAuth`'s JSDoc tells you to exempt
the routes you guard with it.

Source: `src/extension.ts` (`csrfExemptPaths`), `src/resource.ts` (`poppyAuth`
JSDoc), `packages/authkit-server/src/host/csrf.ts`.

### HIGH — Mediated Sign-In that asks for a password or leaks account existence

```ts no-check
// Wrong — the agent relays what the user types: never collect a password, and
// answering `failed` for an unknown email enumerates accounts
mediated: {
  fields: [{ name: 'password', label: 'Password', secret: true }],
  scopes: ['orders:read'],
  async verify() { return { status: 'failed' } },
}
```

```ts no-check
// Correct — ready-made email + one-time code; unknown/ineligible emails get the
// same `code_required` answer without a code being sent
mediated: poppyEmailCodeSignIn({ scopes: ['orders:read'] })
```

If you write your own `verify`, return `{ status: 'code_required', accountId: null,
sentTo }` for an unknown identifier. Mediated is transitional in the spec; offer it
only until Direct/Device cover the same scopes. `agora:dev` cannot be in
`signIn.mediated.scopes` (boot fails).

Source: `src/email_code_sign_in.ts`, `src/config.ts` (`PoppyMediatedResult`),
docs § Mediated Sign-In without account enumeration.

### MEDIUM — Leaving `allowInsecureClientIds` on, or putting a scheme in `domain`

```ts no-check
// Wrong
poppy({ organization: { name: 'Acme', domain: 'https://acme.com' }, allowInsecureClientIds: true })
```

```ts no-check
// Correct — host only; insecure client ids only in dev/test
poppy({
  organization: { name: 'Acme', domain: 'acme.com' },
  allowInsecureClientIds: process.env.NODE_ENV !== 'production',
})
```

`domain` must be a bare host (`poppy.json` is only served on it and its aliases;
`www.` redirects). `allowInsecureClientIds: true` accepts `http://` client ids and
skips the SSRF guard; `poppy()` throws at boot when `NODE_ENV=production`.

Source: `src/config.ts` (`organization` validation, `allowInsecureClientIds`).

### MEDIUM — Still configuring `personalAgents.poppy` (authkit-server 0.x)

```ts no-check
// Wrong — the 0.x shape; ignored by 1.x
personalAgents: { poppy: { organization, scopes } }
```

```ts no-check
// Correct — same options, as an extension
personalAgents: { extensions: [poppy({ organization, scopes })] }
```

`node ace configure @adonis-agora/authkit-poppy` warns when it detects the old key.

Source: `configure.ts`.

See also: `authkit-idp-setup` (in `@adonis-agora/authkit-server`) for the base
`defineConfig` and CSRF wiring Poppy builds on; `authkit-interactions` for
`inertiaRenderer` views.
