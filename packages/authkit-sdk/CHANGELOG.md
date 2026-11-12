# @adonis-agora/authkit-sdk

## 1.0.0-rc.2

### Patch Changes

- [#473](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/473) [`427c4a3`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/427c4a301907dc78d8e7c5405d4e73e29b8a2be4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Every table AuthKit owns now uses one Lucid connection: `schema.connection` (default: the primary connection). Before, some of them followed other connections, so with the account model on a named connection the boot created a table on one connection and the code read it on another:
  
  - `auth_settings` (runtime settings, the settings CLI, `authkit:expire-scan`, the SDK's embedded driver) followed the account model's connection.
  - `auth_mfa` and `auth_password_history` used the account model's connection.
  - The built-in organization models had no connection, so they always used the primary one.
  - `adapters.database()` and the `lucid` keystore without their own `connection` used the primary connection.
  
  They all use `schema.connection` now; `adapters.database({ connection })` and `jwks.store: { driver: 'lucid', connection }` still win when set. The app's account table stays on the account model's connection, and the boot adds the `login_methods` column there. If your app had `schema.connection` unset and the account model on a named connection, those tables move to the primary connection: set `schema.connection` to the connection where they already are.

## 1.0.0-rc.1

### Minor Changes

- [#460](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/460) [`1858ee8`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/1858ee837bb4edcf0578f86d224693ac9a86a495) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Service tenants: a client can act as one partition of another service, such as a durable control plane.
  
  - `serviceTenants: { resources: { 'urn:agora:durable': { expiresIn: 600 } } }` in `config/authkit.ts` declares the resources (RFC 8707) that issue service-tenant tokens: JWT access tokens (RFC 9068) with `aud` = the resource and the client's `partition` and `capabilities` as claims.
  - A service-tenant client is confidential, uses only `client_credentials` and has no redirect URIs. Create and edit it from the console (**Service tenant** kind), the Admin API and the SDKs (`serviceTenant: { partition, capabilities? }`), or `node ace authkit:clients:create --partition=acme --capability=reports`.
  - Any client can now be disabled and enabled again (console, `POST /clients/:id/disable|enable`, SDK `clients.disable/enable`): the token endpoint answers `invalid_client` from the next request on.
  - `authkitTenantVerifier()` (authkit-server) verifies those tokens against the local issuer and keys and returns `{ tenant, capabilities }`; `authkitTenantToken({ issuer, clientId, clientSecret, resource })` (authkit-client) fetches, caches and refreshes them on the tenant side. Both fit durable's `verifyTenant` and `tenant.token` as a function or a class, without depending on durable.
  - New audit events: `client.disabled`, `client.enabled`, `service_tenant.token_issued`.
  - Access-token verification (`oidcBearerGuard`, in-process and remote) now refuses a token whose `sub` is a client (a `client_credentials` token), so a service-tenant token never authenticates a user.

## 1.0.0-rc.0

### Major Changes

- [#436](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/436) [`c942fe3`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/c942fe30483346217c9c89112e13db0d4a65c647) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - AuthKit 1.0. See the [Migrating to 1.0](https://github.com/DavideCarvalho/adonis-agora-authkit/blob/main/apps/docs/content/docs/migrating-to-1-0.mdx) guide.
  
  Breaking changes (`@adonis-agora/authkit-server`):
  
  - `withMfa` is removed. MFA state lives in the lib-owned `auth_mfa` table, so drop the mixin from your `AuthUser` model's `compose(...)`.
  - `markSudo` is no longer exported. Grant sudo with `completeSudo(sudoContextFrom(ctx), methodId)`, which also writes the `sudo.confirmed` audit event, remembers the method and redirects to the validated `return_to`.
  - The email-change confirmation link is sent through `mail.onEmailChangeConfirm` only. Without it, AuthKit sends its built-in email; `onEmailVerification` no longer receives email-change confirmations.
  - The `clients` option of `defineConfig` is removed. Create clients in the admin console, through the Admin API or with `node ace authkit:clients:create` (new `--client-secret` flag keeps an existing secret). `buildImpersonationPanel(cfg, targetId, clients)` now requires `clients`, and the impersonation curl always shows the `<CLIENT_SECRET>` placeholder.
  - `inertiaRenderer({ prefix, views })`: `views` is required. Screens not listed render with the built-in Edge view. `AuthkitScreen` is now the exact union of the screens AuthKit renders (adds `throttled`, `agents/consent`, `agents/done`; no arbitrary strings), and every screen's props are exported: `AuthkitScreenProps['<view>']` plus named types (`LoginProps`, `SessionExpiredProps`, …). The controllers are checked against them. Hosts declare screens of their own by augmenting `AuthkitScreenProps` (`declare module '@adonis-agora/authkit-server'`).
  - The Admin API client body reads `grantTypes` only; the `grants` alias is gone (responses still return `grants`).
  - `lucidAccountStore` always mounts password history over the model's connection (`auth_password_history`).
  - `/account/orgs/json`, `/account/orgs/invitations/json` and `/account/orgs/:id/json` are removed; use `/account/api/orgs/*`.
  - `GET /account/api/apps` entries gain `name` and `logoUrl`.
  
  - The admin console reads its config from a `<script type="application/json" id="authkit-admin-config">` data block (CSP-safe) instead of an inline `window.__AUTHKIT__` script; the dev fallback is gone.
  - The admin client DTO returns `grantTypes` (was `grants`), plus `clientName` and `logoUri`, which the console and the Admin API can now set (`null` removes them, as it does `backchannelLogoutUri`). `GET {admin}/api/clients/:id` exists.
  - Anonymous JSON callers of the admin and account JSON APIs get `401` (and `403` without an admin role) instead of a redirect to the login page.
  - Fixes: the Redis adapter's `list()` honours the connection `keyPrefix` (sessions, apps and admin lists were empty); a password login posted without a password is an invalid-credentials answer, not a 500.
  
  Breaking changes (`@adonis-agora/authkit-core`):
  
  - `ClientConfig` and `ResolvedAuthServerConfig.clients` are removed.
  
  Breaking changes (`@adonis-agora/authkit-client`):
  
  - `@adonisjs/auth` is a required peer. `ctx.auth` is `@adonisjs/auth`, backed by the AuthKit session through `authkitClientGuard`; `ctx.authkit` (from `authkit_context_middleware`) carries the AuthKit-only data (identity, `hasGlobalRole`, active org, `toSharedProps`).
  - `authkit_middleware`, `auth_middleware` and `silent_auth_middleware` (and their subpaths) are removed: `ctx.auth` comes from `@adonisjs/auth`, and `middleware.auth()` / `silentAuth` are the `#middleware/auth_middleware` / `#middleware/silent_auth_middleware` files `node ace configure` publishes. `require_org_middleware` stays. `@adonis-agora/authkit-client/types` no longer declares `HttpContext.auth`; type `ctx.authkit.getUser()` through the `AuthkitUserType` interface.
  - `node ace configure @adonis-agora/authkit-client` installs `@adonisjs/auth` when missing (`--no-install` prints the command), writes `config/auth.ts` with `authkitClientGuard` + `sessionUserProvider` (`--model`, default `#models/user`; an existing file is left alone and the guard to add is printed), registers `@adonisjs/auth/auth_provider`, `initialize_auth_middleware` + `authkit_context_middleware`, and publishes the named `auth` / `silentAuth` middleware.
  - `authkitClientGuard` takes its user from `resolveUser` when one is configured (so `lucidMirror` provisions the row on first login, and what it loads is on `ctx.auth.user`, the same instance as `ctx.authkit.getUser()`), with the provider as the fallback.
  - New `authkitIdentityProvider()`: a user provider with no database; `ctx.auth.user` is the AuthKit `Identity`.
  - New `authkitClientGuard({ provider, resolver })` option: a per-guard resolver for API routes (bearer JWT, opaque, PAT).
  - `resolvers.jwt({ tokenSource: 'bearer' })` accepts `Authorization: DPoP <jwt>` with a valid `DPoP` proof for `cnf.jkt`-bound tokens, and refuses DPoP-bound tokens sent as `Bearer`.
  - `UnauthorizedAccessConstructor` is no longer exported, and `AuthkitClientGuard` no longer takes an exception class; it always throws `@adonisjs/auth`'s `E_UNAUTHORIZED_ACCESS`.
  
  Breaking changes (`@adonis-agora/authkit-sdk`):
  
  - `clients.*` return `grantTypes` (was `grants`), plus `clientName` and `logoUri`.
  
  Breaking changes (`@adonis-agora/authkit-react`):
  
  - `createAuthkitClient()` no longer reads `window.__AUTHKIT__`: pass `baseUrl` for `client.admin.*` and `csrfToken`.
  - Admin response types match the server: `users.remove` / `clients.remove` → `{ ok, deleted }`, `users.resetPassword` → `{ ok, email }`, `users.disable` / `enable` → the user, `SettingListResult.locked`; `AdminClient.grants` → `grantTypes` (+ `clientName`, `logoUri`); `UpdateUserInput` is `{ globalRoles? }`, `CreateUserInput` takes no `null`.
  - New: `client.account.agents.list()` / `revoke()`, `useAccountAgentsQueryOptions`, `useRevokeAccountAgentMutationOptions`.
  - Peers: `react` / `react-dom` `^19.0.0`, `@inertiajs/react` `^2.0.0 || ^3.0.0`.
  
  - `useProfile`, `useSessions`, `useAuthorizedApps`, `useOrganizations`, `useOrganization`, `useOrgInvitations`, `useSwitchOrganization` and their types are removed, with the `profile`, `sessions`, `apps`, `orgs` and `orgInvitations` keys of `endpoints`. Use the query options (`useMeQueryOptions`, `useAccountSessionsQueryOptions`, `useAppsQueryOptions`, `useAccountOrgsQueryOptions`, …).
  - `UserProfile`, `AuthorizedApps`, `OrganizationSwitcher` and `OrganizationProfile` need `QueryClientProvider` and `AuthkitClientProvider`.
  
  All packages:
  
  - `@adonis-agora/*` peer ranges accept 1.x and its release candidates (`<2.0.0 || >=1.0.0-rc.0 <2.0.0`): `durable`, `media`, `telescope` (authkit-server), `resilience` (authkit-client), `authkit-server` (authkit-sdk).
  - Node.js `>=24` is required (tested on 24 and 26).

## 0.8.0

### Minor Changes

- [#269](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/269) [`b0ca480`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/b0ca4802419aba93a9f913775f697cc4075cff88) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Drop Node 20, which reached end-of-life on 2026-04-30, and Node 22, which AdonisJS 7 does not support (it requires Node >=24): `engines.node` is now `>=24`. The supported Node lines are 24 and 26, and CI runs the test suite on each of them.

## 0.7.2

### Patch Changes

- [#255](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/255) [`481051c`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/481051c86c67b2bf5026f7a49028d260236667c9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Publish peer dependencies as ranges again (`^7.5.0` instead of `7.5.0`, etc.). A Renovate pinning pass had turned the peer catalogs into exact versions, so any upstream patch release (e.g. `@adonisjs/core` 7.5.1) fell outside the accepted peer range.

## 0.7.1

### Patch Changes

- [#230](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/230) [`4e424bf`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/4e424bf18f8c0cea30ae1352056b2017f661510d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - O claim de organização passa a refletir a membership atual, e remover um membro revoga o acesso na hora
  
  O `org_id`/`org_slug`/`org_role` do token vinha do `activeOrg` gravado no `Grant` no
  consent, e o refresh o reemitia **sem perguntar se a conta ainda era membro** da org,
  nem se a org ainda existia. Com refresh token de 30 dias, quem era removido da equipe
  seguia recebendo token com o claim da org por até um mês — e um rebaixado seguia com
  o papel antigo.
  
  - **Emissão/refresh:** antes de emitir `org_*`, a lib confere no account store que a
    conta ainda é membro da org (`getOrgMembership`) e que a org existe (`findOrgById`).
    Se não for, o token sai **sem** claims de org. `org_role` é sempre o papel **atual**
    da membership e `org_slug` o slug atual — nunca o retrato do consent. O
    `resolveTokenRoles` recebe o `activeOrg` já conferido.
  - **Remoção:** sair da org, remover um membro (form `/account/orgs`, `/account/api/orgs`,
    console admin e Admin API) ou apagar a org revoga os grants que carregam aquela org
    para aquela conta (ou para todas, no `deleteOrg`), com os access/refresh tokens deles,
    e grava a revogação por `sub` para clients cookie-based. Grants de outras orgs e sem
    org ficam intactos. Novo método `AdminSessionsService.revokeOrgGrants(orgId, accountId?)`.
    O driver embedded do `@adonis-agora/authkit-sdk` (`organizations.delete`,
    `organizations.members.remove`) revoga do mesmo jeito.
  
  Mudança de comportamento: um store sem `findOrgById`/`getOrgMembership` não tem como
  conferir a membership, então deixa de emitir `org_*` (antes emitia o que viesse do
  cookie/grant). As rotas que gravam o cookie de org só existem com a capacidade.

## 0.7.0

### Minor Changes

- 9231887: **BREAKING (0.x minor):** todas as listagens paginadas do authkit passam a usar `{ page, size }` no lugar de `{ page, limit }` (e de `perPage`, na API do console), alinhando a interface de paginação com `@adonis-agora/filter` e com o restante do ecossistema `@adonis-agora/*`. `page` continua **1-based** com default `1`; `limit` foi apenas **renomeado** para `size` — a semântica (itens por página) não mudou. O casamento com `@adonis-agora/filter` é **estrutural** de propósito: nenhum pacote passa a depender dele.
  
  Na **resposta**, as mesmas listagens passam a devolver o envelope `{ meta, data }` — com `page`, `size` e `total` dentro de `meta` — no lugar do antigo shape achatado `{ data, total, page, size }`. `meta` é a convenção do próprio `.paginate()` do Lucid (`{ meta, data }`), que é onde o caminho por offset de `@adonis-agora/filter` desemboca, e agora é o envelope de TODAS as listagens paginadas do ecossistema `@adonis-agora/*`.
  
  Junto vem um **teto de `size`** que antes não existia de forma unificada: toda borda HTTP (Admin REST API e API JSON do console) agora corta `size` em `ADMIN_LIST_MAX_SIZE` (200), e as varreduras internas usam `ADMIN_LIST_DEFAULT_SIZE` (100) em vez de um `100` hardcoded por serviço.
  
  ### O que mudou
  
  - **Wire HTTP** — `GET {adminApi}/users`, `GET {adminApi}/audit`, `GET {consolePrefix}/api/users` e `GET {consolePrefix}/api/audit` leem `?page=&size=` (antes `?page=&limit=`; o de usuários do console lia `?perPage=`) e respondem `{ meta: { page, size, total }, data }` (antes `{ data, total, page, size }` achatado). Endpoints de listagem NÃO paginados (`/clients`, `/settings`, `/organizations`, `/roles`, `/sessions`) continuam como estão — eles nunca tiveram metadados de paginação e não ganham envelope agora.
  - **Tipos do servidor** — `ListAccountsParams.limit` → `.size` e `ListAuditParams.limit` → `.size`. Stores de conta e sinks de auditoria customizados precisam ler o novo campo.
  - **SDK** (`@adonis-agora/authkit-sdk`) — `ListUsersParams` e `ListAuditParams` passam a usar `size`; `ListUsersResult` e `ListAuditResult` viram `{ meta: ListMeta; data: T[] }` (novo tipo `ListMeta` exportado), nos dois drivers (remoto e embedded).
  - **React** (`@adonis-agora/authkit-react`) — `client.admin.users.list()`, `client.admin.audit.list()`, `useUsersQueryOptions()`, `useAuditQueryOptions()` e as query keys `authkitKeys.admin.users/audit` passam a usar `size`; `AdminUserListResult` e `AuditListResult` viram `{ meta: ListMeta; data: T[] }` (novo tipo `ListMeta` exportado). Efeito colateral: o console admin enviava `limit=` para um endpoint que lia `perPage`, então o tamanho de página pedido pela UI era silenciosamente ignorado — agora vale.
  - **Novas constantes exportadas** — `LIST_FIRST_PAGE`, `ADMIN_LIST_DEFAULT_SIZE` (100), `ADMIN_LIST_HTTP_DEFAULT_SIZE` (20), `ADMIN_LIST_MAX_SIZE` (200), mais os helpers `resolveListPage`, `normalizeListSize`, `clampListSize`, `parseListPage` e `parseListSize` (o SDK reexporta as três primeiras constantes com os mesmos nomes).
  - **Novos tipos exportados** — `ListMeta` (`{ page, size, total }`) e `PaginatedResponse<T>` (`{ meta, data }`) em `@adonis-agora/authkit-server`; `ListMeta` também em `@adonis-agora/authkit-sdk` e `@adonis-agora/authkit-react`.
  - **Inalterado** — o contrato INTERNO dos stores continua `Paginated<T> = { data, total }`: `AccountStore.listAccounts()` e `AuditSink.list()` NÃO ganham envelope `meta` (quem monta o `meta` é a borda HTTP/SDK). Implementações customizadas de store/sink só precisam da renomeação `limit` → `size`.
  
  ### Migração
  
  ```diff
    // HTTP
  - GET /api/authkit/v1/users?page=2&limit=50
  + GET /api/authkit/v1/users?page=2&size=50
  
    // HTTP — resposta
  - { "data": [...], "total": 137, "page": 2, "size": 50 }
  + { "meta": { "page": 2, "size": 50, "total": 137 }, "data": [...] }
  
    // SDK
  - const { data, total, page, limit } = await authkit.users.list({ page: 2, limit: 50 })
  + const { data, meta } = await authkit.users.list({ page: 2, size: 50 })
  + // meta.page / meta.size / meta.total
  
    // React
  - useUsersQueryOptions({ search, page, limit: 20 })
  + useUsersQueryOptions({ search, page, size: 20 })
  - const total = data?.total ?? 0
  + const total = data?.meta.total ?? 0
  
    // AccountStore / AuditSink customizados
  - async listAccounts({ search, page = 1, limit = 20 }: ListAccountsParams) {
  -   return { data: rows.slice((page - 1) * limit, page * limit), total }
  + async listAccounts({ search, page = 1, size = 20 }: ListAccountsParams) {
  +   return { data: rows.slice((page - 1) * size, page * size), total }
    }
  ```
  
  Callers que pediam `limit > 200` via HTTP passam a receber 200 itens por página — pagine com `page` para cobrir o resto.

## 0.6.4

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

## 0.6.3

### Patch Changes

- 8f23a85: Organization invitations send an email even without a `mail.onOrgInvitation` hook.

  `onOrgInvitation` was the only hook in `MailHooks` with no default-mailer
  fallback. Every other one degrades to a branded, translated email the host kit
  sends itself; this one was guarded by a bare `if (cfg.mail?.onOrgInvitation)`
  with no `else`, so a host that had not written the hook created the invitation
  row and sent nothing. The invited person was never told they had been invited,
  and nothing anywhere reported a problem.

  `sendOrgInvitationEmail` now exists alongside the other `send*Email` functions,
  with `mail.org_invitation.*` messages in both the English and pt-BR tables, and
  both HTTP call sites — the account-facing controller and the admin service — use
  the host hook when present and the library default otherwise. Delivery stays
  best-effort: a mail failure never breaks invitation creation.

  The SDK's embedded driver reached the same service through a third door and had
  to be fixed with it. Its out-of-band context now carries the container resolver
  and a logger, which is all the default mailer reads, so an invitation created
  through `authkit.organizations.invitations.create()` reaches an inbox too rather
  than reproducing the original silent failure one layer down.

  One latent bug fell out of the rework: the account controller resolved the
  organization and the issuer origin _outside_ its `try`, so a config with an
  unresolvable issuer would have thrown out of a path that must never break
  invitation creation. Both are inside the guarded block now.

## 0.6.2

### Patch Changes

- 1f15367: Point `homepage` and `bugs.url` at the repository's current name.

  The repository was renamed to `adonis-agora-authkit`; `repository.url` followed,
  `homepage` and `bugs.url` did not. Every package therefore shipped a manifest
  that disagreed with itself, and the "Repository"/"Homepage" links on npm leaned
  on GitHub's rename redirect — which lasts only until someone claims the old
  name. All three fields now name the same repository.

## 0.6.1

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

## 0.6.0

### Minor Changes

- 0542665: Re-scope to @adonis-agora/authkit-\* (join the Agora ecosystem)

## 0.5.0

### Minor Changes

- 6fe2aa7: feat: rotação automática de chaves JWKS (age-based) + política + endpoints + SDK.

  Nova setting `key_rotation` (`{enabled,maxAgeDays,keep}`, default OFF). Um scheduler
  de housekeeping (web-only, fail-safe) rotaciona a chave quando ela passa de
  `maxAgeDays` e aplica AO VIVO (sem restart, via `reloadKeys` da Fatia C), com
  single-flight via `@adonisjs/lock` (peer opcional; sem ele assume single-instance).
  `OidcService` ganha `rotateKeys()`/`keystoreAgeDays()` (rotate+reload serializados).

  Dois tiers de endpoint admin para status + "rotacionar agora":

  - **REST API** `GET/POST /api/authkit/v1/keys` (Bearer key) — para backend/automação;
  - **Console API** `GET/POST {adminPrefix}/api/keys` (sessão + role admin) — para o browser.

  `@adonis-agora/authkit-sdk` expõe `authkit.keys.status()` / `authkit.keys.rotate()`
  (drivers remote + embedded). `@adonisjs/lock` é peer OPCIONAL.

  Default OFF: nada rotaciona automaticamente até um admin habilitar `key_rotation`.

## 0.4.1

### Patch Changes

- RuntimeSettings now probes the `auth_settings` table with a real `SELECT` (search_path-aware) instead of `schema.hasTable`, and follows the account store's named connection (`lucidAccountStore` exposes `connectionName` from the model). Hosts storing auth on a named connection (e.g. `connection: 'auth'`) no longer see every runtime setting as "table absent".

## 0.4.0

### Patch Changes

- Re-baseline de versionamento: 1.3.0 → 0.4.0 (código idêntico ao 1.3.0). O SDK nasceu por engano em 1.0.0; volta para 0.x para sinalizar a mesma maturidade dos demais pacotes do ecossistema (server 0.13, client 0.4, react 0.3). As versões 1.x ficam deprecadas no npm.

## 1.3.0

### Minor Changes

- Configurable Admin REST API prefix: `registerAuthHost(router, { adminApi: { prefix: '/authkit/api' } })` mounts the API under a custom prefix (default `/api/authkit/v1` unchanged; `adminApi: true` keeps working). The SDK remote driver gains a matching `apiPrefix` option in `createAuthkit`.

## 1.2.0

### Minor Changes

- Runtime settings + bot protection UI toggle:
  - **Runtime settings store**: optional capability-probed `auth_settings` table with `SettingsCapability`, `supportsSettings` type guard and a `RuntimeSettings` service (15s TTL cache, fail-safe fallback to static config on any DB error or missing table).
  - **Bot protection runtime toggle**: the `bot_protection` setting key (`{ enabled, on? }`) turns bot protection on/off and overrides protected actions without redeploying — the `verify` hook still comes from config (it is code). No setting/table = static config, zero breaking changes.
  - **Admin console**: new `/admin/settings` page with the bot-protection card (toggle + action checkboxes, disabled state when `verify` is not configured, schema hint when the table is absent). Audit event `settings.updated`.
  - **Admin REST API**: `GET/PUT/DELETE /api/authkit/v1/settings[/:key]` (404 when capability absent).
  - **SDK**: `authkit.settings.list()/get()/set()/delete()` in both remote and embedded drivers.
  - **Doctor**: `checkSettings` warns about an orphan `bot_protection` setting when `botProtection.verify` is absent from config.

### Patch Changes

- Updated dependencies
  - @adonis-agora/authkit-server@0.10.0

## 1.1.0

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
  - @adonis-agora/authkit-server@0.9.0

## 1.0.0

### Minor Changes

- b205782: Primeiro release do SDK backend (@adonis-agora/authkit-sdk): uma interface tipada com dois drivers — `remote` (HTTP contra a Admin REST API `/api/authkit/v1` com Bearer API key) e `embedded` (in-process, quando o IdP roda no mesmo app AdonisJS). Cobre users, sessions, clients, audit e tokens.verify, com erros mapeados para `AuthkitApiError`.

### Patch Changes

- Updated dependencies [93bfc4f]
  - @adonis-agora/authkit-server@0.8.0
