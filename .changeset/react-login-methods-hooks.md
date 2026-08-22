---
"@adonis-agora/authkit-react": minor
---

Hooks e tipos para a preferência de tipos de login por usuário

Novos hooks TanStack Query sobre a Account API `GET/PUT
/account/api/login-methods` (requer authkit-server com a feature):

- `useLoginMethodsQueryOptions()` — preferência do usuário + estado final
  (`available`) + o que está travado (`locked`).
- `useUpdateLoginMethodsMutationOptions()` — grava a preferência; `{}` volta a
  herdar os globais.

Tipos exportados: `AccountLoginMethodsResult`, `UpdateLoginMethodsResult`,
`UserLoginMethodsInput`. Query key nova: `authkitKeys.account.loginMethods()`.
