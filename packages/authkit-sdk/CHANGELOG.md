# @adonis-agora/authkit-sdk

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
