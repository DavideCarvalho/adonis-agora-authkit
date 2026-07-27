---
"@adonis-agora/authkit-server": minor
---

Add `oidcRpGuard` — an `@adonisjs/auth` guard for OIDC Relying Parties. RPs that consume the issuer via Authorization Code + PKCE can plug this guard in `config/auth.ts` to get native `ctx.auth.user` / `auth.check()` / `middleware.auth()` support without a custom guard implementation.

```ts
import { oidcRpGuard } from '@adonis-agora/authkit-server'
import { sessionUserProvider } from '@adonisjs/auth/session'

export default defineConfig({
  default: 'web',
  guards: {
    web: oidcRpGuard({
      provider: sessionUserProvider({ model: () => import('#models/user') }),
    }),
  },
})
```
