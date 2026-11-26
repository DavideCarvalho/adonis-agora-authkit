/**
 * The app key directory: public keys an Agora app publishes about itself (e.g. the public key the
 * federated console seals commands to, under `console:<lib>`), so the other libs read them from
 * the Hub instead of copying keys between apps. Published by the app's own service-tenant client
 * (`PUT /api/apps/keys`, same credentials as the catalog) and read by any authenticated service
 * client (`GET /api/apps/:app/keys?purpose=`). Public OKP keys only: a private key (`d`) is refused.
 *
 * Lib-owned table `auth_app_keys`, one row per (app, purpose).
 */
import { authkitTable } from '../schema/tables_location.js';

export const APP_KEYS_TABLE = 'auth_app_keys';
/** Default path of the publish endpoint, on the issuer's origin. */
export const APP_KEYS_PATH = '/api/apps/keys';
/** The read endpoint: `GET /api/apps/:app/keys?purpose=`. */
export const APP_KEYS_READ_PATH = '/api/apps/:app/keys';

/** `console:durable`, `webhooks`, … */
export const KEY_PURPOSE_PATTERN = /^[a-z0-9:_-]{1,64}$/;
/** Purposes in one publish. */
export const MAX_KEY_PURPOSES = 16;
/** Keys per purpose (room for a rotation overlap). */
export const MAX_KEYS_PER_PURPOSE = 4;
/** Characters of one serialized JWK. */
export const MAX_JWK_CHARS = 2048;

const OKP_CURVES = new Set(['Ed25519', 'Ed448', 'X25519', 'X448']);
const PUBLIC_JWK_MEMBERS = new Set(['kty', 'crv', 'x', 'kid', 'use', 'alg', 'key_ops']);
const B64URL = /^[A-Za-z0-9_-]+$/;

/** A public OKP JWK (RFC 8037). */
export interface PublicOkpJwk {
  kty: 'OKP';
  crv: string;
  x: string;
  kid?: string;
  use?: string;
  alg?: string;
  key_ops?: string[];
}

export interface AppKeysEntry {
  app: string;
  purpose: string;
  keys: PublicOkpJwk[];
  updatedAt: Date | null;
}

/** One JWK, checked: public OKP only (never `d`), known members, bounded. */
function validateJwk(raw: unknown, where: string): PublicOkpJwk | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `${where}: \`jwk\` must be an object` };
  }
  const jwk = raw as Record<string, unknown>;
  if ('d' in jwk) {
    return { error: `${where}: a private key (\`d\`) is never published; send the public JWK` };
  }
  for (const member of Object.keys(jwk)) {
    if (!PUBLIC_JWK_MEMBERS.has(member)) {
      return { error: `${where}: unexpected JWK member \`${member}\`` };
    }
  }
  if (jwk.kty !== 'OKP') return { error: `${where}: only OKP keys (\`kty: "OKP"\`)` };
  if (typeof jwk.crv !== 'string' || !OKP_CURVES.has(jwk.crv)) {
    return { error: `${where}: \`crv\` must be one of ${[...OKP_CURVES].join(', ')}` };
  }
  if (typeof jwk.x !== 'string' || !B64URL.test(jwk.x) || jwk.x.length > 128) {
    return { error: `${where}: \`x\` must be the base64url public key` };
  }
  for (const member of ['kid', 'use', 'alg'] as const) {
    if (jwk[member] !== undefined && (typeof jwk[member] !== 'string' || jwk[member] === '')) {
      return { error: `${where}: \`${member}\` must be a non-empty string` };
    }
  }
  if (
    jwk.key_ops !== undefined &&
    (!Array.isArray(jwk.key_ops) || jwk.key_ops.some((op) => typeof op !== 'string'))
  ) {
    return { error: `${where}: \`key_ops\` must be an array of strings` };
  }
  if (JSON.stringify(jwk).length > MAX_JWK_CHARS) {
    return { error: `${where}: the JWK is larger than ${MAX_JWK_CHARS} characters` };
  }
  return jwk as unknown as PublicOkpJwk;
}

/**
 * The keys of a publish (`{ keys: [{ purpose, jwk }] }`) grouped by purpose, or an error message.
 * Each purpose in the body replaces that purpose's keys; the others are left alone.
 */
export function validateAppKeys(raw: unknown): Map<string, PublicOkpJwk[]> | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: '`keys` must be a non-empty array of `{ purpose, jwk }`' };
  }
  const byPurpose = new Map<string, PublicOkpJwk[]>();
  for (const [i, item] of raw.entries()) {
    const where = `keys[${i}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: `${where} must be \`{ purpose, jwk }\`` };
    }
    const { purpose, jwk } = item as { purpose?: unknown; jwk?: unknown };
    if (typeof purpose !== 'string' || !KEY_PURPOSE_PATTERN.test(purpose)) {
      return {
        error: `${where}: \`purpose\` must match ${KEY_PURPOSE_PATTERN} (e.g. "console:durable")`,
      };
    }
    const checked = validateJwk(jwk, where);
    if ('error' in checked) return checked;
    const list = byPurpose.get(purpose) ?? [];
    if (!list.some((k) => k.crv === checked.crv && k.x === checked.x)) list.push(checked);
    if (list.length > MAX_KEYS_PER_PURPOSE) {
      return { error: `at most ${MAX_KEYS_PER_PURPOSE} keys per purpose ("${purpose}")` };
    }
    byPurpose.set(purpose, list);
    if (byPurpose.size > MAX_KEY_PURPOSES) {
      return { error: `at most ${MAX_KEY_PURPOSES} purposes per publish` };
    }
  }
  return byPurpose;
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date =
    value instanceof Date
      ? value
      : typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))
        ? new Date(Number(value))
        : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseKeys(raw: unknown): PublicOkpJwk[] {
  if (typeof raw !== 'string') return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((k): k is PublicOkpJwk => !('error' in validateJwk(k, 'stored')));
  } catch {
    return [];
  }
}

/** Rows of `auth_app_keys`: one per (app, purpose). */
export class AppKeysStore {
  #conn: () => any;
  #table: string;
  #now: () => number;

  constructor(
    conn: () => any,
    options: { now?: () => number; table?: (name: string) => string } = {},
  ) {
    this.#conn = conn;
    this.#table = (options.table ?? ((name: string) => name))(APP_KEYS_TABLE);
    this.#now = options.now ?? Date.now;
  }

  #entry(row: any): AppKeysEntry {
    return {
      app: row.app,
      purpose: row.purpose,
      keys: parseKeys(row.keys),
      updatedAt: toDate(row.updated_at),
    };
  }

  /** The app's keys for `purpose`, or `null` when it published none. */
  async find(app: string, purpose: string): Promise<AppKeysEntry | null> {
    const row = await this.#conn()
      .from(this.#table)
      .where('app', app)
      .where('purpose', purpose)
      .first();
    if (!row) return null;
    const entry = this.#entry(row);
    return entry.keys.length ? entry : null;
  }

  /** Every published (app, purpose), by app then purpose. */
  async list(app?: string): Promise<AppKeysEntry[]> {
    let query = this.#conn().from(this.#table);
    if (app) query = query.where('app', app);
    const rows = await query.orderBy('app', 'asc').orderBy('purpose', 'asc');
    return rows.map((row: any) => this.#entry(row));
  }

  /** Replaces the app's keys for each purpose given. */
  async put(app: string, byPurpose: Map<string, PublicOkpJwk[]>): Promise<AppKeysEntry[]> {
    const now = new Date(this.#now());
    const out: AppKeysEntry[] = [];
    for (const [purpose, keys] of byPurpose) {
      const values = { keys: JSON.stringify(keys), updated_at: now };
      const existing = await this.#conn()
        .from(this.#table)
        .where('app', app)
        .where('purpose', purpose)
        .first();
      if (existing) {
        await this.#conn()
          .from(this.#table)
          .where('app', app)
          .where('purpose', purpose)
          .update(values);
      } else {
        await this.#conn()
          .table(this.#table)
          .insert({ app, purpose, ...values, created_at: now });
      }
      out.push({ app, purpose, keys, updatedAt: now });
    }
    return out;
  }
}

/** The key store for this server, or `null` without a database (`lucid.db`). */
export async function appKeysStoreOf(
  service: { config: { schema: { connection?: string; name?: string } } },
  makeDb: () => Promise<any>,
): Promise<AppKeysStore | null> {
  const db = await makeDb().catch(() => null);
  if (!db) return null;
  const connection = service.config.schema.connection;
  return new AppKeysStore(() => (connection ? db.connection(connection) : db.connection()), {
    table: (name) => authkitTable({ schema: service.config.schema.name }, name),
  });
}

/** JSON shape of an entry. */
export function presentAppKeys(entry: AppKeysEntry) {
  return {
    app: entry.app,
    purpose: entry.purpose,
    keys: entry.keys,
    updatedAt: entry.updatedAt ? entry.updatedAt.toISOString() : null,
  };
}
