# @adonis-agora/authkit-core

## 0.7.1

### Patch Changes

- 1f15367: Point `homepage` and `bugs.url` at the repository's current name.

  The repository was renamed to `adonis-agora-authkit`; `repository.url` followed,
  `homepage` and `bugs.url` did not. Every package therefore shipped a manifest
  that disagreed with itself, and the "Repository"/"Homepage" links on npm leaned
  on GitHub's rename redirect — which lasts only until someone claims the old
  name. All three fields now name the same repository.

## 0.7.0

### Minor Changes

- 0542665: Re-scope to @adonis-agora/authkit-\* (join the Agora ecosystem)

## 0.6.0

### Minor Changes

- 93eaf69: feat: cofre do keystore JWKS no HashiCorp Vault (KV v2). Novo driver
  `{ driver: 'hashicorp-vault', endpoint, path, token?, mount?, field? }` — usa a API
  HTTP do Vault (sem SDK), então mora em core como file/drive/lucid/redis. Encryption
  at-rest fica OFF por default (o Vault tem cifra/ACL próprios; ligável p/ envelope).
- e2582b8: feat: cofres do keystore JWKS em Lucid e Redis. Novos drivers `jwks.store`:
  `{ driver: 'lucid' }` (tabela dedicada `authkit_keystore`, auto-criada) e
  `{ driver: 'redis' }` (uma key). Diferente de `file`, ambos são COMPARTILHADOS entre
  instâncias — o melhor default para multi-instância + hot-reload (o poll lê um `head`
  barato). Encryption at-rest (APP_KEY) ON por default nos dois. Warning no boot quando
  `redis` é usado (exige persistência RDB/AOF). `resolveKeystoreVault` agora recebe um
  contexto com acesso ao container (mudança de assinatura interna).

## 0.5.0

### Minor Changes

- df4b41f: feat: keystore JWKS managed com cofre pluggável + encryption at-rest (Fatia A+B)

  O keystore managed deixa de ser fs-síncrono-num-path e passa por uma abstração de
  cofre (`KeystoreVault`): `file` (default) e `drive` (`@adonisjs/drive`, bucket), com
  contrato para cofres custom. O keystore PRIVADO agora é encriptado em repouso por
  default (APP_KEY) para file/drive via um envelope versionado; decrypt falho lança
  (nunca regenera em silêncio). O boot e o comando `authkit:keys:rotate` usam o mesmo
  stack (defaults de encryption idênticos). Novidades: aviso no boot quando
  `jwks: 'auto'` cai no fallback de disco, e idade da chave de assinatura no
  `authkit:doctor`. Config: `jwks.store` aceita `{ driver: 'file' | 'drive' | ... }`
  além de string, e novo `jwks.encrypt`.

  Nota (0.x): sem migração de keystore legado — um `tmp/authkit_jwks.json` plaintext
  pré-existente deve ser apagado uma vez (regenera encriptado).

## 0.4.0

### Minor Changes

- Breaking cleanup (0.x, no external consumers): every deprecation shim is gone.
  - Policy now lives ONLY in runtime settings (DB) with library defaults — removed from config: static `clients`, lockout policy fields (`store` stays), rate-limit buckets (`enabled`/`store` stay), `notifications`, trusted-devices `enabled`/`days`, `admin.impersonation`, organizations `roles`/`allowSelfCreate`/`invitationTtlHours`, and `password.policy`/`password.checkPwned` store options (`legacyVerifier`/`pepper`/`pwnedTimeoutMs` stay — they are code/infra).
  - Removed commands `authkit:clients:import` and the legacy `authkit:rotate-keys` alias. New `authkit:clients:create` creates OIDC clients programmatically through the configured storage (confidential secret printed once; `--public`, repeatable `--redirect-uri`/`--grant`, `--json`).
  - Removed the no-op `passthroughParsed` option from `jsonColumn` and the `checkLegacyPolicyConfig` doctor check.

## 0.3.1

### Patch Changes

- Runtime-first administration:
  - **Three new runtime toggles** (auth_settings-backed, with admin console cards showing effective state): `registration` (open/close self-service signup without affecting org invites or admin-created users; static fallback `registration.enabled`), `require_verified_email` (overrides `login.requireVerifiedEmail` across password/magic-link/passkey flows), and `maintenance_mode` (`{ enabled, message? }` — blocks login/signup/forgot for non-admins with a maintenance page while admin accounts keep logging in; userinfo/introspection/existing sessions keep working; the Admin API is never blocked, providing a guaranteed escape hatch). Audit events `maintenance.enabled`/`maintenance.disabled`.
  - **Clients are now managed at runtime** (admin console + Admin REST API are the canonical path): the static `clients` config field is optional and deprecated (boot warning, doctor warning, console banner). New `authkit:clients:import` ace command (`--dry-run`) migrates config clients to the adapter preserving secrets and skipping existing ones. Booting with zero configured clients is fully supported. New doctor check warns when clients live in a volatile adapter. Backchannel logout URI/session-required are now editable via console and API.

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

## 0.2.0

### Minor Changes

- 1872a30: DX & ops infra:
  - New package `@adonis-agora/authkit-testing` — test helpers for host apps:
    `createTestIdentity`, `mintTestIdToken` + `serveJwks`/`testJwks`/`jwksFromKey`
    (real RS256 tokens validated by a local JWKS), `fakeAuthenticator`, and a
    capability-aware `fakeAccountStore`.
  - `node ace authkit:doctor` — validates host config and prints ✅/⚠️/❌ findings
    (issuer/mountPath, clients, accountStore capabilities, session, shield, ally,
    rate-limit, admin, webauthn, jwks). Non-zero exit on errors.
  - `node ace authkit:rotate-keys` — rotates managed JWKS signing keys via a new
    file-backed keystore (`jwks: { source: 'managed', store }`), keeping the last
    N public keys so pre-rotation tokens still verify.
