# @adonis-agora/authkit-poppy

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
