# @adonis-agora/authkit-poppy

## 1.0.1

### Patch Changes

- [#578](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/578) [`915cfef`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/915cfef943f0e07600a2b4ab2b02cfb691529322) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ship a TanStack Intent agent skill with the package, so coding agents that install it get setup and usage guidance verified against the code.

## 1.0.0

### Major Changes

- [#544](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/544) [`ccc5b61`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/ccc5b61ffc27bf38ada188b557eed0764bd1153c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Poppy 1.0. The package now implements the published Personal Agent Protocol 1.0 and serves version `1.0` only; its version follows the spec version.
  
  Breaking changes for apps:
  
  - `agent.protocols[]` entries need a `description` (what the agent there can help with). An endpoint announced through the `@adonis-agora/poppy:endpoints` slot is published only with a `description` next to `conversations`.
  - `feedback` and `excludedTasks` moved into `tasks` (`tasks.feedback`, `tasks.excludedTasks`, plus `tasks.skillIndex` and `tasks.resolve`); the package serves `GET /poppy/tasks` and lists it as `tasks.endpoint`. Pass `tasks: { endpoint }` to serve your own.
  - `extensions` takes a list with one entry per version: `{ name: [{ version: '1', … }] }`.
  - `poppy:browser-sign-in` is added to the scopes when browser join and sign-in are on; joining a browser with an access token needs it. `web.unscoped` (default `true`) and `web.disabled` are new.
  - Requests verified with the Session header need `Poppy-Version: 1.x` (`version_unsupported` otherwise). Ended Sessions and account changes answer `session_ended`. Sessions are keyed by `client_id` + `sid` + User ID. Failures carry a `body` to send as JSON.
  - Delegations are `poppy-delegation+jwt` in the `poppy_dlg` header.
  - `assertionMaxLifetime` can't be lower than 300.
  
  New: Pushed Authorization Requests (`POST /poppy/oauth/par`, `par: { required }`), refresh tokens bound to the sign-in's DPoP key (`dpop.bindRefreshTokens`), `auth.disabled` when no sign-in type is on, `organization.domain` with its port, `scopes_supported` in the protected resource metadata, `resource=https://{domain}` for the default token, `protocolVersion` and `extensions` on the principal, and `verifyPoppyRequest(…, { extension })`. A new table, `auth_poppy_grant_keys`, is created with the others.

### Minor Changes

- [#456](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/456) [`9c12ef9`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/9c12ef9c1c49db9d54a7da6d241264499ad76e18) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - First release: the Personal Agent Protocol ("Poppy", Draft 0.3) as an extension of `@adonis-agora/authkit-server` 1.x — `personalAgents: { extensions: [poppy({ ... })] }`. Same options, routes, tables, tokens and global slots as the Poppy that was built into authkit-server 0.x; `poppyEmailCodeSignIn` takes `sendCode` in place of the old `mail.onPoppySignInCode` hook, `ensurePoppySchema()` creates its tables in a migration, and `node ace configure @adonis-agora/authkit-poppy` checks the install and shows the config change. Experimental: this package stays on 0.x while the spec is a draft.

- [#545](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/545) [`1c1e74d`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/1c1e74dff54da413fee2501c4080c437f26cb241) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Poppy 1.0 optional parts:
  
  - The consent page marks scopes the account already granted to the agent (still lists every scope).
  - `signIn.limitToResource`: a sign-in whose first request names `resource` covers only those resources.
  - A delegated key that already signed for another User ID gets `invalid_session` (`sessionJwt.oneUserPerKey`, default on).
  - `versions` / `preferredVersion`: serve several protocol versions (`supported_versions`, a document per version on the same host, `Deprecation`/`Sunset` for a version being retired). The principal gains `documentVersion`; verified results carry `headers`.
  - A Session keeps the `Poppy-Version` it started with (`session_ended` otherwise).
  - `tasks.feedback` without `endpoint`: a built-in feedback endpoint (`POST /poppy/feedback`) that verifies the Session, stores reports in `auth_poppy_feedback` and calls `onReport`.
  - `operations`: the Operations extension (version 3) — `requirePoppyOperation()`, website operations with `Poppy-Operation` and `POST /poppy/operations`, declines, at-most-once retries, and the `@adonis-agora/poppy:operations` global slot.
  - `browserControl`: lists Browser Control (version 1), with `poppyUserStep()` (also an Edge global) and `poppyUserStepAttrs()`.
  - `links` / `disclosures`: list the Links and Disclosures extensions.
  
  New lib-owned tables (`auth_poppy_grant_resources`, `auth_poppy_delegated_keys`, `auth_poppy_feedback`, `auth_poppy_operations`, `auth_poppy_operation_revisions`) and `sid`/`protocol_version` columns on `auth_poppy_sessions`, created additively at boot (or with `ensurePoppySchema()`).

### Patch Changes

- [#464](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/464) [`3250c35`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/3250c35eee328e8e3780df32001323be45fe1bae) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Developer tools over MCP. When the app runs `@adonis-agora/agent`'s dev tools endpoint (`/mcp/agora`), the admin console's data is served there with no config: `authkit_get_overview`, `authkit_list_users`, `authkit_get_user`, `authkit_list_user_sessions`, `authkit_list_user_grants`, `authkit_list_orgs`, `authkit_get_org`, `authkit_list_clients`, `authkit_list_audit`, and the destructive actions `authkit_revoke_user_sessions` and `authkit_disable_user` (hidden until the endpoint allows actions; audited with `mcp:<caller>` as actor). Access follows `admin.authorize`; when it allows the MCP request, `admin.roles` is not checked. Without `admin.authorize`, production refuses and other environments need an AuthKit sign-in holding one of `admin.roles`.
  
  `@adonis-agora/authkit-poppy` offers the `agora:dev` scope when the app serves those dev tools (`devTools` option to force it on or off). The consent screen never ticks it for the person, and Mediated Sign-In can't grant it. The personal-agent consent screen supports opt-in scopes (`optIn`, `descriptionKey` on each scope of `agents/consent`).

- [#474](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/474) [`df9e49d`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/df9e49d7817c03a7cce4cac1df709c7788d6307c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - AuthKit's tables can live in their own database schema: `schema: { name: 'auth' }` in `defineConfig` puts every table AuthKit owns in `auth` (`"auth"."auth_settings"`) while the app stays in `public`. The schema is written into every statement, so it works on any connection and inside the app's own transaction, with no `searchPath` (which leaks across clients behind PgBouncer in transaction mode).
  
  - The boot creates the schema (`CREATE SCHEMA IF NOT EXISTS`; MySQL: `CREATE DATABASE IF NOT EXISTS`) when `autoManage` is on, and fails with a message naming the schema and the grant when the role cannot create it. `ensureAuthkitSchema(db, { schema })` does the same from a migration.
  - Covers the OIDC adapter table (`adapters.database({ schema })` overrides), the Lucid keystore (`jwks.store: { driver: 'lucid', schema }` overrides), the account store's tables (MFA, password history, organizations), runtime settings, session revocations, the personal-agent tables and agent extensions (`PersonalAgentHost.table(name)`, `AuthkitTable.create(table, { table })`, `ensureAuthkitTables(db, tables, { schema })`; Poppy uses them and `ensurePoppySchema(db, { schema })`).
  - authkit-client: `lucidRevocationStore({ schema })`.
  - SQLite with `schema.name` fails the boot instead of ignoring the option.
  - `agora:doctor` gains `authkit.db-schema`: the schema exists, the tables are in it, the connection can write there. Silent without `schema.name`.
  - The key-rotation lock key includes the schema, so two installs in two schemas of one database do not share it.
  
  Without `schema.name` nothing changes.

- [`0c4c958`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/0c4c95895572969cd6dc915a3a2b862a75c834fb) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Poppy's default in-memory rate limiter now has a hard cap (100 000 windows, oldest evicted first) and drops expired windows as it goes, so a stream of new identifiers on Mediated Sign-In can no longer grow it without bound.
  
  The unauthenticated OAuth endpoints agents call server-to-server now sit behind a per-IP throttle by default (new `agentToken` bucket, 120/min, plain 429; off with the existing `rateLimit: { enabled: false }`): Poppy's `{prefix}/oauth/token`, `oauth/device`, `oauth/par` and `oauth/revoke`, and authkit-server's personal-agents `{personalAgents.prefix}/oauth/token` and `oauth/device_authorization`. Personal-agent extensions get the bucket as `kit.throttle.token(route)`.
  
  The OIDC provider's own machine endpoints get the same treatment: inside the `${mountPath}/*` catch-all, only the POSTs to token, dynamic registration, device authorization, PAR, revocation, introspection and CIBA (paths read from the provider via `pathFor`, so custom `routes` and the issuer mount apply; disabled features are skipped) go through a new per-IP `oidcToken` bucket (120/min, plain 429). Authorize, userinfo, JWKS, discovery, end-session and the device code screen are never throttled. Poppy's `POST {prefix}/browser-session` now uses the login bucket, like its page. All of it is off with `rateLimit: { enabled: false }`.

- [#489](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/489) [`3c650b1`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/3c650b1fe176752ad68df7fc061fa8a6dc1a475a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The SSRF-safe fetch and the agent metadata/JWKS cache now come from `@adonis-agora/authkit-server`, which uses the same code for MCP Client ID Metadata Documents. Behaviour is unchanged. `isBlockedAddress`, `SafeFetchError` and `safeFetchJson` are still exported from this package.

- [`8981f69`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/8981f6970271ae96bf302463816008c6bf256413) Thanks [@github-actions[bot]](https://github.com/github-actions%5Bbot%5D)! - fix(deps): update dependency jose to v6.2.16 ([#454](https://github.com/DavideCarvalho/adonis-agora-authkit/issues/454))

- [`02e6878`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/02e68788a46d3e5a7dba2f8f34d25c5100bf0bf4) Thanks [@github-actions[bot]](https://github.com/github-actions%5Bbot%5D)! - fix(deps): update dependency jose to v6.2.18 ([#535](https://github.com/DavideCarvalho/adonis-agora-authkit/issues/535))

## 1.0.0-rc.7

### Patch Changes

- [`0c4c958`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/0c4c95895572969cd6dc915a3a2b862a75c834fb) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Poppy's default in-memory rate limiter now has a hard cap (100 000 windows, oldest evicted first) and drops expired windows as it goes, so a stream of new identifiers on Mediated Sign-In can no longer grow it without bound.
  
  The unauthenticated OAuth endpoints agents call server-to-server now sit behind a per-IP throttle by default (new `agentToken` bucket, 120/min, plain 429; off with the existing `rateLimit: { enabled: false }`): Poppy's `{prefix}/oauth/token`, `oauth/device`, `oauth/par` and `oauth/revoke`, and authkit-server's personal-agents `{personalAgents.prefix}/oauth/token` and `oauth/device_authorization`. Personal-agent extensions get the bucket as `kit.throttle.token(route)`.
  
  The OIDC provider's own machine endpoints get the same treatment: inside the `${mountPath}/*` catch-all, only the POSTs to token, dynamic registration, device authorization, PAR, revocation, introspection and CIBA (paths read from the provider via `pathFor`, so custom `routes` and the issuer mount apply; disabled features are skipped) go through a new per-IP `oidcToken` bucket (120/min, plain 429). Authorize, userinfo, JWKS, discovery, end-session and the device code screen are never throttled. Poppy's `POST {prefix}/browser-session` now uses the login bucket, like its page. All of it is off with `rateLimit: { enabled: false }`.

## 1.0.0-rc.6

### Minor Changes

- [#545](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/545) [`1c1e74d`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/1c1e74dff54da413fee2501c4080c437f26cb241) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Poppy 1.0 optional parts:
  
  - The consent page marks scopes the account already granted to the agent (still lists every scope).
  - `signIn.limitToResource`: a sign-in whose first request names `resource` covers only those resources.
  - A delegated key that already signed for another User ID gets `invalid_session` (`sessionJwt.oneUserPerKey`, default on).
  - `versions` / `preferredVersion`: serve several protocol versions (`supported_versions`, a document per version on the same host, `Deprecation`/`Sunset` for a version being retired). The principal gains `documentVersion`; verified results carry `headers`.
  - A Session keeps the `Poppy-Version` it started with (`session_ended` otherwise).
  - `tasks.feedback` without `endpoint`: a built-in feedback endpoint (`POST /poppy/feedback`) that verifies the Session, stores reports in `auth_poppy_feedback` and calls `onReport`.
  - `operations`: the Operations extension (version 3) — `requirePoppyOperation()`, website operations with `Poppy-Operation` and `POST /poppy/operations`, declines, at-most-once retries, and the `@adonis-agora/poppy:operations` global slot.
  - `browserControl`: lists Browser Control (version 1), with `poppyUserStep()` (also an Edge global) and `poppyUserStepAttrs()`.
  - `links` / `disclosures`: list the Links and Disclosures extensions.
  
  New lib-owned tables (`auth_poppy_grant_resources`, `auth_poppy_delegated_keys`, `auth_poppy_feedback`, `auth_poppy_operations`, `auth_poppy_operation_revisions`) and `sid`/`protocol_version` columns on `auth_poppy_sessions`, created additively at boot (or with `ensurePoppySchema()`).

## 1.0.0-rc.5

### Major Changes

- [#544](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/544) [`ccc5b61`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/ccc5b61ffc27bf38ada188b557eed0764bd1153c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Poppy 1.0. The package now implements the published Personal Agent Protocol 1.0 and serves version `1.0` only; its version follows the spec version.
  
  Breaking changes for apps:
  
  - `agent.protocols[]` entries need a `description` (what the agent there can help with). An endpoint announced through the `@adonis-agora/poppy:endpoints` slot is published only with a `description` next to `conversations`.
  - `feedback` and `excludedTasks` moved into `tasks` (`tasks.feedback`, `tasks.excludedTasks`, plus `tasks.skillIndex` and `tasks.resolve`); the package serves `GET /poppy/tasks` and lists it as `tasks.endpoint`. Pass `tasks: { endpoint }` to serve your own.
  - `extensions` takes a list with one entry per version: `{ name: [{ version: '1', … }] }`.
  - `poppy:browser-sign-in` is added to the scopes when browser join and sign-in are on; joining a browser with an access token needs it. `web.unscoped` (default `true`) and `web.disabled` are new.
  - Requests verified with the Session header need `Poppy-Version: 1.x` (`version_unsupported` otherwise). Ended Sessions and account changes answer `session_ended`. Sessions are keyed by `client_id` + `sid` + User ID. Failures carry a `body` to send as JSON.
  - Delegations are `poppy-delegation+jwt` in the `poppy_dlg` header.
  - `assertionMaxLifetime` can't be lower than 300.
  
  New: Pushed Authorization Requests (`POST /poppy/oauth/par`, `par: { required }`), refresh tokens bound to the sign-in's DPoP key (`dpop.bindRefreshTokens`), `auth.disabled` when no sign-in type is on, `organization.domain` with its port, `scopes_supported` in the protected resource metadata, `resource=https://{domain}` for the default token, `protocolVersion` and `extensions` on the principal, and `verifyPoppyRequest(…, { extension })`. A new table, `auth_poppy_grant_keys`, is created with the others.

## 0.3.1-rc.4

### Patch Changes

- fix(deps): update dependency jose to v6.2.18 ([#535](https://github.com/DavideCarvalho/adonis-agora-authkit/issues/535))

## 0.3.1-rc.3

### Patch Changes

- [#489](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/489) [`3c650b1`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/3c650b1fe176752ad68df7fc061fa8a6dc1a475a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The SSRF-safe fetch and the agent metadata/JWKS cache now come from `@adonis-agora/authkit-server`, which uses the same code for MCP Client ID Metadata Documents. Behaviour is unchanged. `isBlockedAddress`, `SafeFetchError` and `safeFetchJson` are still exported from this package.

## 0.3.1-rc.2

### Patch Changes

- [#474](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/474) [`df9e49d`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/df9e49d7817c03a7cce4cac1df709c7788d6307c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - AuthKit's tables can live in their own database schema: `schema: { name: 'auth' }` in `defineConfig` puts every table AuthKit owns in `auth` (`"auth"."auth_settings"`) while the app stays in `public`. The schema is written into every statement, so it works on any connection and inside the app's own transaction, with no `searchPath` (which leaks across clients behind PgBouncer in transaction mode).
  
  - The boot creates the schema (`CREATE SCHEMA IF NOT EXISTS`; MySQL: `CREATE DATABASE IF NOT EXISTS`) when `autoManage` is on, and fails with a message naming the schema and the grant when the role cannot create it. `ensureAuthkitSchema(db, { schema })` does the same from a migration.
  - Covers the OIDC adapter table (`adapters.database({ schema })` overrides), the Lucid keystore (`jwks.store: { driver: 'lucid', schema }` overrides), the account store's tables (MFA, password history, organizations), runtime settings, session revocations, the personal-agent tables and agent extensions (`PersonalAgentHost.table(name)`, `AuthkitTable.create(table, { table })`, `ensureAuthkitTables(db, tables, { schema })`; Poppy uses them and `ensurePoppySchema(db, { schema })`).
  - authkit-client: `lucidRevocationStore({ schema })`.
  - SQLite with `schema.name` fails the boot instead of ignoring the option.
  - `agora:doctor` gains `authkit.db-schema`: the schema exists, the tables are in it, the connection can write there. Silent without `schema.name`.
  - The key-rotation lock key includes the schema, so two installs in two schemas of one database do not share it.
  
  Without `schema.name` nothing changes.

## 0.3.1-rc.1

### Patch Changes

- [#464](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/464) [`3250c35`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/3250c35eee328e8e3780df32001323be45fe1bae) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Developer tools over MCP. When the app runs `@adonis-agora/agent`'s dev tools endpoint (`/mcp/agora`), the admin console's data is served there with no config: `authkit_get_overview`, `authkit_list_users`, `authkit_get_user`, `authkit_list_user_sessions`, `authkit_list_user_grants`, `authkit_list_orgs`, `authkit_get_org`, `authkit_list_clients`, `authkit_list_audit`, and the destructive actions `authkit_revoke_user_sessions` and `authkit_disable_user` (hidden until the endpoint allows actions; audited with `mcp:<caller>` as actor). Access follows `admin.authorize`; when it allows the MCP request, `admin.roles` is not checked. Without `admin.authorize`, production refuses and other environments need an AuthKit sign-in holding one of `admin.roles`.
  
  `@adonis-agora/authkit-poppy` offers the `agora:dev` scope when the app serves those dev tools (`devTools` option to force it on or off). The consent screen never ticks it for the person, and Mediated Sign-In can't grant it. The personal-agent consent screen supports opt-in scopes (`optIn`, `descriptionKey` on each scope of `agents/consent`).

## 0.3.1-rc.0

### Patch Changes

- fix(deps): update dependency jose to v6.2.16 ([#454](https://github.com/DavideCarvalho/adonis-agora-authkit/issues/454))

## 0.3.0

The package version follows the Poppy spec draft it implements: 0.3.x is Draft 0.3.

### Minor Changes

- [#456](https://github.com/DavideCarvalho/adonis-agora-authkit/pull/456) [`9c12ef9`](https://github.com/DavideCarvalho/adonis-agora-authkit/commit/9c12ef9c1c49db9d54a7da6d241264499ad76e18) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - First release: the Personal Agent Protocol ("Poppy", Draft 0.3) as an extension of `@adonis-agora/authkit-server` 1.x — `personalAgents: { extensions: [poppy({ ... })] }`. Same options, routes, tables, tokens and global slots as the Poppy that was built into authkit-server 0.x; `poppyEmailCodeSignIn` takes `sendCode` in place of the old `mail.onPoppySignInCode` hook, `ensurePoppySchema()` creates its tables in a migration, and `node ace configure @adonis-agora/authkit-poppy` checks the install and shows the config change. Experimental: this package stays on 0.x while the spec is a draft.
