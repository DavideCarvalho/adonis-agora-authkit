/**
 * The app permission catalog: what each Agora app accepts from the other apps, published by the
 * app itself (`@adonis-agora/authkit-client` at boot, authenticated with its service tenant's
 * client id and secret) into the lib-owned table `auth_app_catalog`. The console's "Apps it can
 * call" editor offers it; the CLI and the Admin API list it. Nothing here grants anything:
 * grants stay on the client (`apps`).
 */
import { timingSafeEqual } from 'node:crypto';
import type { OidcAdapter } from '../adapters/adapter_contract.js';
import type { OidcAdapterClass } from '../adapters/factory.js';
import { authkitTable } from '../schema/tables_location.js';
import { isClientDisabled, serviceTenantOf } from './client_metadata.js';
import { APP_NAME_PATTERN, CAPABILITY_PATTERN } from './config.js';

export const APP_CATALOG_TABLE = 'auth_app_catalog';
/** Default path of the publish endpoint (`PUT /api/apps/catalog`), on the issuer's origin. */
export const APP_CATALOG_PATH = '/api/apps/catalog';
/** At most this many capabilities per app. */
export const MAX_CATALOG_CAPABILITIES = 1000;

export interface AppCatalogEntry {
  app: string;
  capabilities: string[];
  /** When the app first published its catalog, or `null` for a row older than the column. */
  createdAt: Date | null;
  /** When the catalog was last published, or `null` for an unreadable legacy value. */
  updatedAt: Date | null;
}

/** A stored timestamp as a `Date`, or `null` when it is missing or unreadable (a legacy row). */
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date =
    value instanceof Date
      ? value
      : typeof value === 'number'
        ? new Date(value)
        : typeof value === 'string' && /^\d+$/.test(value)
          ? new Date(Number(value))
          : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseCapabilities(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}

/** The capabilities of a publish, de-duplicated and sorted, or an error message. */
export function validateCatalog(raw: unknown): string[] | { error: string } {
  if (!Array.isArray(raw)) return { error: '`capabilities` must be an array of strings' };
  if (raw.length > MAX_CATALOG_CAPABILITIES) {
    return { error: `at most ${MAX_CATALOG_CAPABILITIES} capabilities` };
  }
  const out = new Set<string>();
  for (const cap of raw) {
    if (typeof cap !== 'string' || !CAPABILITY_PATTERN.test(cap)) {
      return {
        error: `invalid capability ${JSON.stringify(cap)} (letters, digits, ".", "_", ":", "*", "/" and "-")`,
      };
    }
    out.add(cap);
  }
  return [...out].sort();
}

/** How long an insert keeps skipping a missing `created_at` before trying it again. */
const CREATED_AT_RECHECK_MS = 60_000;

/**
 * Per table, until when inserts skip `created_at` (the column was missing). Module-level because
 * the publish handler builds a store per request.
 */
const noCreatedAtUntil = new Map<string, number>();

/** The driver said the column does not exist: Postgres 42703, MySQL 1054, SQLite "no column". */
function isMissingCreatedAt(error: unknown): boolean {
  const e = error as { code?: unknown; errno?: unknown; message?: unknown };
  const message = typeof e?.message === 'string' ? e.message : String(error);
  if (!/created_at/i.test(message)) return false;
  return (
    e?.code === '42703' ||
    e?.code === 'ER_BAD_FIELD_ERROR' ||
    e?.errno === 1054 ||
    /no column named|no such column|unknown column|does not exist/i.test(message)
  );
}

/** Rows of `auth_app_catalog`: one per app. */
export class AppCatalogStore {
  #conn: () => any;
  #table: string;
  #now: () => number;

  constructor(
    conn: () => any,
    options: { now?: () => number; table?: (name: string) => string } = {},
  ) {
    this.#conn = conn;
    this.#table = (options.table ?? ((name: string) => name))(APP_CATALOG_TABLE);
    this.#now = options.now ?? Date.now;
  }

  /** Every app's catalog, by app name. */
  async list(): Promise<AppCatalogEntry[]> {
    const rows = await this.#conn().from(this.#table).orderBy('app', 'asc');
    return rows.map((row: any) => ({
      app: row.app,
      capabilities: parseCapabilities(row.capabilities),
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.updated_at),
    }));
  }

  /** The app's catalog, or `null` when it never published one. */
  async find(app: string): Promise<AppCatalogEntry | null> {
    const row = await this.#conn().from(this.#table).where('app', app).first();
    return row
      ? {
          app: row.app,
          capabilities: parseCapabilities(row.capabilities),
          createdAt: toDate(row.created_at),
          updatedAt: toDate(row.updated_at),
        }
      : null;
  }

  /** Replaces the app's catalog. */
  async put(app: string, capabilities: string[]): Promise<AppCatalogEntry> {
    const now = new Date(this.#now());
    const values = { capabilities: JSON.stringify(capabilities), updated_at: now };
    const existing = await this.#conn().from(this.#table).where('app', app).first();
    if (existing) {
      await this.#conn().from(this.#table).where('app', app).update(values);
      const createdAt = toDate(existing.created_at);
      return { app, capabilities, createdAt, updatedAt: now };
    }
    if (this.#createdAtColumn()) {
      try {
        await this.#conn()
          .table(this.#table)
          .insert({ app, ...values, created_at: now });
        return { app, capabilities, createdAt: now, updatedAt: now };
      } catch (error) {
        // A table that predates `created_at` and whose schema nobody manages here
        // (`schema.autoManage: false`, e.g. a second server sharing the identity tables).
        if (!isMissingCreatedAt(error)) throw error;
        noCreatedAtUntil.set(this.#table, this.#now() + CREATED_AT_RECHECK_MS);
      }
    }
    await this.#conn()
      .table(this.#table)
      .insert({ app, ...values });
    return { app, capabilities, createdAt: null, updatedAt: now };
  }

  /** `false` for a while after an insert found no `created_at` column; tried again after that. */
  #createdAtColumn(): boolean {
    return this.#now() >= (noCreatedAtUntil.get(this.#table) ?? 0);
  }

  /** Forgets the app's catalog. `true` when there was one. */
  async delete(app: string): Promise<boolean> {
    const count = await this.#conn().from(this.#table).where('app', app).delete();
    return Number(Array.isArray(count) ? count[0] : count) > 0;
  }
}

/**
 * The catalog store for this server, or `null` without a database (`lucid.db`). Tables live where
 * `schema.connection` / `schema.name` say, like every authkit table.
 */
export async function appCatalogStoreOf(
  service: { config: { schema: { connection?: string; name?: string } } },
  makeDb: () => Promise<any>,
): Promise<AppCatalogStore | null> {
  const db = await makeDb().catch(() => null);
  if (!db) return null;
  const connection = service.config.schema.connection;
  return new AppCatalogStore(() => (connection ? db.connection(connection) : db.connection()), {
    table: (name) => authkitTable({ schema: service.config.schema.name }, name),
  });
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The app a publish authenticates as (its service tenant's `partition`), or `null`: an enabled
 * service-tenant client whose secret matches, with a valid app name.
 */
export async function authenticateCatalogPublisher(
  AdapterClass: OidcAdapterClass,
  credentials: { clientId: string; clientSecret: string } | null,
): Promise<string | null> {
  if (!credentials) return null;
  const adapter = new (AdapterClass as any)('Client') as OidcAdapter;
  const payload = (await adapter.find(credentials.clientId)) as Record<string, unknown> | undefined;
  if (!payload) return null;
  const secret = payload.client_secret;
  if (typeof secret !== 'string' || !secret) return null;
  if (!sameSecret(credentials.clientSecret, secret)) return null;
  if (isClientDisabled(payload)) return null;
  const tenant = serviceTenantOf(payload);
  if (!tenant || !APP_NAME_PATTERN.test(tenant.partition)) return null;
  return tenant.partition;
}

/** JSON shape of a catalog entry in the console and the Admin API. */
export function presentCatalog(entry: AppCatalogEntry) {
  return {
    app: entry.app,
    capabilities: entry.capabilities,
    createdAt: entry.createdAt ? entry.createdAt.toISOString() : null,
    updatedAt: entry.updatedAt ? entry.updatedAt.toISOString() : null,
  };
}
