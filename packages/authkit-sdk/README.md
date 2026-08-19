# @adonis-agora/authkit-sdk

Backend SDK for the [AuthKit](https://github.com/DavideCarvalho/adonis-agora-authkit) Admin API:
manage users, sessions, OIDC clients, organizations, settings, signing keys, and the audit
log from server-side code — with **one typed interface** and **two interchangeable drivers**.

- **`remote`** — HTTP against the Admin REST API (`/api/authkit/v1`), authenticated with a
  Bearer API key. Use it from any backend service.
- **`embedded`** — in-process calls that resolve the server services straight from the
  AdonisJS container. Use it when the IdP runs in the **same** app: zero HTTP, zero API key.

Both drivers return the **exact same shapes**, so you can start embedded and split out to
remote later without touching call sites.

## Install

```sh
pnpm add @adonis-agora/authkit-sdk
```

`@adonis-agora/authkit-server` is an **optional** peer dependency — only the `embedded`
driver needs it (imported lazily). Remote-only consumers can skip it entirely.

## Usage

`createAuthkit` always returns a `Promise<Authkit>`.

### Remote

```ts
import { createAuthkit } from '@adonis-agora/authkit-sdk'

const authkit = await createAuthkit({
  mode: 'remote',
  baseUrl: 'https://idp.example.com',
  apiKey: process.env.AUTHKIT_ADMIN_KEY!,
  // apiPrefix: '/api/authkit/v1', // default; must match registerAuthHost
})
```

### Embedded (same app)

```ts
import app from '@adonisjs/core/services/app'
import { createAuthkit } from '@adonis-agora/authkit-sdk'

const authkit = await createAuthkit({ mode: 'embedded', app })
```

### The interface

```ts
// Users
await authkit.users.list({ search: 'jane' })
const user = await authkit.users.create({ email: 'jane@acme.dev' })
await authkit.users.delete(user.id) // cascades sessions, grants, tokens (LGPD/GDPR)

// Sessions
await authkit.sessions.list(user.id)
await authkit.sessions.revokeAll(user.id)

// OIDC clients
await authkit.clients.create({ /* client input */ })
await authkit.clients.regenerateSecret(clientId)

// Organizations, members & invitations
await authkit.organizations.create({ name: 'Acme' })
await authkit.organizations.members.add(orgId, { accountId, role: 'admin' })

// Audit log, stats, settings, signing keys
await authkit.audit.list({ action: 'user.login' })
await authkit.stats()
await authkit.settings.set('branding.name', 'Acme')
await authkit.keys.rotate({ retire: false })

// Token verification
const result = await authkit.tokens.verify(bearerToken)
```

Errors surface as `AuthkitApiError`:

```ts
import { AuthkitApiError } from '@adonis-agora/authkit-sdk'

try {
  await authkit.users.get('missing')
} catch (err) {
  if (err instanceof AuthkitApiError) {
    console.error(err.status, err.message)
  }
}
```

## Documentation

Full guide and the Admin REST API reference live in the
[AuthKit docs](https://github.com/DavideCarvalho/adonis-agora-authkit) (`apps/docs` → Backend SDK
and Admin API).

## License

MIT
