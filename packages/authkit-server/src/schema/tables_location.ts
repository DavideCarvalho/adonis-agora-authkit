/**
 * Where AuthKit's OWN tables live (`auth_settings`, `auth_mfa`, `auth_password_history`,
 * the organization tables, `authkit_oidc_payloads`, the personal-agent tables, the
 * `authkit_keystore` of the Lucid keystore, and the tables of agent extensions).
 *
 * The rule: every lib-owned table goes through `schema.connection` of `defineConfig`
 * (default: the primary Lucid connection). The app's account table is not lib-owned: it
 * stays on the account model's connection (`static connection` of the model).
 */
export interface AuthkitTablesLocation {
  /** Lucid connection name. `undefined` = the primary connection. */
  connection?: string;
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
