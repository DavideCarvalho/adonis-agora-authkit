---
name: authkit-interactions
description: >-
  Implement the host-owned login/consent interaction screens of @adonis-agora/authkit-server.
  Covers oidc-provider's interactions.url redirect to /auth/interaction/:uid, the three
  routes every IdP app must register (show/login/consent on AuthInteractionController),
  `node ace configure --ui=edge|react|headless` presets, the shell-controller +
  service.interactions split (details(ctx), login(ctx,{email,password}), consent(ctx)),
  overriding verifyCredentials in config/authkit.ts, renderers edgeRenderer/inertiaRenderer,
  and end-to-end testing with @adonis-agora/authkit-testing (createTestIdentity,
  mintTestIdToken, serveJwks, fakeAuthenticator). Use when the authorization flow 404s at
  the login screen, wiring custom login UI, plugging an external user base, or testing
  OIDC flows without booting an IdP.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/authkit-server"
  library_version: "0.60.0"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-authkit:packages/authkit-server/README.md"
  - "DavideCarvalho/adonis-authkit:packages/authkit-server/src/host/renderers/inertia_renderer.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-server/src/define_config.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-testing/README.md"
---

# Login & consent screens (interactions)

When `oidc-provider` meets an unauthenticated user it redirects to
`interactions.url` (`/auth/interaction/:uid`). Those screens are **yours** — the kit
ejects a controller shell via `node ace configure` and you register the routes that
point at it. Without them the authorization code flow dies with a 404 exactly when
the user should log in.

## Setup

Pick a UI preset when configuring (asks interactively if omitted):

```bash
node ace configure @adonis-agora/authkit-server --ui=edge
# values: edge | react | headless
```

Each preset publishes `app/controllers/auth_interaction_controller.ts`; `edge` adds
Edge views, `react` adds Inertia pages (validating that `@adonisjs/inertia` + Vite +
React exist first), `headless` returns JSON only. Register the three routes:

```ts
// start/routes.ts
import router from '@adonisjs/core/services/router'
import AuthInteractionController from '#controllers/auth_interaction_controller'

router.get('/auth/interaction/:uid', [AuthInteractionController, 'show'])
router.post('/auth/interaction/:uid/login', [AuthInteractionController, 'login'])
router.post('/auth/interaction/:uid/consent', [AuthInteractionController, 'consent'])
```

Source: `packages/authkit-server/README.md` § Rotas de interaction.

## Core patterns

### Pattern 1 — edit the shell, keep logic in `service.interactions`

In all presets the ejected controller is a thin shell: the logic lives in
`service.interactions`, resolved via `containerResolver.make('authkit.server')`.
It exposes `details(ctx)` (the prompt + params), `login(ctx, { email, password })`
and `consent(ctx)`. You only edit the render/redirect parts:

```ts
// headless preset flavor — show() returns JSON, you build your own front
async show({ request, response }) {
  const service = await this.ctx.containerResolver.make('authkit.server')
  const details = await service.interactions.details(this.ctx)
  return response.json({ uid: request.param('uid'), prompt: details.prompt, params: details.params })
}
```

Keep validation, MFA prompts and grant bookkeeping inside `service.interactions`;
the shell only translates between HTTP and those calls.

Source: `packages/authkit-server/README.md` § UI de login/consent ("o controller
ejetado é casca: a lógica vive em `service.interactions`").

### Pattern 2 — plug your user base via `verifyCredentials`

`verifyCredentials` in `config/authkit.ts` decides whether credentials are valid;
`service.interactions.login` calls it. The default queries the `AuthUser` model by
email and uses `verifyPassword` — override to authenticate against anything else:

```ts
// config/authkit.ts
defineConfig({
  issuer: env.get('AUTHKIT_ISSUER'),
  adapter: adapters.redis({ connection: 'main' }),
  accountStore: lucidAccountStore(AuthUser),
  verifyCredentials: async (email, password) => {
    // Return the account on success; throw/falsy paths fail the login.
    const account = await AuthUser.query().where('email', email).first()
    if (!account) throw new Error('Invalid credentials')
    await verifyPassword(account.passwordHash, password)
    return account
  },
})
```

Whatever it returns must be the same identity surface the configured
`accountStore` serves, or downstream `findAccount` lookups diverge from what just
logged in.

Source: `packages/authkit-server/README.md` § UI de login/consent (verifyCredentials),
`src/define_config.ts` (`accountStore` derives findAccount/verifyCredentials).

### Pattern 3 — custom rendering with `inertiaRenderer`

Hosts building their own React screens set the `render` option instead of relying
on the default Edge renderer:

```ts
import { defineConfig, inertiaRenderer } from '@adonis-agora/authkit-server'

defineConfig({
  issuer: env.get('AUTHKIT_ISSUER'),
  adapter: adapters.database(),
  accountStore: lucidAccountStore(AuthUser),
  render: inertiaRenderer(), // renders Inertia pages for /account/* and /auth/interaction/*
})
```

Without any renderer, every `/account/*` and `/auth/interaction/*` request fails
with an unexplained 500 (`render` is undefined).

Source: `src/define_config.ts` (`render` JSDoc), `index.ts` exports
(`inertiaRenderer`, `edgeRenderer`).

### Pattern 4 — test flows without booting an IdP

`@adonis-agora/authkit-testing` mints real signed ID tokens validated by a local
JWKS, and fakes the authenticator for controller tests:

```ts
import { mintTestIdToken, serveJwks, fakeAuthenticator } from '@adonis-agora/authkit-testing'
import { resolvers } from '@adonis-agora/authkit-client'

const { token, jwks } = await mintTestIdToken({
  issuer: 'https://idp.test',
  clientId: 'my-app',
  claims: { sub: 'user-42', email: 'jane@test.dev', roles: ['ADMIN'] },
})

const served = await serveJwks(jwks)
const factory = resolvers.jwt({ jwksUri: served.jwksUri })
const resolver = await factory.resolver({
  issuer: 'https://idp.test',
  clientId: 'my-app',
  sessionKey: 'authkit',
  globalRolesClaim: 'roles',
})
const ctx = { auth: fakeAuthenticator({ identity: null }) } // anonymous request fake
await served.close()
```

Also available: `createTestIdentity(overrides?)` for valid `Identity` defaults,
`fakeAccountStore({ withMfa: true, ... })` for capability-probed store fakes.

Source: `packages/authkit-testing/README.md`.

## Common mistakes

### CRITICAL — Forgetting to register the interaction routes

```ts
// Wrong — only the protocol endpoints exist
registerOidcRoutes(router)
// no GET /auth/interaction/:uid anywhere
```

```ts
// Correct — the three host-owned routes are registered next to the OIDC mount
registerOidcRoutes(router)
router.get('/auth/interaction/:uid', [AuthInteractionController, 'show'])
router.post('/auth/interaction/:uid/login', [AuthInteractionController, 'login'])
router.post('/auth/interaction/:uid/consent', [AuthInteractionController, 'consent'])
```

Nothing crashes at boot; the failure surfaces mid-flow — the user's browser lands
on `/auth/interaction/:uid` and gets a 404, so no client can ever complete login.

Source: `packages/authkit-server/README.md` § Rotas de interaction ("Sem essas rotas
o fluxo de autorização cai num 404 ao chegar na tela de login").

### HIGH — Writing login/consent logic inside the ejected controller shell

```ts
// Wrong — reimplementing prompt handling/grants in the ejected shell
async consent(ctx) {
  // hand-rolling grant persistence against oidc-provider internals...
}
```

```ts
// Correct — shell delegates; the service owns the flow
async consent(ctx) {
  const service = await ctx.containerResolver.make('authkit.server')
  await service.interactions.consent(ctx) // handles the grant, returns the redirect
}
```

The shell is regenerated by `configure` and has no access to the provider's
interaction plumbing; duplicating logic there silently drifts from prompt/consent
semantics the provider expects.

Source: `packages/authkit-server/README.md` § UI de login/consent ("Você edita só a
parte de render/redirect").

### MEDIUM — Choosing `--ui=react` without the Inertia stack installed

```bash
# Wrong — react preset in a bare API-only AdonisJS app
node ace configure @adonis-agora/authkit-server --ui=react
```

```bash
# Correct — match the preset to the app stack
node ace configure @adonis-agora/authkit-server --ui=edge   # server-rendered views
node ace configure @adonis-agora/authkit-server --ui=headless # build your own front
```

The `react` preset requires `@adonisjs/inertia` + Vite + React in the host app —
`configure` validates the stack before publishing, so the command aborts instead of
half-configuring your app.

Source: `packages/authkit-server/README.md` § UI de login/consent ("Exige
@adonisjs/inertia + Vite + React no app — o configure valida essa stack").

See also: `authkit-rp-client/SKILL.md` — the consuming side that ends up holding
the session these screens create.
