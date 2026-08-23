---
name: authkit-react-auth
description: >-
  Frontend auth ergonomics with @adonis-agora/authkit-react in AdonisJS + Inertia +
  React apps. Covers the shared-prop `authkit` contract (AuthSharedProps:
  { user, globalRoles }), useAuth() semantics (never throws; AuthProvider context
  precedence), role helpers hasGlobalRole/hasAnyGlobalRole/hasAllGlobalRoles,
  Authenticated/Guest gating components with fallback, AuthkitProvider config
  ({ csrfToken, endpoints, idp }) with headless hooks (useSignIn, useSignOut,
  useProfile, useSessions, useAuthorizedApps) and ready components (SignInButton,
  UserButton, UserProfile, AuthorizedApps), and the idp:'external' degradation rule.
  Use when wiring the auth shared prop, gating UI by roles, adding sign-in/out
  buttons or account components, or debugging an always-unauthenticated React app.
license: MIT
metadata:
  type: core
  library: "@adonis-agora/authkit-react"
  library_version: "0.20.0"
  framework: react
sources:
  - "DavideCarvalho/adonis-authkit:packages/authkit-react/README.md"
  - "DavideCarvalho/adonis-authkit:packages/authkit-react/src/use_auth.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-react/src/config.ts"
  - "DavideCarvalho/adonis-authkit:packages/authkit-react/index.ts"
---

# React auth ergonomics (Inertia)

`@adonis-agora/authkit-react` never authenticates anything. It consumes auth state
the AdonisJS host already resolved (via `@adonis-agora/authkit-client`) and shares
with Inertia as a page prop — then gives you typed hooks, role helpers, gating
components and ready-made account UI on top.

## Setup

Share the `authkit` prop from the host, typically in `config/inertia.ts`:

```ts
// config/inertia.ts
import { defineConfig } from '@adonisjs/inertia'

export default defineConfig({
  sharedData: {
    authkit: async (ctx) => {
      const auth = ctx.authkit // your Authenticator instance
      const user = await auth.getUser() // same shape as identityToUser/resolveUser
      return {
        user: user ?? null,
        globalRoles: auth.identity?.globalRoles ?? [],
      }
    },
  },
})
```

Then consume it in any component:

```tsx
import { useAuth } from '@adonis-agora/authkit-react'

function Header() {
  const { user, isAuthenticated, hasGlobalRole } = useAuth()

  if (!isAuthenticated) return <a href="/login">Entrar</a>

  return (
    <div>
      Olá, {user!.name ?? user!.email}
      {hasGlobalRole('ADMIN') && <a href="/admin">Admin</a>}
    </div>
  )
}
```

Source: `packages/authkit-react/README.md` §§ 1–2.

## Core patterns

### Pattern 1 — role gating with `Authenticated` / `Guest`

```tsx
import { Authenticated, Guest } from '@adonis-agora/authkit-react'

<Authenticated fallback={<LoginButton />}>
  <Dashboard />
</Authenticated>

<Guest>
  <MarketingBanner />
</Guest>
```

For pure functions outside components:

```ts
import { hasGlobalRole, hasAnyGlobalRole, hasAllGlobalRoles } from '@adonis-agora/authkit-react'

hasGlobalRole(user, 'ADMIN')
hasAnyGlobalRole(user, ['ADMIN', 'TEACHER'])
```

Source: `packages/authkit-react/README.md` §§ 3 and "Helpers puros".

### Pattern 2 — `AuthProvider` outside Inertia

In tests or Storybook there are no page props; inject state manually. Context takes
precedence over Inertia props when present:

```tsx
import { AuthProvider } from '@adonis-agora/authkit-react'

<AuthProvider value={{ user, globalRoles: user.globalRoles }}>
  <App />
</AuthProvider>
```

Source: `packages/authkit-react/README.md` § 4.

### Pattern 3 — `AuthkitProvider` + ready components

Wrap the app once to configure URLs/CSRF, then use headless hooks and prebuilt
components that talk to the host-kit's JSON endpoints:

```tsx
import '@adonis-agora/authkit-react/styles.css'
import {
  AuthkitProvider,
  useSignIn, useSignOut,
  UserButton, UserProfile, AuthorizedApps,
} from '@adonis-agora/authkit-react'

<AuthkitProvider config={{ csrfToken: page.props.csrfToken }}>
  <UserButton />
  <UserProfile />
  <AuthorizedApps />
</AuthkitProvider>
```

Endpoint defaults point at real host-kit routes (`/auth/login`, `/account/logout`,
`/account/security/profile`, `/account/apps`, …). In a *client-app* topology point
them at local routes that redirect/proxy to the IdP; theming via CSS vars
`--authkit-*`.

Source: `packages/authkit-react/README.md` § 5, `src/config.ts` (`DEFAULT_CONFIG`,
`AuthkitConfig`).

### Pattern 4 — third-party IdP mode

When the backend authenticates against another IdP (via
`@adonis-agora/authkit-client`), declare it so data-dependent components degrade
instead of calling endpoints that do not exist:

```tsx
<AuthkitProvider config={{ idp: 'external' }}>
  {/* works: SignInButton, SignOutButton, useAuth, Avatar */}
  {/* degrades to null: UserProfile, OrganizationSwitcher, AuthorizedApps */}
</AuthkitProvider>
```

Source: `src/config.ts` (`AuthkitIdpMode` JSDoc).

## Common mistakes

### HIGH — Never sharing the `authkit` prop from the host

```ts
// Wrong — no sharedData; every page renders unauthenticated
export default defineConfig({ sharedData: {} })
```

```ts
// Correct — share { user, globalRoles } under the `authkit` key
sharedData: {
  authkit: async (ctx) => {
    const auth = ctx.authkit
    return {
      user: (await auth.getUser()) ?? null,
      globalRoles: auth.identity?.globalRoles ?? [],
    }
  },
}
```

`useAuth()` deliberately never throws on a missing prop — it falls back to
unauthenticated state (`user: null`, empty lists, dev-only console.warn), so a host
that forgot the prop ships a UI where nobody ever appears logged in.

Source: `src/use_auth.ts` (fallback + warn), README § 1.

### MEDIUM — Feeding a user object that does not match `AuthUser`

```ts
// Wrong — raw token claims passed as the user
sharedData: { authkit: async (ctx) => ({ user: await ctx.authkit.getIdentity() }) }
```

```ts
// Correct — resolveUser/identityToUser output satisfies AuthUser
const user = await ctx.authkit.getUser()
return { user: user ?? null, globalRoles: ctx.authkit.identity?.globalRoles ?? [] }
```

The prop's `user` must match `{ id, email, name?, avatarUrl?, globalRoles }` —
exactly what `identityToUser`/`resolveUser` produce. Raw identity claims lack that
shape and break typed consumers downstream.

Source: `packages/authkit-react/README.md` § 1 ("O objeto `user` deve corresponder ao
tipo `AuthUser`").

### MEDIUM — Expecting `<Can>` / permission gating here

```tsx
// Wrong — looking for app-permission gating in authkit-react
import { Can } from '@adonis-agora/authkit-react' // not exported
```

```tsx
// Correct — global-role gates come from authkit; permissions live in authz-react
import { Authenticated } from '@adonis-agora/authkit-react'
import { CanPermission } from '@adonis-agora/authz-react' // consults the Authz service
```

App-role/permission gating migrated to `@adonis-agora/authz-react`; this package
gates only on authentication and token-level `globalRoles`. (`useCan`/
`CanPermission` exist here only as thin callers of the `/authz/can` endpoint.)

Source: `packages/authkit-react/README.md` § 3 callout, `index.ts`
(`useCan`, `CanPermission`, `canPath` endpoint).

See also: `authkit-rp-client/SKILL.md` — the host-side resolver choices decide what
reaches the `authkit` prop.
