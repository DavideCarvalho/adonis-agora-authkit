# @adonis-agora/authkit-react

Ergonomia de frontend sobre o AuthKit para apps **AdonisJS + Inertia + React**:
um `useAuth()` tipado, helpers de papéis e componentes de gating.

Este pacote **não** faz autenticação — ele consome o estado de auth que o host
AdonisJS já resolveu (via `@adonis-agora/authkit-client`) e compartilhou como
uma shared-prop do Inertia.

## Instalação

```bash
pnpm add @adonis-agora/authkit-react
```

`react`, `react-dom` e `@inertiajs/react` são **peer dependencies** (o app os fornece).

## 1. No host AdonisJS: compartilhar a prop `authkit`

A shared-prop tem o formato `AuthSharedProps`. Use `authkit.getUser()` /
`authkit.identity` do `@adonis-agora/authkit-client` para preenchê-la — tipicamente
num middleware ou no `config/inertia.ts` (`sharedData`):

```ts
// config/inertia.ts
import { defineConfig } from '@adonisjs/inertia'

export default defineConfig({
  sharedData: {
    authkit: async (ctx) => {
      const authkit = ctx.authkit // sua instância do Authenticator
      const user = await authkit.getUser() // mesmo shape de identityToUser/resolveUser
      return {
        user: user ?? null,
        globalRoles: authkit.identity?.globalRoles ?? [],
      }
    },
  },
})
```

O objeto `user` deve corresponder ao tipo `AuthUser`:
`{ id, email, name?, avatarUrl?, globalRoles }` — exatamente a saída de
`identityToUser`/`resolveUser` do client.

## 2. No frontend: `useAuth()`

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

`useAuth()` nunca lança quando a prop está ausente: retorna estado
não-autenticado (`user: null`, listas vazias).

## 3. Componentes de gating

```tsx
import { Authenticated, Guest } from '@adonis-agora/authkit-react'

<Authenticated fallback={<LoginButton />}>
  <Dashboard />
</Authenticated>

<Guest>
  <MarketingBanner />
</Guest>
```

Gating por papel/permissão de app (`<Can>`) migrou para
`@adonis-agora/authz-react`, que consulta o serviço Authz em vez de depender
de papéis de app resolvidos no host — veja a doc desse pacote.

## 4. `AuthProvider` (opcional)

Fora do Inertia (testes, Storybook), injete o valor manualmente. O contexto tem
precedência sobre as page props quando presente:

```tsx
import { AuthProvider } from '@adonis-agora/authkit-react'

<AuthProvider value={{ user, globalRoles: user.globalRoles }}>
  <App />
</AuthProvider>
```

## 5. Config + componentes prontos

Envolva a app com `<AuthkitProvider>` para configurar URLs/endpoints e use os
hooks headless e componentes prontos:

```tsx
import '@adonis-agora/authkit-react/styles.css'
import {
  AuthkitProvider,
  useSignIn, useSignOut, useUser, useProfile, useSessions, useAuthorizedApps,
  SignInButton, SignOutButton, UserButton, UserProfile, AuthorizedApps,
} from '@adonis-agora/authkit-react'

<AuthkitProvider config={{ csrfToken: page.props.csrfToken }}>
  <UserButton />
  <UserProfile />
  <AuthorizedApps />
</AuthkitProvider>
```

Defaults dos endpoints apontam para as rotas reais do host-kit
(`/auth/login`, `/account/logout`, `/account/security`, `/account/security/profile`,
`/account/apps`, …). Numa topologia de *client app*, aponte-os para rotas locais que
redirecionam para o IdP. Temável via CSS vars `--authkit-*`. Veja a
[doc de React](https://...) para detalhes.

## Helpers puros

Para uso fora de componentes, as funções de papéis são exportadas e livres de React:

```ts
import { hasGlobalRole, hasAnyGlobalRole, hasAllGlobalRoles } from '@adonis-agora/authkit-react'

hasGlobalRole(user, 'ADMIN')
hasAnyGlobalRole(user, ['ADMIN', 'TEACHER'])
```
