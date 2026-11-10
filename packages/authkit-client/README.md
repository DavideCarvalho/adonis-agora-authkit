# @adonis-agora/authkit-client

Adapter consumidor OpenID Connect para AdonisJS — integra um app como client do
Authorization Server (`@adonis-agora/authkit-server`), validando o ID token localmente por JWKS.

## Instalação
```bash
node ace add @adonis-agora/authkit-client
# ou: pnpm add @adonis-agora/authkit-client && node ace configure @adonis-agora/authkit-client
```
`@adonisjs/auth` é peer obrigatório: `ctx.auth` é o autenticador do `@adonisjs/auth`, apoiado
na sessão do AuthKit pelo `authkitClientGuard`. O `configure`:

- instala `@adonisjs/auth` se o app ainda não depende dele (`--no-install` só imprime o comando);
- publica `config/authkit_client.ts` e `config/auth.ts` (`authkitClientGuard` +
  `sessionUserProvider` com `--model`, default `#models/user`; um `config/auth.ts` existente não é
  tocado e o guard a adicionar é impresso);
- publica `app/middleware/auth_middleware.ts` / `silent_auth_middleware.ts` (named `auth` e
  `silentAuth`) e o controller `app/controllers/oidc_session_controller.ts`;
- registra os providers e, no `router`, `initialize_auth_middleware` + `authkit_context_middleware`.

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
Rotas usam `middleware.auth()` / `middleware.silentAuth()` e os controllers leem o usuário em
`ctx.auth`:
```ts
// app/controllers/dashboard_controller.ts
export default class DashboardController {
  async handle({ auth, authkit, inertia }: HttpContext) {
    const user = auth.getUserOrFail()                // atrás de middleware.auth()
    const isAdmin = authkit.hasGlobalRole('ADMIN')   // síncrono, das claims do token
    return inertia.render('dashboard', { user, isAdmin })
  }
}
```
O guard pega o usuário do `resolveUser` (ex.: `lucidMirror`, que cria a linha no primeiro login)
e cai no provider quando não há `resolveUser`. Sem tabela local de usuários, use
`authkitIdentityProvider()` como provider: `ctx.auth.user` é a `Identity`.

`ctx.authkit` (populado pelo `authkit_context_middleware`) traz o que só o AuthKit sabe — a
`Identity` (`getIdentity()`), `hasGlobalRole`, a org ativa e `toSharedProps()` para o
`@adonis-agora/authkit-react` — inclusive em rotas públicas.

> **Autorização por app-role saiu do AuthKit.** O AuthKit só autentica e conhece as `globalRoles` do
> token. Roles do app (numa tabela do domínio) e permissões são do `@adonis-agora/authz` — configure
> o seam `resolveRoles` lá. Guard de rota por role vai pra authz/Bouncer, não para o `middleware.auth()`
> (que só exige login).

## Resolução de sessão
`resolvers.jwt({ tokenSource })` valida o **ID token** (JWT) por JWKS:
- `tokenSource: 'session'` (default) — lê o token set do `@adonisjs/session`.
- `tokenSource: 'bearer'` — lê do header `Authorization` (SPA/API): `Bearer <jwt>` ou
  `DPoP <jwt>` com a prova no header `DPoP` (token com `cnf.jkt` enviado como `Bearer` é recusado).

Rotas de API ganham um guard próprio com `resolver`:
```ts
// config/auth.ts
api: authkitClientGuard({
  provider: authkitIdentityProvider(),
  resolver: resolvers.jwt({ tokenSource: 'bearer' }), // ou resolvers.opaque/resolvers.pat
}),
```
```ts
// start/routes.ts
router.group(() => { /* … */ }).prefix('/api').use(middleware.auth({ guards: ['api'] }))
```

## Topologias de banco
A identidade (`ctx.authkit.identity`) sempre vem do **token validado** e independe da
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
No stack `router`: `@adonisjs/session` → `@adonisjs/auth/initialize_auth_middleware` →
`authkit_context_middleware` (o resolver lê o token da session). O `configure` já registra nessa
ordem.

## Observabilidade (opcional)
O `Authenticator` registra métricas de resolução (`authkit.resolve.duration` e
`authkit.resolve.errors`) quando um `MetricsRecorder` é injetado. As métricas são emitidas via
OpenTelemetry **quando** `@opentelemetry/api` está instalado; sem ele a agregação é no-op.
O comportamento por request não muda — observabilidade é puramente aditiva.
