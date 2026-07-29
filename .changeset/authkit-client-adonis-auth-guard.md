---
"@adonis-agora/authkit-client": minor
---

`authkitClientGuard()`: um guard de verdade do `@adonisjs/auth` (opt-in)

Até agora o `authkit-client` não tinha guard nenhum, e o `authkit_middleware`
ainda **atropelava** o `ctx.auth` do framework com o `Authenticator` da lib. Um
host em cima do `authkit-client` simplesmente não conseguia usar `@adonisjs/auth`:
sem `middleware.auth()`, sem `ctx.auth.user` tipado com o model do app, sem
Bouncer em cima do usuário logado. Cada host reescrevia o próprio middleware de
autenticação — e cada um desses é um lugar a mais para errar autorização.

**Nada muda para quem já usa a lib.** Sem guard em `config/auth.ts`, o
`authkit_middleware` continua idêntico: `ctx.auth` segue sendo o `Authenticator`
do authkit, `getIdentity()` / `getUser()` / `getUserOrFail()` / `hasGlobalRole()`
/ `toSharedProps()` seguem com o mesmo comportamento, e o `auth_middleware` /
`silent_auth_middleware` continuam funcionando. Não há deprecação, não há aviso
em runtime, não é preciso migrar.

## O que entrou

- `authkitClientGuard({ provider })` — implementa o `GuardContract` do
  `@adonisjs/auth` (mesmo `authenticate()` / `check()` / `getUserOrFail()`, e o
  MESMO `E_UNAUTHORIZED_ACCESS` dos guards nativos, então o `middleware.auth()` e
  o exception handler do host tratam igual).
- `AuthkitContextMiddleware` (`@adonis-agora/authkit-client/authkit_context_middleware`)
  — popula `ctx.authkit` **sem tocar em `ctx.auth`**.
- `getAuthkit(ctx)` — o resolvedor memoizado por request que os dois usam.

O guard **não reimplementa resolução de sessão**. Ele passa pelo
`AuthkitClientManager` exatamente como o `authkit_middleware`: refresh proativo
do token (`maybeRefresh`), o `SessionResolver` configurado (JWT/opaco/PAT),
as métricas e a ponte do `@agora/context` continuam valendo no caminho do guard.
A única coisa que ele acrescenta é a ponte: pega `identity.userId` (a claim
`sub` — a `Identity` **não** tem `id`) e pede o usuário do app ao `provider`.

`@adonisjs/auth` é um **peer opcional**: todo import dele é type-only, exceto um
`await import('@adonisjs/auth')` dentro do resolver do config — que só roda
quando o host resolve o `config/auth.ts`. Quem não usa `@adonisjs/auth` não
carrega nada a mais.

## Como habilitar (3 passos)

1. `config/auth.ts`:

   ```ts
   import { defineConfig } from '@adonisjs/auth'
   import { sessionUserProvider } from '@adonisjs/auth/session'
   import { authkitClientGuard } from '@adonis-agora/authkit-client'

   export default defineConfig({
     default: 'web',
     guards: {
       web: authkitClientGuard({
         provider: sessionUserProvider({ model: () => import('#models/user') }),
       }),
     },
   })
   ```

   A coluna de id do model precisa casar com `identity.userId` (é o que o
   `lucidMirror()` grava).

2. `start/kernel.ts`: **troque** o `authkit_middleware` pelo par do framework +
   o middleware de contexto do authkit. Os dois donos de `ctx.auth` não convivem
   na mesma request — é ou um ou outro, de propósito:

   ```diff
    router.use([
   -  () => import('@adonis-agora/authkit-client/authkit_middleware'),
   +  () => import('@adonisjs/auth/initialize_auth_middleware'),
   +  () => import('@adonis-agora/authkit-client/authkit_context_middleware'),
    ])
   ```

   Registrar os dois resolveria a sessão duas vezes em objetos diferentes — não
   faça isso.

3. Nas rotas, use o `middleware.auth()` do framework no lugar do
   `auth_middleware` / `silent_auth_middleware` da lib (que passam a ser o
   caminho legado — continuam existindo e funcionando para quem NÃO adotou o
   guard).

Depois disso:

- `ctx.auth.user` é o model do app, vindo do `provider`;
- `ctx.authkit` é o `Authenticator` do authkit — `hasGlobalRole()`,
  `getIdentity()` (a `Identity` crua), `toSharedProps()`.

## `provider` + `resolveUser`

São superfícies separadas e ambas continuam valendo:
`ctx.auth.user` vem **sempre** do `provider`; `ctx.authkit.getUser()` continua
vindo do `resolveUser` de `config/authkit_client.ts`. **O guard nunca chama
`resolveUser`.** Com o guard configurado, o normal é apagar o `resolveUser` e
deixar só o `provider`.

## Limitação conhecida

`authenticateAsClient()` (o `loginAs` dos plugins de teste do `@adonisjs/auth`)
lança: a sessão deste guard é um TokenSet OIDC assinado pelo IdP, e a lib não
tem como forjar um `id_token` a partir de um objeto de usuário. Em teste, use
`mintTestIdToken()` de `@adonis-agora/authkit-testing` e plante o TokenSet na
sessão, ou injete `fakeAuthenticator()` em `ctx.authkit`.
