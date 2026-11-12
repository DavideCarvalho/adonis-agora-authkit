---
'@adonis-agora/authkit-server': minor
'@adonis-agora/authkit-core': minor
'@adonis-agora/authkit-client': minor
'@adonis-agora/authkit-poppy': patch
---

AuthKit's tables can live in their own database schema: `schema: { name: 'auth' }` in `defineConfig` puts every table AuthKit owns in `auth` (`"auth"."auth_settings"`) while the app stays in `public`. The schema is written into every statement, so it works on any connection and inside the app's own transaction, with no `searchPath` (which leaks across clients behind PgBouncer in transaction mode).

- The boot creates the schema (`CREATE SCHEMA IF NOT EXISTS`; MySQL: `CREATE DATABASE IF NOT EXISTS`) when `autoManage` is on, and fails with a message naming the schema and the grant when the role cannot create it. `ensureAuthkitSchema(db, { schema })` does the same from a migration.
- Covers the OIDC adapter table (`adapters.database({ schema })` overrides), the Lucid keystore (`jwks.store: { driver: 'lucid', schema }` overrides), the account store's tables (MFA, password history, organizations), runtime settings, session revocations, the personal-agent tables and agent extensions (`PersonalAgentHost.table(name)`, `AuthkitTable.create(table, { table })`, `ensureAuthkitTables(db, tables, { schema })`; Poppy uses them and `ensurePoppySchema(db, { schema })`).
- authkit-client: `lucidRevocationStore({ schema })`.
- SQLite with `schema.name` fails the boot instead of ignoring the option.
- `agora:doctor` gains `authkit.db-schema`: the schema exists, the tables are in it, the connection can write there. Silent without `schema.name`.
- The key-rotation lock key includes the schema, so two installs in two schemas of one database do not share it.

Without `schema.name` nothing changes.
