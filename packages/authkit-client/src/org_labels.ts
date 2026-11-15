/**
 * Organization display labels on a relying-party app, for the org pickers of every
 * `@adonis-agora` console (`Context.tenantLabels`). The active org's name comes from the
 * session's `org_name` claim; any other id is asked to the authkit server
 * (`GET /api/orgs/labels?ids=`, authenticated with this app's client id and secret) and
 * cached.
 */

import type { Identity } from '@adonis-agora/authkit-core';

/** `(ids, { kind? }) => { [id]: label }`, the shape `@adonis-agora/context` expects. */
export type OrgLabelResolver = (
  ids: readonly string[],
  options?: { kind?: string },
) => Promise<Record<string, string>>;

export interface AuthkitOrgLabelsOptions {
  /** Issuer URL of the authkit server. */
  issuer: string;
  /** This app's client id (a confidential, first-party client of the authkit server). */
  clientId: string;
  /** This app's client secret. */
  clientSecret: string;
  /** The labels endpoint. Default: `/api/orgs/labels` on the issuer's origin. */
  endpoint?: string;
  /** How long a fetched label (or a miss) is reused, in ms. Default: 5 minutes. */
  ttlMs?: number;
  /** Abort a labels request after this many ms. Default: 5000. */
  timeoutMs?: number;
  /** Custom `fetch` (proxy, tests). Default: the global `fetch`. */
  fetch?: typeof fetch;
}

/** Default path of authkit-server's labels endpoint. */
export const ORG_LABELS_PATH = '/api/orgs/labels';
const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_CACHE = 2_000;
/** Ids per request: the server answers at most 100. */
const BATCH = 100;

/** Labels learned from session claims (`org_id` + `org_name`), newest last. */
const fromClaims = new Map<string, string>();

function bounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_CACHE) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * Records the active org's name from a resolved session (`org_name` claim), so the
 * labeler answers it with no call. Called by the `Authenticator`; best effort.
 */
export function rememberOrgLabel(identity: Identity | null | undefined): void {
  try {
    const id = identity?.orgId;
    const name = identity?.raw?.org_name;
    if (typeof id === 'string' && id && typeof name === 'string' && name) {
      if (fromClaims.get(id) !== name) bounded(fromClaims, id, name);
    }
  } catch {
    // never breaks the request
  }
}

/** Clears the labels learned from claims (tests). */
export function __clearOrgLabelsForTests(): void {
  fromClaims.clear();
}

function defaultEndpoint(issuer: string): string {
  return new URL(ORG_LABELS_PATH, issuer).href;
}

/**
 * A label resolver backed by the authkit server. Ids of another tenant kind (`kind` other
 * than `'organization'`) get no label. Never throws: an unreachable server answers what is
 * already known, and the ids it could not resolve show as ids.
 */
export function authkitOrgLabels(options: AuthkitOrgLabelsOptions): OrgLabelResolver {
  if (!options?.issuer || !options.clientId || !options.clientSecret) {
    throw new TypeError('authkitOrgLabels: issuer, clientId and clientSecret are required');
  }
  const endpoint = options.endpoint ?? defaultEndpoint(options.issuer);
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const doFetch = options.fetch ?? globalThis.fetch;
  const basic = Buffer.from(
    `${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`,
  ).toString('base64');
  /** id → label (or `null` for "not an authkit org") until `expiresAt`. */
  const cache = new Map<string, { label: string | null; expiresAt: number }>();

  const fetchBatch = async (ids: string[]): Promise<Record<string, string> | null> => {
    const url = new URL(endpoint);
    url.searchParams.set('ids', ids.join(','));
    try {
      const res = await doFetch(url.href, {
        headers: { authorization: `Basic ${basic}`, accept: 'application/json' },
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { labels?: unknown };
      const labels = body?.labels;
      if (!labels || typeof labels !== 'object') return null;
      const out: Record<string, string> = {};
      for (const [id, label] of Object.entries(labels as Record<string, unknown>)) {
        if (typeof label === 'string' && label) out[id] = label;
      }
      return out;
    } catch {
      return null;
    }
  };

  return async (ids, opts) => {
    if (opts?.kind !== undefined && opts.kind !== 'organization') return {};
    const wanted = [
      ...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id)),
    ];
    const result: Record<string, string> = {};
    const missing: string[] = [];
    const now = Date.now();
    for (const id of wanted) {
      const claimed = fromClaims.get(id);
      if (claimed) {
        result[id] = claimed;
        continue;
      }
      const hit = cache.get(id);
      if (hit && hit.expiresAt > now) {
        if (hit.label) result[id] = hit.label;
        continue;
      }
      missing.push(id);
    }
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const fetched = await fetchBatch(batch);
      if (!fetched) continue; // not cached: the next call retries
      const expiresAt = Date.now() + ttl;
      for (const id of batch) {
        const label = fetched[id] ?? null;
        bounded(cache, id, { label, expiresAt });
        if (label) result[id] = label;
      }
    }
    return result;
  };
}

/** The `@adonis-agora/context` tenancy slot, read structurally. */
interface TenancySlotLike {
  version?: unknown;
  setTenantLabeler?: (resolver: OrgLabelResolver | undefined) => void;
}

const TENANCY_SLOT = Symbol.for('@agora/context:tenancy');

/**
 * Registers `resolver` as the context's tenant labeler (`Context.setTenantLabeler`), so
 * console org pickers show names. `tenancy.label` in `config/context.ts` still wins.
 * Returns `false` (and does nothing) without `@adonis-agora/context`.
 */
export function installOrgLabeler(resolver: OrgLabelResolver): boolean {
  try {
    const slot = (globalThis as Record<symbol, unknown>)[TENANCY_SLOT] as
      | TenancySlotLike
      | undefined;
    if (!slot || slot.version !== 1 || typeof slot.setTenantLabeler !== 'function') return false;
    slot.setTenantLabeler(resolver);
    return true;
  } catch {
    return false;
  }
}
