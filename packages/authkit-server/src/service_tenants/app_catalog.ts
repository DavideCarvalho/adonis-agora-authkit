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
  updatedAt: Date;
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return new Date(Number(value));
  return new Date(String(value));
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
      createdAt: row.created_at ? toDate(row.created_at) : null,
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
          createdAt: row.created_at ? toDate(row.created_at) : null,
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
      const createdAt = existing.created_at ? toDate(existing.created_at) : null;
      return { app, capabilities, createdAt, updatedAt: now };
    }
    await this.#conn()
      .table(this.#table)
      .insert({ app, ...values, created_at: now });
    return { app, capabilities, createdAt: now, updatedAt: now };
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
    updatedAt: entry.updatedAt.toISOString(),
  };
}
