---
"@adonis-agora/authkit-client": minor
---

Exporta `isAuthkitAdmin`/`authkitDashboardAuthorize`/`authkitDashboardMiddleware` — o gate admin dos dashboards embutidos, pronto pra plugar

Todo host que embute o console admin de uma lib irmã (`@adonis-agora/durable`,
`@adonis-agora/media`, `@adonis-agora/agent`, `@adonis-agora/telescope`) reescrevia
o mesmo gate: checar `ctx.auth.hasGlobalRole('ADMIN')` e traduzir pra QUALQUER
formato que o `config/*_dashboard.ts` daquela lib espera — `authorize: (ctx) =>
boolean` (durable/agent/telescope) ou `middleware: (ctx, next) => Promise<void>`
(media). Mesma checagem, dois shims hand-rolled por app.

`packages/authkit-client/src/host/dashboard_guard.ts` (novo subpath
`@adonis-agora/authkit-client/dashboard_guard`, também no entrypoint raiz) fixa a
checagem uma vez sobre o próprio `Authenticator` do authkit e expõe os dois
adapters prontos:

```ts
// config/durable_dashboard.ts (authorize)
import { authkitDashboardAuthorize } from "@adonis-agora/authkit-client";
export default defineConfig({ authorize: authkitDashboardAuthorize() });

// config/media_dashboard.ts (middleware)
import { authkitDashboardMiddleware } from "@adonis-agora/authkit-client";
export default defineConfig({ middleware: authkitDashboardMiddleware() });
```

`isAuthkitAdmin(ctx, { role? })` é o predicado por trás dos dois: resolve a
sessão via `getAuthkit(ctx)` (funciona tanto com o `ctx.auth` do
`authkit_middleware` legado quanto com o `authkitClientGuard` mais novo, sem
depender da augmentation de `HttpContext.auth` que cada host declara pro seu
próprio model de usuário — este módulo é da lib, não vê essa augmentation) e
checa `hasGlobalRole('ADMIN')` por padrão; `role` troca o nome da global role
pra quem usa outra convenção. Sem sessão -> `false`/`401`; sessão sem a role ->
`false`/`403` — mesma semântica que o `authorize`/`middleware` de cada lib já
espera de um retorno negativo.

Só cobre o caso que já usa o mecanismo NATIVO do authkit (`hasGlobalRole`) — apps
que gateiam admin por outra via (uma role de app separada, uma coluna
`isAdmin`, um pacote de authz por cima) continuam com o helper deles; nada aqui
migra esse mecanismo.
