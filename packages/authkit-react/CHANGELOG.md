# @adonis-agora/authkit-react

## 0.18.1

### Patch Changes

- 1f15367: Point `homepage` and `bugs.url` at the repository's current name.

  The repository was renamed to `adonis-agora-authkit`; `repository.url` followed,
  `homepage` and `bugs.url` did not. Every package therefore shipped a manifest
  that disagreed with itself, and the "Repository"/"Homepage" links on npm leaned
  on GitHub's rename redirect — which lasts only until someone claims the old
  name. All three fields now name the same repository.

- Updated dependencies [1f15367]
  - @adonis-agora/authkit-core@0.7.1

## 0.18.0

### Minor Changes

- Login OTP e anti-duplo-submit nos formulários de interaction:

  - `interactionUrls` cobre `otpVerify` (e `InteractionPostStep` aceita `'otpVerify'`) + novo export `OTP_CODE_FIELD` (`'code'`). A rota existe no server desde a 0.50 e o helper ficou pra trás — hosts montavam a URL à mão e hardcodavam o nome do campo.
  - `MagicLinkButton` aceita `channel` (`'code'` | `'link'` — o choose-first do server 0.51) e mostra `pendingChildren` durante o voo do POST.
  - `InteractionForm` ganha trava anti-duplo-submit a nível de DOM: desabilita os botões de submit depois do dispatch do evento (botão nomeado preserva o valor; `preventDefault` não trava à toa). Cobre qualquer `children` sem mudança de API — clique repetido não vira mais POST duplicado (no `/magic`, N cliques impacientes derrubavam o usuário no throttle 429).

## 0.17.0

### Minor Changes

- efd30df: Adiciona hooks e utilitários headless para o "dance" de sudo/passkey por form
  clássico, para hosts com telas React próprias.

  - `submitClassicForm({ action, fields, method? })`: cria um `<form>` nativo com
    campos hidden e o submete (navegação real) — necessário porque os fluxos de
    sudo/passkey respondem 302, que um `fetch` não segue como navegação. SSR-safe.
  - `usePasskeyAssertion({ optionsUrl, actionUrl, csrfToken, returnTo? })` →
    `{ run, running, error }`: pega as options (`x-csrf-token`), roda
    `startAuthentication` e submete o `response` via form clássico (com `_csrf` e
    `return_to` quando fornecidos).
  - `usePasskeyRegistration(...)`: idem, com `startRegistration`.

  Também exporta as peças de tier mais baixo reusadas por eles (`runPasskeyAssertion`,
  `runPasskeyRegistration`, `registerPasskey`, `loadStartRegistration`). O
  `submitPasskeyVerification` existente passa a delegar ao `submitClassicForm`,
  sem mudança de comportamento.

## 0.16.0

### Minor Changes

- 7ea3ac8: Login por senha/magic link/OAuth também nas camadas do ecossistema — some a concatenação de URL à mão e o `_csrf` repetido em cada form:
  - **Funções (`interactionUrls`, `oauthRedirectUrl`)** — builders tipados das URLs de interaction (identifier, login, magic, signup, switch, passkey/options, passkey/verify) e do redirect OAuth. Fonte única: se o prefixo de rota do authkit-server mudar, não quebra silenciosamente em string mágica espalhada.
  - **Primitivo (`InteractionForm`)** — `<form method="POST">` no endpoint certo + o campo escondido `_csrf`, deixando os campos e o estilo pro app. Encapsula o boilerplate que se repetia em identifier/login/magic.
  - **Componentes prontos (`MagicLinkButton`, `OAuthButton`)** — o "faz tudo", construídos sobre o primitivo/as funções, temáveis via `className`/`children`.
  - **Helper `buttonClass(variant, extra)`** — centraliza a mescla de className dos botões do authkit (base + variante + extra do host), que os componentes repetiam.

## 0.15.0

### Minor Changes

- 9909753: Login por passkey disparado por clique, nas três camadas do ecossistema — o app deixa de reescrever a cerimônia à mão:

  - **Função (`authenticatePasskey`, `submitPasskeyVerification`, `loadStartAuthentication`)** — a cerimônia pura (POST das options → `startAuthentication` → serializa a assertion) e o submit de página inteira no `verify`. Totalmente customizável: use só a peça que precisar.
  - **Hook headless (`usePasskeyLogin`)** — `{ authenticate, busy, failed }`. Roda a cerimônia e faz o submit; passe `onSuccess` pra controlar a verificação você mesmo (meio-do-caminho). O app é dono do visual do botão.
  - **Componente pronto (`PasskeyButton`)** — o "faz tudo": botão + estado + erro, temável via `className`/`children`. Construído sobre o hook.

  `@simplewebauthn/browser` continua sendo import lazy (pacote local → CDN), sem virar dependência. O `usePasskeyAutofill` passa a reusar o mesmo `loadStartAuthentication` (some a duplicação do carregamento da lib).

## 0.14.0

### Minor Changes

- c12bac9: `authkit-react` drops app-role/authorization gating — that concern moved to
  `@adonis-agora/authz-react`.

  Removed:

  - `AuthUser.appRoles`, `AuthSharedProps.authkit.appRoles`.
  - `AuthState.appRoles`/`AuthState.hasAppRole()`.
  - `hasAppRole`, `hasAnyAppRole`, `hasAllAppRoles` (from `roles.ts` and the package barrel).
  - The `<Can>` component (`components/can.tsx`) and its `CanProps` type — it now lives in
    `@adonis-agora/authz-react`, backed by the Authz service instead of app roles resolved
    on the host.

  `AuthState` is now `{ user, isAuthenticated, globalRoles, hasGlobalRole, hasAnyGlobalRole,
hasAllGlobalRoles }`.

  Kept: `user`, `globalRoles`, `hasGlobalRole`/`hasAnyGlobalRole`/`hasAllGlobalRoles` — these
  read from the IdP token via `@adonis-agora/authkit-client`, not from app-defined roles.
  `<CanPermission>`/`useCan` (permission checks against the Authz `/authz/can` endpoint) are
  unaffected.

## 0.13.1

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

## 0.13.0

### Minor Changes

- 12df185: Write `globalRoles` into the @agora context from the resolved session (so the Authz global-role bridge can read them), and add Authz permission gating to authkit-react: `useCan(permission, resource?)` and `<CanPermission>`, which consult the Authz `POST <canPath>` endpoint (`{ permission, resource? }` → `{ allowed }`, credentials included) with in-memory caching/dedupe. The endpoint path is configurable via `AuthkitProvider` (`canPath` / `endpoints.can`, default `/authz/can`).
- 4bccbe9: fix: invalidate can-permission cache on principal change (stale authz after logout/org-switch)

  The in-memory `useCan`/`checkCan` cache was process-global and keyed only by
  `(path, permission, resource)`, so resolved permission decisions kept being
  served across logout / user-switch / org-switch — a decision could outlive the
  session that authorized it. The current principal (`useAuth().user?.id`, or an
  `anon` sentinel when logged out) is now folded into the cache key, so a new
  principal naturally misses the previous principal's answers and re-checks.

  Also: `UseCanResult` now exposes an optional `error?: Error` (fail-closed:
  `allowed` stays `false` on error), symmetric with `ResourceState<T>`; a public
  `invalidateCanCache()` is exported to force a global refetch; and the warm-cache
  render no longer triggers a redundant second `setState`.

## 0.12.0

### Minor Changes

- 0542665: Re-scope to @adonis-agora/authkit-\* (join the Agora ecosystem)

### Patch Changes

- Updated dependencies [0542665]
  - @adonis-agora/authkit-core@0.7.0

## 0.11.0

### Minor Changes

- a450edb: Página "Signing Keys" no console admin: ver chaves JWKS (kids/idade/ativa), configurar rotação automática (enabled/maxAgeDays/keep), rotacionar agora e desabilitar todas + criar nova. O status de keys (`GET {base}/keys`) agora inclui a lista de chaves (`KeysStatus.keys`).

## 0.10.0

### Minor Changes

- 386a0df: feat: gestão de rotação de chave JWKS no React SDK. Novo `client.admin.keys.status()`
  e `client.admin.keys.rotate()` (console API session-authed — sem API key no browser),
  hooks headless TanStack `useKeysQueryOptions`/`useRotateKeysMutationOptions`, e o
  componente `<KeyRotation>` (idade da chave, política, ETA e botão "Rotacionar agora").

### Patch Changes

- Updated dependencies [93eaf69]
- Updated dependencies [e2582b8]
  - @adonis-agora/authkit-core@0.6.0

## 0.9.1

### Patch Changes

- Updated dependencies [df4b41f]
  - @adonis-agora/authkit-core@0.5.0

## 0.9.0

### Minor Changes

- a6ca8a7: Bring your own IdP — use AuthKit against any OIDC-compliant provider
  - **client**: new `discoverEndpoints(issuer)` resolves the IdP's real endpoints from `/.well-known/openid-configuration` (cached per issuer, field-level manual overrides, silent fallback to the oidc-provider conventions when the document is unreachable). All flow helpers (`buildAuthorizeUrl`, `exchangeCode`, `refreshTokens`, `exchangeToken`, `buildEndSessionUrl`) now accept explicit endpoint params — Keycloak, Auth0, Okta, Entra et al. work out of the box.
  - **react**: new `idp: 'authkit' | 'external'` config on `AuthkitProvider`. With an external IdP, the components that depend on authkit-server's REST surface (`UserProfile`, `OrganizationSwitcher`, `OrganizationProfile`, `AuthorizedApps`) degrade to `null` instead of calling endpoints that don't exist; sign-in/out, auth state, role gates and the password strength meter keep working.
  - New "Bring your own IdP" docs page tying the two together.

## 0.8.0

### Minor Changes

- feat(account): global sign-out — revoke all sessions across all devices

  **Server (`@adonis-agora/authkit-server`):**

  - `POST /account/api/sessions/revoke-all` — revokes all OIDC sessions/grants for the account
    and terminates the current Adonis console session (global logout).
    Returns `{ ok: true, signedOut: true }` so the UI can redirect to login.
    Emits audit event `account.signed_out_all`.

  **React SDK (`@adonis-agora/authkit-react`):**

  - `RevokeAllResult` type (`{ ok, signedOut, ...rest }`)
  - `client.account.sessions.revokeAll()` method
  - `useAccountRevokeAllSessionsMutationOptions()` hook (account namespace;
    distinct from the admin `useRevokeAllSessionsMutationOptions`)

## 0.7.0

### Minor Changes

- feat(settings): org-scoped runtime settings (org → global → default resolution)
  - `auth_settings` table gains `organization_id` column (nullable; NULL = global). Unique constraint on (key, organization_id).
  - `RuntimeSettings` methods gain optional `orgId` param: `getSetting(key, orgId?)`, `setSetting(key, value, updatedBy?, orgId?)`, `deleteSetting(key, orgId?)`, `listSettings(orgId?)`. New `getEffective(key, orgId?)` helper resolves org → global → null.
  - Cache is org-scope-aware (cache key includes orgId).
  - `resolveEffectiveOrganizationsPolicy` and `resolveEffectiveRolesCatalog` accept optional `orgId` and resolve org → global → default. All other resolvers remain global-only.
  - Console JSON API (`/api/settings`) and Admin REST API accept `?organizationId=` query param for scoped reads/writes/deletes.
  - Org detail drawer in console admin shows "Organization Settings" section for org-scopable keys (`organizations_policy`, `roles_catalog`) with source badges (from org / from global / default) and inline JSON editor.
  - `@adonis-agora/authkit-react` client: `settings.list(orgId?)`, `settings.set(key, value, orgId?)`, `settings.remove(key, orgId?)`. `authkitKeys.admin.settings(orgId?)`. `useSettingsQueryOptions(orgId?)`, `useSetSettingMutationOptions(orgId?)`, `useRemoveSettingMutationOptions(orgId?)`.
  - `SettingEntry` type gains `organizationId: string | null` field.
  - Existing rows default to `organization_id = NULL` (global) — no data migration needed.

## 0.6.0

### Minor Changes

- feat(console): gestão completa de organizations no console admin React

  Adiciona CRUD completo de organizações na JSON API do console React
  (console_orgs_controller) e na SPA (Orgs.tsx + orgs.containers.tsx):

  **Novos endpoints no console React JSON API (`{adminPrefix}/api/orgs/*`):**

  - `POST   /api/orgs` → criar org (name + slug + ownerAccountId)
  - `PATCH  /api/orgs/:id` → editar nome/logo
  - `DELETE /api/orgs/:id` → remover org
  - `POST   /api/orgs/:id/members` → adicionar membro (accountId + role)
  - `PATCH  /api/orgs/:id/members/:accountId` → alterar role do membro
  - `DELETE /api/orgs/:id/members/:accountId` → remover membro
  - `POST   /api/orgs/:id/invitations` → criar convite (email + role)
  - `DELETE /api/orgs/:id/invitations/:invitationId` → revogar convite

  Todos os endpoints retornam 404 `capability_unsupported` quando o store não
  suporta organizações. Lógica reutiliza `AdminOrgsService` (sem duplicação).

  **SDK `@adonis-agora/authkit-react`:**

  - `client.admin.orgs`: novos métodos `addMember`, `removeMember`,
    `updateMemberRole`, `createInvitation`, `revokeInvitation`
  - Novos hooks: `useAddOrgMemberMutationOptions`, `useRemoveOrgMemberMutationOptions`,
    `useUpdateOrgMemberRoleMutationOptions`, `useCreateOrgInvitationMutationOptions`,
    `useRevokeOrgInvitationMutationOptions`

  **SPA do console:**

  - Botão "New organization" na header (modal com name + slug auto-gerado + ownerAccountId)
  - Empty state com CTA de criar
  - Drawer da org: editar nome/logo, deletar (com confirmação), listar membros com
    add/mudar-role/remover, convites pendentes com criar e revogar
  - Padrão containers + skeleton + QueryBoundary + toasts

  i18n: strings em inglês (interface do console); mensagens de erro do servidor em pt-BR.

## 0.5.3

### Patch Changes

- fix(sessions): listagem global no console admin quando accountId ausente
  - `ConsoleSessionsController.index`: sem `accountId` retorna lista global de todas as sessões ativas (todas as contas) em vez de 400
  - `AdminSessionsService.listAllSessions()`: enumera todas as sessões via adapter, resolve email por conta com cache (evita N+1), limita a 500 entradas com flag `truncated`
  - `AdminSession`: novo campo opcional `email`
  - `sessionDto`: inclui `email` na projeção JSON
  - `AdminSessionEntry` (react types): campo `email: string | null`
  - `UserSessionsResult` (react types): campo `truncated?: boolean`; renomeia `canList` → `supported` para alinhar com a resposta real do servidor
  - SPA `sessions.containers.tsx`: exibe email acima do accountId na coluna Account quando presente
  - Testes: cobre listagem global, truncamento a 500, capability ausente e resolução de email

## 0.5.2

### Patch Changes

- Fix SSR crash (500) when host React account screens use the client: the constructor threw an SSR error eagerly, breaking server-render of any page that only uses `client.account.*`. Construction is now side-effect-free; the admin base is resolved lazily and only throws if an `admin.*` call is actually made without a base. Account-only screens work with just `accountBaseUrl`.

## 0.5.1

### Patch Changes

- Fix "Failed to execute 'fetch' on 'Window': Illegal invocation": the typed client stored `globalThis.fetch` unbound and called it as an instance method, losing the Window binding. The default fetch is now bound to `globalThis`. The admin console SPA is also refactored into per-section containers, each with its own loading skeleton and a `react-error-boundary`-backed error state with retry.

## 0.5.0

### Minor Changes

- Typed front-end client, TanStack Query hooks, and account JSON API:
  - **Account self-service JSON API** (`/account/api/*`): session-authed, CSRF-protected endpoints for profile, security overview, password/email change, sessions, authorized apps, MFA/passkeys, PATs and organizations — the data layer for client-side account screens. Login/consent stay postback for security.
  - **Typed front-end client** in `@adonis-agora/authkit-react`: `createAuthkitClient()` (auto-reads `window.__AUTHKIT__`) exposing `client.admin.*` and `client.account.*`, plus `AuthkitClientError`.
  - **TanStack Query hooks** (Tuyau-style): ready-made `use*QueryOptions`/`use*MutationOptions` for every admin and account endpoint, structured `authkitKeys` for invalidation, `AuthkitClientProvider` + `createAuthkitQueryClient()`. `@tanstack/react-query` is a new peer dependency.
  - **Admin console SPA** now consumes these hooks internally (client-side fetching via TanStack Query) instead of a bespoke fetch wrapper.

## 0.4.0

### Minor Changes

- Rodauth parity completion + React admin console:
  - **Sudo mode**: `sudo_mode` setting + `/account/confirm` (password or passkey) re-confirmation with a grace window; `requireSudo` gates password/email change, account deletion, MFA/passkey management and PAT actions.
  - **OTP lockout**: `otp_lockout` setting locks the second factor after repeated TOTP/recovery failures and unlocks via emailed link (`GET /auth/otp-unlock/:token`, `onOtpUnlock` hook).
  - **Common-password block**: `password_policy.blockCommon` (default on) rejects the ~10k most common passwords offline, before the HIBP check.
  - **Account expiration**: `account_expiration` setting blocks login for accounts inactive beyond N days (reactivate via password reset) + `authkit:accounts:expire-scan` command for cron with warning emails.
  - **WebAuthn autofill**: `auth_methods.passkeyAutofill` enables conditional-mediation passkey suggestions on the login field; new `usePasskeyAutofill` React hook.
  - **React admin console (new default)**: `admin: { ui: 'react' }` serves a real Vite-built React SPA (build-and-serve, bundled in the package — zero host setup) with a dark/light telescope-style theme, consuming a session-authed JSON API under `{prefix}/api/*`. `ui: 'edge'` keeps the classic server-rendered console.

## 0.3.2

### Patch Changes

- Updated dependencies
  - @adonis-agora/authkit-core@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies
  - @adonis-agora/authkit-core@0.3.1

## 0.3.0

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

## 0.2.0

### Minor Changes

- 0403b72: Add a Clerk-style frontend layer: an `<AuthkitProvider>` config context (loginUrl/logoutUrl/profileUrl/endpoints/csrfToken with host-kit defaults), headless hooks (`useSignIn`, `useSignOut`, `useUser`, `useProfile`, `useSessions`, `useAuthorizedApps` — fetch-based, no react-query), and pre-built themeable components (`SignInButton`, `SignOutButton`, `UserButton`, `UserProfile`, `AuthorizedApps`, `Avatar`) with a shipped `styles.css` (`./styles.css` export) and `--authkit-*` CSS variables.

## 0.1.2

### Patch Changes

- Updated dependencies [1872a30]
  - @adonis-agora/authkit-core@0.2.0

## 0.1.1

### Patch Changes

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
