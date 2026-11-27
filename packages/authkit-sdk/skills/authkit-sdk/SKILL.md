---
name: authkit-sdk
description: >-
  Manage an AuthKit IdP from server-side code with @adonis-agora/authkit-sdk.
  Covers createAuthkit({ mode: 'remote' | 'embedded' }) and the direct factories
  createRemoteAuthkit / createEmbeddedAuthkit, the remote driver's baseUrl / apiKey /
  apiPrefix / fetchImpl options, enabling the server's Admin REST API
  (adminApi: { apiKeys: 'env' } + AUTHKIT_ADMIN_API_KEY, registerAuthHost adminApi
  prefix), the shared Authkit interface (users, sessions, clients, organizations,
  audit cursor paging, settings, keys.status/rotate, tokens.verify, stats), and error
  handling (AuthkitApiError from remote vs plain Error from embedded). Use when a
  backend needs to create/disable users, provision OIDC clients, rotate signing keys
  or introspect tokens programmatically, or when SDK calls 404/401 against the IdP.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/authkit-sdk"
  library_version: "1.0.1"
  framework: adonisjs
sources:
  - "DavideCarvalho/adonis-authkit:packages/authkit-sdk/README.md"
  - "DavideCarvalho/adonis-authkit:packages/authkit-sdk/src/factory.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-sdk/src/remote_driver.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-sdk/src/embedded_driver.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-sdk/src/types.ts"
  - "DavideCarvalho/adonis-authkit:apps/docs/content/docs/sdk.mdx"
---

# Backend SDK (Admin API)

`@adonis-agora/authkit-sdk` exposes one typed `Authkit` interface over the IdP's
admin surface, with two interchangeable drivers that return identical shapes:

- **`remote`** — `fetch` against the Admin REST API (`/api/authkit/v1` by default),
  authenticated with `Authorization: Bearer <apiKey>`. Use from any other service.
- **`embedded`** — resolves `authkit.server` from the AdonisJS container and calls the
  same services the Admin API controllers use. Use when the IdP runs in the **same**
  app: no HTTP hop, no API key, works even with the Admin REST API disabled.

## Setup

```bash
pnpm add @adonis-agora/authkit-sdk
```

`@adonis-agora/authkit-server` and `@adonisjs/core` are optional peers — only the
embedded driver needs them (the server kit is imported lazily).

Remote (separate service):

```ts
import { createAuthkit } from '@adonis-agora/authkit-sdk'

const authkit = await createAuthkit({
  mode: 'remote',
  baseUrl: 'https://idp.example.com', // host root; the API prefix is appended
  apiKey: process.env.AUTHKIT_ADMIN_API_KEY!,
  // apiPrefix: '/api/authkit/v1', // default; must match the server's adminApi prefix
})
```

Embedded (same app as the IdP):

```ts
import app from '@adonisjs/core/services/app'
import { createAuthkit } from '@adonis-agora/authkit-sdk'

const authkit = await createAuthkit({ mode: 'embedded', app })
```

For remote mode, the IdP must expose the Admin REST API. It is off by default and
turns on automatically once at least one API key resolves:

```ts no-check
// IdP: config/authkit.ts — reads AUTHKIT_ADMIN_API_KEY (comma-separated for several keys)
defineConfig({
  // ...
  adminApi: { apiKeys: 'env' },
})
```

Source: `src/factory.ts`, `src/remote_driver.ts` (`RemoteOptions`),
`packages/authkit-server/src/define_config.ts` (`AdminApiConfigInput`, `resolveAdminApi`).

## Core patterns

### Pattern 1 — pick the factory by who decides the topology

`createAuthkit` is only a dispatcher and **always** returns a `Promise<Authkit>`. When
the driver is fixed, call the driver factory directly: `createRemoteAuthkit` is
synchronous (a plain value, no top-level await), `createEmbeddedAuthkit` is async.

```ts
import { createRemoteAuthkit } from '@adonis-agora/authkit-sdk'

export const authkit = createRemoteAuthkit({
  baseUrl: process.env.AUTHKIT_URL!,
  apiKey: process.env.AUTHKIT_ADMIN_API_KEY!,
})
```

Use `createAuthkit({ mode })` when the mode is a deployment setting (same code runs
next to the IdP in one environment and across the network in another).

Source: `src/factory.ts`, `index.ts`.

### Pattern 2 — provisioning users, clients and organizations

```ts
import type { Authkit } from '@adonis-agora/authkit-sdk'

export async function onboard(authkit: Authkit, email: string) {
  // invite: true with no password → random password + invite/reset e-mail
  const user = await authkit.users.create({ email, invite: true })
  await authkit.users.update(user.id, { globalRoles: ['ADMIN'] })

  const org = await authkit.organizations.create({
    name: 'Acme',
    slug: 'acme',
    ownerAccountId: user.id,
  })

  const client = await authkit.clients.create({
    redirectUris: ['https://app.acme.com/auth/callback'],
    grantTypes: ['authorization_code', 'refresh_token'],
  })
  // clientSecret is returned in clear text ONLY here (and on regenerateSecret)
  return { user, org, clientId: client.clientId, clientSecret: client.clientSecret }
}
```

`users`, `clients` and `organizations` list by page (`page` 1-based, `size` default
20, max 200; result `{ data, meta }`). `users.delete(id)` is the LGPD/GDPR cascade
(sessions, grants, PATs, passkeys, audit anonymization).

Source: `src/types.ts` (`CreateUserInput`, `CreateOrganizationInput`, `ClientInput`,
`OffsetListParams`).

### Pattern 3 — audit cursor paging, key rotation, token introspection

```ts
import type { Authkit } from '@adonis-agora/authkit-sdk'

export async function nightly(authkit: Authkit) {
  let page = await authkit.audit.list({ type: 'login.failure', first: 100 })
  while (page.meta.hasNext && page.meta.nextCursor) {
    page = await authkit.audit.list({ type: 'login.failure', first: 100, after: page.meta.nextCursor })
  }

  const status = await authkit.keys.status()
  if (status.policy.enabled && status.nextRotationInDays === 0) {
    await authkit.keys.rotate({ keep: 2 }) // retire: true keeps only the new key
  }
}

export async function whoIs(authkit: Authkit, bearer: string) {
  const result = await authkit.tokens.verify(bearer) // PAT or opaque access token
  return result.active ? result.sub : null
}
```

`keys.*` only work with a managed keystore (`jwks: { source: 'managed', store }`):
remote returns 501, embedded throws.

Source: `src/types.ts` (`ListAuditParams`, `CursorListParams`, `KeysRotateInput`,
`VerifyTokenResult`), `apps/docs/content/docs/sdk.mdx` § keys.

## Common mistakes

### HIGH — Remote driver against an IdP with no Admin API key configured

```ts no-check
// Wrong — IdP config has no adminApi: the /api/authkit/v1 routes are never mounted
defineConfig({ issuer, adapter, jwks, accountStore })
```

```ts no-check
// Correct — resolve at least one key (AUTHKIT_ADMIN_API_KEY) and share it with the SDK caller
defineConfig({ issuer, adapter, jwks, accountStore, adminApi: { apiKeys: 'env' } })
```

`adminApi.enabled` defaults to "at least one API key resolved", so without keys every
SDK call fails with `AuthkitApiError` (404), and a key not listed in `apiKeys` gets 401.
If the server mounts the API under a custom prefix
(`registerAuthHost(router, { adminApi: { prefix: '/authkit/api' } })`), pass the same
`apiPrefix` to the SDK.

Source: `packages/authkit-server/src/define_config.ts` (`resolveAdminApi`),
`packages/authkit-server/src/host/register_auth_host.ts` (`adminApi` prefix).

### HIGH — Putting the API prefix into `baseUrl`

```ts
import { createRemoteAuthkit } from '@adonis-agora/authkit-sdk'

// Wrong — requests go to /api/authkit/v1/api/authkit/v1/users
export const wrong = createRemoteAuthkit({
  baseUrl: 'https://idp.example.com/api/authkit/v1',
  apiKey: process.env.AUTHKIT_ADMIN_API_KEY!,
})

// Correct — host root only; apiPrefix (default '/api/authkit/v1') is appended
export const right = createRemoteAuthkit({
  baseUrl: 'https://idp.example.com',
  apiKey: process.env.AUTHKIT_ADMIN_API_KEY!,
})
```

The remote driver builds every URL as `baseUrl` (trailing slashes stripped) +
normalized `apiPrefix` + path.

Source: `src/remote_driver.ts` (`createRemoteAuthkit`, `root`).

### MEDIUM — Catching only `AuthkitApiError` in embedded mode

```ts
import { AuthkitApiError, type Authkit } from '@adonis-agora/authkit-sdk'

export async function findUser(authkit: Authkit, id: string) {
  try {
    return await authkit.users.get(id)
  } catch (err) {
    // Remote: AuthkitApiError with status/code ('network_error' + status 0 on fetch failure).
    if (err instanceof AuthkitApiError && err.status === 404) return null
    // Embedded: plain Error (not found, e-mail taken, unsupported capability) — handle it too.
    if (!(err instanceof AuthkitApiError)) return null
    throw err
  }
}
```

Only the remote driver maps failures to `AuthkitApiError`; the embedded driver throws
plain `Error`s, so `instanceof AuthkitApiError`-only handlers let them escape when you
switch modes.

Source: `src/errors.ts`, `src/embedded_driver.ts` (`throw new Error(...)`).

### MEDIUM — Creating an organization with only a name

```ts expect-error=TS2739
import type { Authkit } from '@adonis-agora/authkit-sdk'
declare const authkit: Authkit

// Wrong — slug and ownerAccountId are required
await authkit.organizations.create({ name: 'Acme' })
```

```ts
import type { Authkit } from '@adonis-agora/authkit-sdk'
declare const authkit: Authkit
declare const ownerId: string

// Correct
await authkit.organizations.create({ name: 'Acme', slug: 'acme', ownerAccountId: ownerId })
```

`CreateOrganizationInput` is `{ name, slug, ownerAccountId, logoUrl? }`; the package
README's `create({ name: 'Acme' })` shorthand does not typecheck.

Source: `src/types.ts` (`CreateOrganizationInput`).

See also: `authkit-idp-setup` (in `@adonis-agora/authkit-server`) — `defineConfig`,
`registerAuthHost` and the managed keystore that `keys.*` operate on.
