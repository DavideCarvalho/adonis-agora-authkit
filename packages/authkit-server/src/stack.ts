import app from '@adonisjs/core/services/app';

/**
 * What a store, adapter or keystore runs on, read by telescope's Architecture page from the config
 * (`authkit: accounts → PostgreSQL`). Shared through a global symbol, so this lib does not depend on
 * telescope.
 */
export const STACK_DESCRIPTOR = Symbol.for('@adonis-agora/stack');

export interface StackUse {
  /** `postgres`, `mysql`, `sqlite`, `redis`, `kms`, … */
  tech: string;
  /** The Lucid or Redis connection it goes through. */
  connection?: string;
  /** What it is for, in a few words. */
  purpose?: string;
  /** For what has no Lucid/Redis connection: a name (a database, a bucket). Never a secret. */
  label?: string;
  /** Tells two servers apart; hashed by telescope, never sent. */
  host?: string;
}

type Uses = StackUse | StackUse[] | (() => StackUse | StackUse[] | undefined);

/**
 * Attaches `uses` to `target` (non-enumerable). A function is resolved when read, after boot, so a
 * default connection is named as the app resolves it. Returns `target`.
 */
export function describeStackUse<T extends object>(target: T, uses: Uses): T {
  try {
    Object.defineProperty(target, STACK_DESCRIPTOR, {
      get() {
        try {
          const value = typeof uses === 'function' ? uses() : uses;
          return value === undefined ? [] : Array.isArray(value) ? value : [value];
        } catch {
          return [];
        }
      },
      enumerable: false,
      configurable: true,
    });
  } catch {
    // A frozen object: nothing to describe.
  }
  return target;
}

const SQL_TECH: Record<string, string> = {
  pg: 'postgres',
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  'better-sqlite3': 'sqlite',
  sqlite3: 'sqlite',
  sqlite: 'sqlite',
  libsql: 'sqlite',
  mssql: 'mssql',
};

function appConfig(key: string): Record<string, unknown> | undefined {
  try {
    const value = (
      app as { config?: { get(key: string, fallback?: unknown): unknown } } | undefined
    )?.config?.get(key, undefined);
    return value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function named(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Whether the app has a Lucid connection to fall back on (`config/database.ts`). */
export function hasLucidConnection(): boolean {
  return named(appConfig('database')?.connection) !== undefined;
}

/** A Lucid connection: `connection`, or the app's default connection when omitted. */
export function lucidUse(connection: string | undefined, purpose: string): StackUse {
  const database = appConfig('database');
  const name = connection ?? named(database?.connection);
  const connections = database?.connections as Record<string, { client?: unknown }> | undefined;
  const client = name ? connections?.[name]?.client : undefined;
  return {
    tech: SQL_TECH[String(client ?? '')] ?? 'sql',
    ...(name ? { connection: name } : {}),
    purpose,
  };
}

/** A Redis connection from `config/redis.ts`: `connection`, or the default one when omitted. */
export function redisUse(connection: string | undefined, purpose: string): StackUse {
  const name = connection ?? named(appConfig('redis')?.connection);
  return { tech: 'redis', ...(name ? { connection: name } : {}), purpose };
}

/** The uses `value` already describes (a store or KMS adapter tagged by its own lib). */
export function usesOf(value: unknown): StackUse[] {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return [];
  try {
    const described = (value as Record<symbol, unknown>)[STACK_DESCRIPTOR];
    return Array.isArray(described)
      ? described.filter(
          (use): use is StackUse =>
            use !== null && typeof use === 'object' && typeof (use as StackUse).tech === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

/** Host (and port) of a URL, without credentials; `undefined` when it does not parse. */
export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}
