---
"@adonis-agora/authkit-server": minor
---

API headless (Clerk-style) para tipos de login

Nova opção `headless` no `defineConfig` que monta uma JSON API autenticada pela
SESSÃO DO APP (não pelo `accountGuard` do console de conta):

```ts
defineConfig({
  // ...
  headless: {
    baseUrl: '/api/authkit', // default
    resolveAccountId: async (ctx) => (await ctx.auth.getUserOrFail()).id,
  },
})
```

O host-kit passa a servir `GET/PUT {baseUrl}/login-methods` — o mesmo contrato da
JSON API do console, mas com a conta resolvida pelo `resolveAccountId` fornecido
pelo HOST (tipicamente `ctx.auth.getUserOrFail()`). Assim um RP usa AuthKit como
frontend (os hooks `useLoginMethodsQueryOptions` /
`useUpdateLoginMethodsMutationOptions` basta apontar o `accountBaseUrl` para a
base headless) sem expor o console `/account/*`.

- `GET` devolve `{ supported, methods, available, locked }` (interseção global ×
  preferência, com os pins de config computados).
- `PUT` grava a preferência; mantém o all-off guard (`all_methods_off` → 400) e
  validação de body.

O resolver do host retornando `null` (ou lançando, ex.
`auth.getUserOrFail()`) → 401. A feature é opt-in (ausente = nada montado;
back-compat total). A lógica de estado foi extraída para
`host/login_methods_state.ts` (reuso entre console e headless sem duplicar regra).