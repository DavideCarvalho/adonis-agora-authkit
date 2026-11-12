/**
 * Where AuthKit's OWN tables live (`auth_settings`, `auth_mfa`, `auth_password_history`,
 * the organization tables, `authkit_oidc_payloads`, the personal-agent tables, the
 * `authkit_keystore` of the Lucid keystore, and the tables of agent extensions).
 *
 * The rule: every lib-owned table goes through `schema.connection` of `defineConfig`
 * (default: the primary Lucid connection) and, with `schema.name`, lives in that database
 * schema (MySQL: that database). The app's account table is not lib-owned: it stays on the
 * account model's connection and table (`static connection`/`static table` of the model).
 *
 * The schema is written INTO every statement (`"auth"."auth_settings"`). Never put
 * AuthKit's tables in another schema with a connection `searchPath`: knex sends
 * `SET search_path` on the session, and behind PgBouncer in transaction mode that leaks to
 * other clients' connections.
 */
export interface AuthkitTablesLocation {
  /** Lucid connection name. `undefined` = the primary connection. */
  connection?: string;
  /** Database schema of the tables (MySQL: the database). `undefined` = the connection's default. */
  schema?: string;
}

/** Raised for a `schema.name` the database cannot use. The provider fails the boot with it. */
export class AuthkitSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthkitSchemaError';
  }
}

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Throws {@link AuthkitSchemaError} unless `name` is a plain identifier of at most 63 chars. */
export function validateSchemaName(name: unknown, option = 'schema.name'): string | undefined {
  if (name === undefined) return undefined;
  if (typeof name !== 'string' || name.length > 63 || !SCHEMA_NAME.test(name)) {
    throw new AuthkitSchemaError(
      `authkit: ${option} must match /^[A-Za-z_][A-Za-z0-9_$]*$/ and have at most 63 characters (got ${JSON.stringify(name)})`,
    );
  }
  return name;
}

/** `schema.table` when a schema is set (knex quotes each part: `"schema"."table"`), else `table`. */
export function authkitTable(location: AuthkitTablesLocation | undefined, table: string): string {
  return location?.schema ? `${location.schema}.${table}` : table;
}

/**
 * The query client for AuthKit's tables. `db` is the Lucid manager (`Database`) or a
 * client the caller already holds (a migration's `this.db`, a transaction), which is
 * used as is.
 */
export function authkitTablesClient(db: any, location: AuthkitTablesLocation = {}): any {
  if (typeof db?.connection !== 'function') return db;
  return location.connection ? db.connection(location.connection) : db.connection();
}

const SQLITE_DIALECTS: ReadonlySet<string> = new Set(['sqlite3', 'better-sqlite3', 'libsql']);
/** Dialects AuthKit writes and creates schemas on. */
const SCHEMA_DIALECTS: ReadonlySet<string> = new Set(['postgres', 'redshift', 'mysql']);

/** The Lucid dialect name of a client or manager (`postgres`, `mysql`, `better-sqlite3`…). */
export function dialectOf(client: any): string | undefined {
  return client?.dialect?.name;
}

/**
 * Throws {@link AuthkitSchemaError} when `schema` is set on a dialect AuthKit cannot use it on:
 * SQLite (no schemas) and any dialect other than Postgres and MySQL. AuthKit never ignores the
 * option nor falls back to unqualified tables.
 */
export function assertSchemaSupported(client: any, schema: string | undefined): void {
  if (!schema) return;
  const dialect = dialectOf(client);
  if (!dialect || SCHEMA_DIALECTS.has(dialect)) return;
  throw new AuthkitSchemaError(
    SQLITE_DIALECTS.has(dialect)
      ? `authkit: schema.name "${schema}" is set, but the connection uses ${dialect}, which has no schemas. Remove schema.name or use Postgres or MySQL.`
      : `authkit: schema.name "${schema}" is set, but the connection uses ${dialect}; schema.name supports Postgres and MySQL. Remove schema.name or use one of them.`,
  );
}

/**
 * `CREATE SCHEMA IF NOT EXISTS` (Postgres) / `CREATE DATABASE IF NOT EXISTS` (MySQL). A role
 * that cannot create it gets an {@link AuthkitSchemaError} naming the schema and the grant.
 */
export async function createDbSchema(client: any, schema: string): Promise<void> {
  assertSchemaSupported(client, schema);
  const dialect = dialectOf(client);
  const mysql = dialect === 'mysql';
  const sql = mysql
    ? `create database if not exists \`${schema}\``
    : `create schema if not exists "${schema}"`;
  try {
    await client.rawQuery(sql);
  } catch (error) {
    const grant = mysql
      ? `GRANT CREATE ON *.* (or create it: CREATE DATABASE \`${schema}\`)`
      : `GRANT CREATE ON DATABASE <db> TO <role> (or create it: CREATE SCHEMA "${schema}")`;
    throw new AuthkitSchemaError(
      `authkit: could not create schema "${schema}" (${(error as Error)?.message ?? error}). The database role needs ${grant}.`,
    );
  }
}

/**
 * Hidden hook a store built by `lucidAccountStore` exposes so `defineConfig` can tell it
 * where AuthKit's tables live (the store is built before `defineConfig` sees the `schema`
 * option). Not part of the `AccountStore` contract.
 */
export const BIND_TABLES_LOCATION: unique symbol = Symbol.for('authkit.bindTablesLocation');

/** Hands `location` to a store that accepts it (see {@link BIND_TABLES_LOCATION}). */
export function bindTablesLocation(store: unknown, location: AuthkitTablesLocation): void {
  const bind = (store as any)?.[BIND_TABLES_LOCATION];
  if (typeof bind === 'function') bind(location);
}
