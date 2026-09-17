# @adonis-agora/authkit-client

Adapter consumidor OpenID Connect para AdonisJS — integra um app como client do
Authorization Server (`@adonis-agora/authkit-server`), validando o ID token localmente por JWKS.

## Instalação
```bash
node ace add @adonis-agora/authkit-client
# ou: pnpm add @adonis-agora/authkit-client && node ace configure @adonis-agora/authkit-client
```
O `configure` publica `config/authkit_client.ts`, o controller `app/controllers/oidc_session_controller.ts`
(login/callback/logout) e registra o provider + o middleware `authkit_middleware`.

## Rotas de sessão

O caminho **recomendado** é `registerOidcClient(router)`: uma chamada que monta
`/auth/login`, `/auth/callback`, `/auth/logout` e o back-channel logout
(`POST /auth/backchannel-logout`), já usando `startSession`/`endSession` e o
RP-initiated logout. Substitui o boilerplate do controller ejetado.
```ts
// start/routes.ts
import { registerOidcClient } from '@adonis-agora/authkit-client'

registerOidcClient(router, {
  prefix: '/auth',                                  // default
  loginMiddleware: middleware.guest(),
  redirects: { byGlobalRole: { ADMIN: '/admin' }, default: '/' },
  afterLogin: async (ctx, identity) => undefined,   // retornar string redireciona
  postLogoutRedirect: '/',                          // default: origem do redirectUri + '/'
  backchannelLogout: true,                           // default
})
```
Opções: `prefix`, `afterLogin`, `redirects`, `postLogoutRedirect`, `backchannelLogout`,
`loginMiddleware` e `passthroughParams`. `AUTHKIT_REDIRECT_URI` deve apontar para a rota de callback.

### Customização (controller ejetado)
Se precisar de rotas próprias, o `configure` publica `app/controllers/oidc_session_controller.ts`
(login/callback/logout) para você adaptar:
```ts
// start/routes.ts
import OidcSessionController from '#controllers/oidc_session_controller'
router.get('/auth/login', [OidcSessionController, 'login'])
router.get('/auth/callback', [OidcSessionController, 'callback'])
router.post('/auth/logout', [OidcSessionController, 'logout'])
```
> **Ao editar o controller, use o manager — não escreva a sessão cru.** No callback chame
> `manager.startSession(ctx, tokenSet)` e no logout `manager.endSession(ctx)`; **nunca**
> `session.put(sessionKey)` / `session.forget(sessionKey)`. A escrita crua não limpa o
> `impersonationBinding` nem a credencial de impersonação parqueada — o refresh token do ator
> continua serializado no cookie da próxima identidade, e o logout deixa a credencial viva.
> `startSession`/`endSession` são os caminhos que mantêm a invariante.

## Uso por request
`ctx.auth` é populado pelo `authkit_middleware`:
```ts
const identity = await ctx.auth.getIdentity()   // claims OIDC validadas (ou null)
const user = await ctx.auth.getUser()            // model do app (via resolveUser)
ctx.auth.hasGlobalRole('ADMIN')                  // síncrono, das claims (roles do token)
```

> **Autorização por app-role saiu do AuthKit.** O AuthKit só autentica e conhece as `globalRoles` do
> token. Roles do app (numa tabela do domínio) e permissões são do `@adonis-agora/authz` — configure
> o seam `resolveRoles` lá. Guard de rota por role vai pra authz/Bouncer, não para o `authkit_middleware`
> (que só exige login).

## Resolução de sessão
`resolvers.jwt({ tokenSource })` valida o **ID token** (JWT) por JWKS:
- `tokenSource: 'session'` (default) — lê o token set do `@adonisjs/session`.
- `tokenSource: 'bearer'` — lê do header `Authorization` (SPA/API).

## Topologias de banco
A identidade (`ctx.auth.identity`) sempre vem do **token validado** e independe da
topologia de banco. O que muda é como `resolveUser` obtém o model do app.

### Mesmo banco + schemas
O app lê um model Lucid local mapeado pra `auth.users` (FK cross-schema):
```ts
// config/authkit_client.ts
resolveUser: async (identity) => {
  // FK cross-schema: app.users.auth_user_id -> auth.users.id
  return AppUser.query().where('authUserId', identity.userId).firstOrFail()
},
```

### Bancos separados
Sem FK cross-schema possível. Como o IdP emite um **ID token "gordo"**
(email/name/roles nas claims), o caminho recomendado é claims-only:
```ts
import { identityToUser } from '@adonis-agora/authkit-client'

resolveUser: identityToUser, // { id, email, name?, avatarUrl?, globalRoles }
```
Pra dados além do que o token carrega, use o resolver de userinfo (busca no
endpoint `${issuer}/me` com o access token; faz fallback pra claims sem token):
```ts
import { createUserinfoResolver } from '@adonis-agora/authkit-client'

resolveUser: createUserinfoResolver({ issuer: env.get('AUTHKIT_ISSUER') }),
// ou: createUserinfoResolver({ userinfoEndpoint: 'https://idp/me' })
```
Roles do app (a tabela de roles do próprio domínio) não passam mais pelo AuthKit — configure o seam
`resolveRoles` do `@adonis-agora/authz`, que as une às `globalRoles` do token para decidir permissão.

## Ordem de middleware (importante)
O middleware do `@adonisjs/session` DEVE rodar ANTES do `authkit_middleware` no stack `router`
(o resolver lê o token da session). Garanta essa ordem em `start/kernel.ts`.

## Observabilidade (opcional)
O `Authenticator` registra métricas de resolução (`authkit.resolve.duration` e
`authkit.resolve.errors`) quando um `MetricsRecorder` é injetado. As métricas são emitidas via
OpenTelemetry **quando** `@opentelemetry/api` está instalado; sem ele a agregação é no-op.
O comportamento por request não muda — observabilidade é puramente aditiva.
