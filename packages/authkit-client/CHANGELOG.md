# @adonis-agora/authkit-client

## 0.17.3

### Patch Changes

- f287ade: Widen the `@adonis-agora/*` peer ranges so they survive the peer's next minor.

  Below 1.0.0 a caret does not mean "this minor and up" — it stops at the next
  minor, so `^0.22.0` expands to `>=0.22.0 <0.23.0`. Every sibling package in this
  ecosystem ships minors constantly, which meant **all four** `@adonis-agora/*`
  peers were unsatisfiable against the current release of the package they name.
  Under npm this is not a warning: installing `@adonis-agora/authkit-server`
  alongside `@adonis-agora/durable@0.24.0` failed outright with
  `ERESOLVE — Conflicting peer dependency: @adonis-agora/durable@0.22.0`.

  Each floor was chosen from what the code actually calls, not from what the range
  happened to say:

  | peer                       | was       | now              | why that floor                                                                                                           |
  | -------------------------- | --------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
  | `@adonis-agora/durable`    | `^0.22.0` | `>=0.7.0 <1.0.0` | first release with `ctx.localStep`, absent in 0.6.1                                                                      |
  | `@adonis-agora/media`      | `^0.1.0`  | `>=0.5.0 <1.0.0` | first release exporting the `./single-file` subpath the avatar uploader imports, absent in 0.4.0                         |
  | `@adonis-agora/telescope`  | `^0.1.0`  | `>=0.1.0 <1.0.0` | all five imported types are shape-identical from 0.1.0 through 0.8.1                                                     |
  | `@adonis-agora/resilience` | `^0.1.0`  | `>=0.1.0 <1.0.0` | `wrap()` has existed since 0.1.0, and the policy is duck-typed against a locally declared interface rather than imported |

  The `^0.22.0` on durable in particular came from the `ctx.step` → `ctx.localStep`
  migration and recorded the version current on that day, some fifteen minors above
  what the migration actually required.

  `@adonis-agora/authkit-sdk`'s peer on `@adonis-agora/authkit-server` gains the
  same upper bound (`>=0.10.0 <1.0.0`), which it was missing entirely — it would
  have accepted a future 1.0 with breaking changes.

  A spec now scans every package manifest and fails on a caret or tilde over a 0.x
  `@adonis-agora/*` peer, so this cannot come back quietly.

## 0.17.2

### Patch Changes

- 8f23a85: Ship the module augmentations so they actually reach a consuming app.

  **The client.** `HttpContext.auth` was declared in the package's root `types.ts`,
  and nothing reachable from `build/index.d.ts` referenced that file — so TypeScript
  never loaded it in a host app and `ctx.auth` came back as `Property 'auth' does
not exist on type 'HttpContext'`, no matter what the app imported. Verified
  against packed tarballs in a scratch AdonisJS app across five wiring variants; a
  `/// <reference path>` straight at the built `types.d.ts` type-checked cleanly,
  which isolates it to reachability rather than to the declarations. The
  augmentation is now pulled in by a bare side-effect import from
  `authkit_middleware` — the middleware that actually assigns `ctx.auth`, and the
  one `configure` registers.

  Putting that import in `index.ts` was considered and rejected: apps that hand
  `ctx.auth` to `@adonisjs/auth` through `authkitClientGuard` would then load two
  competing `HttpContext.auth` declarations, and because `skipLibCheck` is on in
  every AdonisJS app the conflict is not reported — one simply wins by include
  order. Anchoring on the middleware keeps the two owners of `ctx.auth` mutually
  exclusive, the same way `@adonisjs/auth` does with its own
  `initialize_auth_middleware`.

  **The server** was a smaller problem than it first looked. Hosts _were_ getting
  `app.container.make('authkit.server')` typed all along, because the service
  provider carried its own copy of the `ContainerBindings` declaration and every
  host registers the provider. What was broken is that `exports["./types"]` pointed
  at the barrel rather than at the built `types.js`, so importing
  `@adonis-agora/authkit-server/types` gave `Property 'authkit.server' does not
exist on type 'ContainerBindings'`.

  Retargeting that subpath exposed a second problem: the root `types.ts` declared
  one binding while the provider declared four, so the newly-live subpath was a
  partial view. Two binding tables with nothing checking they agree is how they
  drifted in the first place, so there is one table now — in `types.ts`, with the
  provider reaching it through a side-effect import.

  **`adonisjs.types` covers neither package.** No version of `@adonisjs/core`,
  `@adonisjs/assembler` or `@adonisjs/application` in this repo's dependency tree
  reads that package.json field. It is an AdonisJS 5 leftover, left alone.

## 0.17.1

### Patch Changes

- 1f15367: Point `homepage` and `bugs.url` at the repository's current name.

  The repository was renamed to `adonis-agora-authkit`; `repository.url` followed,
  `homepage` and `bugs.url` did not. Every package therefore shipped a manifest
  that disagreed with itself, and the "Repository"/"Homepage" links on npm leaned
  on GitHub's rename redirect — which lasts only until someone claims the old
  name. All three fields now name the same repository.

- Updated dependencies [1f15367]
  - @adonis-agora/authkit-core@0.7.1

## 0.17.0

### Minor Changes

- 659862c: Exporta `isAuthkitAdmin`/`authkitDashboardAuthorize`/`authkitDashboardMiddleware` — o gate admin dos dashboards embutidos, pronto pra plugar

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

## 0.16.0

### Minor Changes

- 40bb1a8: Amarra o restore da impersonação à sessão que guardou a credencial, e faz a revogação central levá-la junto

  **Segurança — leia antes de subir. Impersonações EM VOO caem no upgrade** (ver
  "O que acontece no upgrade", no fim).

  Dois defeitos, ambos no `AuthkitClientManager`.

  **A — `stopImpersonating()` restaurava uma credencial que não sabia atribuir.**
  `impersonate()` parqueia o TokenSet INTEIRO do ator — refresh token incluso —
  em `${sessionKey}_impersonator`, e a única conferência do restore era se a chave
  existia. Como nada na lib limpava essa chave, a credencial sobrevivia à sessão
  que a guardou. A cadeia completa: um admin impersona alguém, faz logout, uma
  outra identidade loga no MESMO cookie jar e chama o endpoint de stop — e recebe
  o TokenSet do admin, mantido vivo indefinidamente pelo `maybeRefresh` a cada
  request. Em versões anteriores, **a lib entregava a credencial de impersonação a
  quem ficasse com a sessão depois.**

  **B — a revogação central deixava a credencial parqueada.**
  `BackchannelRevocationMiddleware` fazia `session.forget(sessionKey)` e só. É o
  mecanismo que o operador usa para matar uma sessão de fora, e ele deixava o
  refresh token do ator parqueado no browser. **Nenhum consumidor conseguia
  corrigir isso de fora** — o middleware é da lib. O logout RP-initiated do
  `registerOidcClient` tinha o mesmo furo.

  **O que mudou.** `impersonate()` gera um nonce e escreve o mesmo valor nos dois
  lados: no registro parqueado e dentro do token set ATIVO da sessão
  (`TokenSet.impersonationBinding`). O slot ativo é o único que todo caminho de
  fim-de-sessão já limpa, então uma troca de identidade apaga o vínculo por
  construção — não por convenção. `stopImpersonating()` exige que os dois batam;
  `maybeRefresh` propaga o nonce (renovar o token do alvo não muda a sessão, então
  não pode trancar o ator). Recusa é **fail-closed**: a credencial órfã é
  descartada, nunca devolvida, e o token set da sessão cai junto — uma recusa não
  é uma tentativa a repetir, e ninguém fica preso impersonando. Revogação
  back-channel e logout passaram a usar `manager.endSession(ctx)`, o único ponto
  que conhece as duas chaves.

  E o callback de login passou a usar `manager.startSession(ctx, tokenSet)`, o par
  de `endSession()`. Recusar o restore já fecha o roubo, mas recusar é só não
  DEVOLVER: com um `session.put(sessionKey, …)` cru, o refresh token do ator
  continuava serializado no cookie de sessão da identidade nova até a sessão
  expirar. Não devolver e não guardar são coisas diferentes, e é a segunda que
  sustenta a invariante — a credencial parqueada nunca sobrevive à sessão que a
  parqueou. Aplicações que escrevem o token set em `sessionKey` por conta própria
  num fluxo de login devem chamar `startSession()` no lugar.

  **Limite honesto**, também no docblock: quem controla o cookie jar DURANTE uma
  impersonação ativa continua indistinguível do ator — é literalmente a mesma
  sessão. Isso é o modelo de sessão, não esta conferência. O que fecha é a janela
  em que a credencial sobrevive à sessão que a guardou.

  **O que acontece no upgrade.** Uma sessão parqueada por uma versão anterior não
  tem vínculo nenhum — é exatamente a credencial que não dá para atribuir.
  `stopImpersonating()` a **recusa e descarta**, e limpa o token set da sessão. Na
  prática: **todo admin que estiver impersonando alguém no momento do deploy é
  deslogado e precisa entrar de novo.** Nenhum outro usuário é afetado, e não
  sobra nada a fazer depois do primeiro ciclo de requests.

  A alternativa (restaurar uma vez com aviso) foi descartada: seria devolver
  justamente a credencial deste aviso a justamente a parte que não conseguimos
  identificar, e num cookie session store "uma vez" é por cookie jar — o atacante
  também ganharia a dele. O custo do fail-closed é um login de admin; o da
  leniência é manter o furo aberto por uma sessão inteira.

  **API.** Nada removido. Novo `AuthkitClientManager.endSession(ctx)` (use no
  lugar de `session.forget(sessionKey)` se o seu app derruba a sessão à mão) e
  novo campo opcional `TokenSet.impersonationBinding` — gerenciado pela lib; não
  escreva nele. Se o seu app escreve o TokenSet direto no `sessionKey` (ex.: um
  refresh próprio), preserve esse campo, senão um stop legítimo será recusado
  (fail-closed: o ator é deslogado, não travado).

## 0.15.0

### Minor Changes

- 618d83f: `authkitClientGuard()`: um guard de verdade do `@adonisjs/auth` (opt-in)

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
     import { defineConfig } from "@adonisjs/auth";
     import { sessionUserProvider } from "@adonisjs/auth/session";
     import { authkitClientGuard } from "@adonis-agora/authkit-client";

     export default defineConfig({
       default: "web",
       guards: {
         web: authkitClientGuard({
           provider: sessionUserProvider({
             model: () => import("#models/user"),
           }),
         }),
       },
     });
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

## 0.14.0

### Minor Changes

- 4a3be7a: Adiciona o acessor singleton `@adonis-agora/authkit-client/services/main` (convenção `services/main` do
  Adonis, como `db`/`mail`/`drive`). Deixa o app usar
  `import authkit from "@adonis-agora/authkit-client/services/main"` e ler `authkit.clientConfig` / chamar
  `authkit.getIdToken(ctx)`, `authkit.handleBackchannelLogout(ctx)` etc., em vez de resolver a binding
  string-keyed `"authkit.client"` pelo container na mão (`ctx.containerResolver.make("authkit.client")`).
  Funciona tanto em controllers-classe quanto em route handlers inline.

## 0.13.0

### Minor Changes

- 960f39e: `Authenticator.getUserOrFail(): Promise<TUser>` — o usuário autenticado NÃO-nulo, fail-closed (lança quando não há sessão ou `resolveUser` não devolve usuário). Espelha `authenticate()` (que devolve a `Identity`); este devolve o usuário do app.

  Substitui o wrapper `currentUser(auth)` que cada app reescrevia sobre `getUser()`:

  ```ts
  // antes (helper por app):
  const user = await currentUser(auth);
  // agora:
  const user = await auth.getUserOrFail();
  ```

  Com o generic na augmentation (`auth: Authenticator<AppUser>`), devolve `AppUser` direto, sem cast. Para rotas com visitante, siga usando `getUser()` (`TUser | null`).

## 0.12.0

### Minor Changes

- c016a62: `Authenticator` agora é genérico no tipo do usuário do app: `Authenticator<TUser = unknown>`, com `getUser(): Promise<TUser | null>` e `toSharedProps().user: TUser | null`. Non-breaking (default `unknown` mantém o comportamento anterior). Um app fixa o tipo augmentando `HttpContext.auth` (`auth: Authenticator<AppUser>`) e aí `getUser()` devolve `AppUser | null` em todo call-site — acaba o `(await auth.getUser()) as AppUser` repetido. A asserção do model do app fica UMA vez, dentro de `getUser`, em vez de espalhada.

## 0.11.0

### Minor Changes

- c12bac9: `authkit-client` now only authenticates — app-role/authorization concerns moved out to
  `@adonis-agora/authz`.

  Removed:

  - `AuthenticatorDeps.resolveAppRoles`, `Authenticator.hasAppRole`/`getAppRoles`.
  - `appRoles`/`abilities` from `Authenticator.toSharedProps()` — it now returns
    `{ user, globalRoles }`.
  - `ClientConfigInput.resolveAppRoles`/`ResolvedClientConfig.resolveAppRoles` (`defineConfig`).
  - `AuthMiddlewareOptions.roles`/`unauthorizedRedirect` — the built-in `auth_middleware` now only
    requires a valid session (redirects to `options.redirectTo ?? '/auth/login'` when absent). Use
    `@adonis-agora/authz` (or Bouncer) on the route for role/permission gating.
  - `PostLoginRedirects.byAppRole` in `registerOidcClient` — `byGlobalRole` (claims from the token)
    and `default` still work; the `resolveDestination` helper no longer takes an `authenticator`.

  Kept: `hasGlobalRole`, `getIdentity` (still populates the Agora context), `getUser`,
  `authenticate`, `check` — these read from the token/session, not from app-defined roles.

## 0.10.1

### Patch Changes

- 70f5721: Ship peer dependencies as ranges instead of exact versions

  `peerDependencies` pointed at the pinned `adonis`/`frontend` catalogs, and pnpm
  inlines a catalog's literal value at publish time — so every published peer came
  out exact. `@adonis-agora/authkit-server@0.34.1` on npm requires
  `"@adonisjs/core": "7.3.3"`, which no app on 7.3.5 can satisfy;
  `@adonis-agora/authkit-react@0.13.0` requires `"react": "19.2.6"`, which locks
  out every consumer not on that exact patch.

  Peers now resolve from three new range-only catalogs (`adonisPeers`,
  `frontendPeers`, `miscPeers`). Dependencies keep the pinned catalogs — a pin is
  right for reproducible installs and wrong for consumer compatibility, and the
  two were sharing one source.

  No source or runtime behaviour changes.

## 0.10.0

### Minor Changes

- 12df185: Write `globalRoles` into the @agora context from the resolved session (so the Authz global-role bridge can read them), and add Authz permission gating to authkit-react: `useCan(permission, resource?)` and `<CanPermission>`, which consult the Authz `POST <canPath>` endpoint (`{ permission, resource? }` → `{ allowed }`, credentials included) with in-memory caching/dedupe. The endpoint path is configurable via `AuthkitProvider` (`canPath` / `endpoints.can`, default `/authz/can`).

## 0.9.0

### Minor Changes

- 394b9aa: Bridge audit events to the @agora diagnostics bus; populate @agora context from the resolved session
- 0542665: Re-scope to @adonis-agora/authkit-\* (join the Agora ecosystem)
- 08e721e: Optional resilience policy for outbound OIDC/JWKS calls

### Patch Changes

- Updated dependencies [0542665]
  - @adonis-agora/authkit-core@0.7.0

## 0.8.0

### Minor Changes

- dd80bb8: Segurança (least privilege): a claim de papéis globais e as claims de organização saem do scope `profile` para um scope dedicado `roles`, e sua emissão é gated a clients first-party (`branding.firstParty`). Clients third-party NÃO recebem papéis/org, mesmo solicitando o scope `roles`. O default de scopes do authkit-client passa a incluir `roles` (consumidores first-party continuam recebendo papéis sem mudança de comportamento). BREAKING para quem dependia de papéis no scope `profile`: o client precisa solicitar o scope `roles`.

## 0.7.2

### Patch Changes

- Updated dependencies [93eaf69]
- Updated dependencies [e2582b8]
  - @adonis-agora/authkit-core@0.6.0

## 0.7.1

### Patch Changes

- Updated dependencies [df4b41f]
  - @adonis-agora/authkit-core@0.5.0

## 0.7.0

### Minor Changes

- 68a8f4c: `lucidRevocationStore` agora faz auto-prune — limpeza vem da lib, não do app

  Antes, o app precisava agendar o `prune()` das revogações de back-channel logout
  (scheduler/job). Agora o `lucidRevocationStore` limpa sozinho: no `revoke()`, de
  forma OPORTUNÍSTICA e throttled (no máx. 1× por `everyHours` por processo, default
  24h), remove revogações mais velhas que `olderThanDays` (default 35). Best-effort —
  falha não atrapalha o logout.

  - Default LIGADO; configure via `lucidRevocationStore({ autoPrune: { everyHours, olderThanDays } })`.
  - Desligue com `autoPrune: false` (ex.: se preferir agendar você mesmo).

  Resultado: o consumidor não precisa mais de nenhum scheduler/job para a limpeza.

## 0.6.0

### Minor Changes

- 262eb79: Back-Channel Logout pronto para sessões cookie-based + DX do client

  Antes, fechar o gap de logout SSO em sessão cookie-based exigia escrever model + service + middleware à mão em cada app (e era fácil esquecer — deixando a sessão válida por até 30 dias após um logout SSO). Agora o AuthKit absorve isso:

  **`@adonis-agora/authkit-client`**

  - `lucidRevocationStore({ connection?, table? })` + interface `RevocationStore`: persistência append-only de revogações (sid/sub/revoked_at), sem precisar declarar model.
  - `BackchannelRevocationMiddleware` (subpath `/backchannel_revocation_middleware`): derruba a sessão revogada na próxima request.
  - `defineConfig({ backchannelLogout: { store } })`: deriva o `onBackchannelLogout` e expõe o store ao middleware.
  - `lucidMirror(Model, { sync, preload, injectGlobalRoles })`: factory do `resolveUser` "espelho local".
  - Middlewares prontos `auth_middleware` (com `roles`) e `silent_auth_middleware` (subpaths).
  - `buildAuthorizeUrl({ extraParams })`: anexa `audience`/`prompt`/`login_hint`/etc. sem manipular URL na mão.
  - `Authenticator.toSharedProps()`: `{ user, globalRoles, appRoles, abilities }` pronto p/ Inertia share.
  - `AuthkitClientManager.impersonate()` / `stopImpersonating()` / `isImpersonating()`: ciclo de impersonação (RFC 8693) gerenciado.
  - `registerOidcClient(router, { redirects, afterLogin, loginMiddleware })`: registra login/callback/logout (+back-channel) absorvendo PKCE/state/exchange/redirect-por-papel do OidcSessionController.

  **`@adonis-agora/authkit-server`**

  - Tabela `auth_session_revocations` gerenciada pelo `ensureAuthkitSchema()` (schema auto-manage) — compartilhável entre apps no mesmo banco.
  - Revogação em massa do admin (`AdminSessionsService.revokeAll`) grava uma revogação `sub` na tabela compartilhada → logout INSTANTÂNEO nos clients cookie-based (antes esperava o refresh token falhar, ~TTL do access token).
  - **Config locks (BREAKING semântico):** settings definidas no `defineConfig` ficam TRAVADAS — config vence e a UI/Admin API não pode alterá-las (`getSetting` → null p/ resolvers caírem no config; `setSetting`/`deleteSetting` → 423 `SettingLockedError`). O console mostra badge "definido via config" e desabilita o controle. Exports: `isSettingLocked`, `lockedSettingKeys`, `deriveLockedSettingKeys`, `SettingLockedError`.
  - **`encrypter` do TOTP agora é DEFAULT (BREAKING):** `lucidAccountStore` encripta o segredo TOTP com `APP_KEY` por padrão (`appKeyEncrypter()`); `encrypter: false` desliga. ⚠️ Segredos gravados em claro por versões anteriores deixam de decriptar — migre ou passe `false`.
  - `jwks: 'auto'` — resolve env-aware (`AUTHKIT_JWKS` inline, senão managed em arquivo); elimina o ternário no config.
  - `adminApi.apiKeys: 'env'` (lê `AUTHKIT_ADMIN_API_KEY`) + `enabled` auto quando há key — elimina o spread condicional.
  - `lucidStores({ account, pat, audit, providerIdentity, webauthnCredential, organizations }, { mfaIssuer, webauthn })`: monta os stores declarando mfaIssuer/webauthn UMA vez.
  - `defineConfig` reusa `mfaIssuer`/`webauthn` do `lucidAccountStore` quando o top-level não os fornece (declare uma vez).
  - `authkitCsrfExceptions(url, { mountPath })`: helper de isenção CSRF das rotas machine-to-machine.
  - **`registerAuthHost(router)` sem opts** — lê mountPath/social/rateLimit/admin/adminApi do `config/authkit.ts` (stash no boot do provider, que roda antes do preload do routes.ts). Acaba com o drift config↔registerAuthHost; `opts` viram só override (ex.: `{ admin: { prefix } }`). Fallback p/ defaults quando não há stash (testes).

## 0.5.0

### Minor Changes

- a6ca8a7: Bring your own IdP — use AuthKit against any OIDC-compliant provider
  - **client**: new `discoverEndpoints(issuer)` resolves the IdP's real endpoints from `/.well-known/openid-configuration` (cached per issuer, field-level manual overrides, silent fallback to the oidc-provider conventions when the document is unreachable). All flow helpers (`buildAuthorizeUrl`, `exchangeCode`, `refreshTokens`, `exchangeToken`, `buildEndSessionUrl`) now accept explicit endpoint params — Keycloak, Auth0, Okta, Entra et al. work out of the box.
  - **react**: new `idp: 'authkit' | 'external'` config on `AuthkitProvider`. With an external IdP, the components that depend on authkit-server's REST surface (`UserProfile`, `OrganizationSwitcher`, `OrganizationProfile`, `AuthorizedApps`) degrade to `null` instead of calling endpoints that don't exist; sign-in/out, auth state, role gates and the password strength meter keep working.
  - New "Bring your own IdP" docs page tying the two together.

## 0.4.2

### Patch Changes

- Updated dependencies
  - @adonis-agora/authkit-core@0.4.0

## 0.4.1

### Patch Changes

- Updated dependencies
  - @adonis-agora/authkit-core@0.3.1

## 0.4.0

### Minor Changes

- Round 7 — production pack + multi-tenancy:
  - **Organizations (multi-tenancy)**: optional capability-probed tables (`auth_organizations`, `auth_organization_members`, `auth_organization_invitations`), per-org roles (owner/admin/member), email invitations with hashed tokens, active-org session cookie with `org_id`/`org_slug`/`org_role` claims in id_token/userinfo/JWT access tokens, `/account/orgs` page, admin console section, Admin REST API (`/api/authkit/v1/organizations`), SDK `organizations.*` namespace (remote + embedded), React `useOrganizations`/`useOrganization`/`useSwitchOrganization`/`useOrgInvitations` hooks plus `<OrganizationSwitcher />` and `<OrganizationProfile />` components.
  - **LGPD/GDPR compliance**: self-service and admin account deletion with full cascade (sessions, grants, PATs, passkeys, identities, MFA, avatar) and audit anonymization (stable pseudonym), data export endpoint (`GET /account/security/export`), `login.requireVerifiedEmail` gate across password/magic-link/passkey flows, SDK `users.delete()`.
  - **User migration & password hygiene**: transparent lazy password rehash on login, `password.legacyVerifier` hook for foreign hash formats, `authkit:users:import` ace command (JSON/NDJSON, `--dry-run`), configurable `password.policy`, HaveIBeenPwned k-anonymity breach check (fail-safe), React `usePasswordStrength` + `<PasswordStrengthMeter />`.
  - **JWT access tokens (RFC 9068)**: `accessTokens: { format: 'jwt' }` with per-resource overrides, `verifyJwtAccessToken` local validation in the client package, `authkit:keys:rotate` command with grace-period JWKS rotation.
  - **Bot protection**: pluggable vendor-agnostic `botProtection` config (Turnstile/hCaptcha-ready, fail-safe) on login/signup/reset.
  - **New-device login notification**: `notifications.newDeviceEmail` + `mail.onNewDeviceLogin` hook driven by the trusted-device signal.
  - **Console polish**: session context (user-agent/OS/IP/geo via pluggable `resolveGeo`), RFC 8693 impersonation panel (`admin.impersonation`, default off), dashboard with MAU/daily sign-ins, `GET /api/authkit/v1/stats` + SDK `stats()`.

### Patch Changes

- Updated dependencies
  - @adonis-agora/authkit-core@0.3.0

## 0.3.0

### Minor Changes

- 0c33640: Round 4 — events/webhooks, DPoP client, full e2e harness, polish.

  **server (minor):** add `events` config — observe every audit event in-process (`onEvent`)
  and/or via an HMAC-signed webhook (`x-authkit-signature: sha256=...`, 5s fire-and-forget,
  never throws into the request path). When set, the resolved `audit` sink becomes a fan-out
  (original sink + onEvent + webhook), preserving the admin `list()` query. Also: a full
  interaction e2e harness driving login → consent → token (plus step-up MFA and device-flow
  variants) through the real host controllers, and English `authkit:doctor` messages. Builds on
  the existing consent/account-console, admin user CRUD, profile self-service, trusted-device,
  and passwordless (magic-link / passkey-first) features.

  **client (minor):** add DPoP (RFC 9449) proof generation — `generateDpopKeyPair()` (jose
  ES256, exportable JWK) and `createDpopProof({ key, htm, htu, nonce?, accessToken? })` producing
  a signed `dpop+jwt`, plus `dpopJwkThumbprint()`.

## 0.2.1

### Patch Changes

- Updated dependencies [1872a30]
  - @adonis-agora/authkit-core@0.2.0

## 0.2.0

### Minor Changes

- Refactors do code review (comportamento preservado, contratos mais limpos):

  **server (minor):**

  - `AccountStore` decomposto em interfaces de capacidade (`CoreAccountStore`,
    `MfaCapability`, `WebauthnCapability`, `ProviderIdentityCapability`) com type
    guards (`supportsMfa`/`supportsPasskeys`/`supportsProviderIdentity`). O tipo
    `AccountStore` continua existindo (core & Partial<capacidades>) — compatível.
    `lucidAccountStore` agora OMITE os métodos de capacidades não configuradas em
    vez de lançar em runtime; social login sem provider-identity degrada pro login.
  - Sequência login+lockout centralizada em `attemptPasswordLogin` (era duplicada
    em 2 controllers).
  - `adminGuard` agora retorna 404 quando `admin.enabled: false` (fecha bypass de
    drift entre config e `AuthHostOptions.admin`).
  - `dynamicRegistration.management: true` sem `enabled: true` agora falha no
    resolve do config (RFC 7592 exige 7591).
  - Serialização JSON dos mixins unificada em `jsonColumn()` (semântica por coluna
    preservada).

  **client (minor):**

  - POST ao token endpoint unificado (`exchangeCode`/`refreshTokens`/`exchangeToken`).
  - Introspection + claims→Identity compartilhados entre resolvers; `pat`/`opaque`
    agora também mapeiam `picture→profile.avatarUrl` e `sid→sessionId` (alinhados
    ao `jwt`).

  **react (patch):**

  - Helpers genéricos de roles; warn de dev no `useAuth` quando não há
    `AuthProvider` nem shared prop do Inertia.

## 0.1.1

### Patch Changes

- Corrige os stubs de scaffolding (`node ace configure`):
  - Usa os nomes renomeados dos pacotes (`@adonis-agora/authkit-*`) — antes os
    stubs ainda importavam de `@authkit/*` (inexistente), gerando código quebrado.
  - O model `AuthUser` scaffoldado passa a usar a **conexão default da aplicação**
    (config/database.ts) por padrão, em vez de forçar `static connection = 'auth'`.
    Para isolar o AuthKit num schema/banco dedicado, basta definir a conexão no
    model — documentado no próprio stub. A lib cria as tabelas no banco do app, ou
    onde o dev definir.
