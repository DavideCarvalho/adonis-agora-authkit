import type { OidcAdapter } from '../adapters/adapter_contract.js';
import { APP_NAME_PATTERN, CAPABILITY_PATTERN } from './config.js';

/**
 * authkit-owned keys in a persisted `Client` payload. oidc-provider strips unknown
 * metadata when it builds a `Client` (and when dynamic registration persists one), so
 * these keys can only be written by authkit itself (console, Admin API, CLI) and are
 * read straight from the adapter.
 */
export const SERVICE_TENANT_KEY = 'authkit_service_tenant';
export const CLIENT_DISABLED_KEY = 'authkit_disabled';
/** When authkit created the client (ISO 8601). A `/reg` client has `client_id_issued_at` instead. */
export const CLIENT_CREATED_AT_KEY = 'authkit_created_at';
/** When authkit last changed the client (ISO 8601). */
export const CLIENT_UPDATED_AT_KEY = 'authkit_updated_at';

/** The service-tenant part of a client. */
export interface ServiceTenantInfo {
  /** Partition (tenant) the client acts as. Emitted as the `partition` claim. */
  partition: string;
  /** Granted capabilities. Emitted as the `capabilities` claim when non-empty. */
  capabilities: string[];
  /** Environment the client acts in (`production`, `staging`, …). Emitted as the `environment` claim when set. */
  environment?: string;
  /**
   * Apps this client may call (calls between apps): target app name → capabilities on it.
   * Each one lets the client get tokens for `urn:agora:app:<name>`, whose `capabilities`
   * claim is that list (`partition` stays the client's own). Absent = none.
   */
  apps?: Record<string, string[]>;
}

/** At most this many target apps per client. */
export const MAX_APPS = 64;

/** Letters, digits, `.`, `_`, `:` and `-`; starts with a letter or digit; up to 128 chars. */
export const PARTITION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Like {@link PARTITION_PATTERN}, plus `*` and `/`. */
export { CAPABILITY_PATTERN };
export const MAX_CAPABILITIES = 64;
/** Letters, digits, `.`, `_` and `-`; starts with a letter or digit; up to 64 chars. */
export const ENVIRONMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Reads the service-tenant metadata from a raw client payload, or `null`. */
export function serviceTenantOf(
  payload: Record<string, unknown> | undefined | null,
): ServiceTenantInfo | null {
  const raw = payload?.[SERVICE_TENANT_KEY] as
    | { partition?: unknown; capabilities?: unknown; environment?: unknown; apps?: unknown }
    | undefined;
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.partition !== 'string' || !PARTITION_PATTERN.test(raw.partition)) return null;
  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities.filter((c): c is string => typeof c === 'string' && c.length > 0)
    : [];
  const environment =
    typeof raw.environment === 'string' && ENVIRONMENT_PATTERN.test(raw.environment)
      ? raw.environment
      : undefined;
  // Fail closed and visibly: a grant that would not pass `normalizeServiceTenant` (bad
  // name, bad capability) is dropped whole — never narrowed — and since the console, the
  // Admin API and issuance all read through here, none of them shows or honours it.
  const apps: Record<string, string[]> = {};
  if (raw.apps && typeof raw.apps === 'object' && !Array.isArray(raw.apps)) {
    for (const [name, caps] of Object.entries(raw.apps as Record<string, unknown>)) {
      if (!APP_NAME_PATTERN.test(name) || !Array.isArray(caps)) continue;
      if (!caps.every((c) => typeof c === 'string' && CAPABILITY_PATTERN.test(c))) continue;
      apps[name] = [...(caps as string[])];
    }
  }
  return {
    partition: raw.partition,
    capabilities,
    ...(environment ? { environment } : {}),
    ...(Object.keys(apps).length ? { apps } : {}),
  };
}

/** Validates one capability list. Returns an error message or the normalized list. */
function normalizeCapabilities(raw: unknown): string[] | string {
  if (!Array.isArray(raw)) return 'capabilities must be an array of strings';
  const capabilities: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return 'capabilities must be an array of strings';
    const cap = item.trim();
    if (!CAPABILITY_PATTERN.test(cap)) {
      return `capability "${cap}" is invalid: use letters, digits, ".", "_", ":", "*", "/" or "-" (max 128 chars)`;
    }
    if (!capabilities.includes(cap)) capabilities.push(cap);
  }
  if (capabilities.length > MAX_CAPABILITIES) {
    return `at most ${MAX_CAPABILITIES} capabilities per client`;
  }
  return capabilities;
}

/** Validates the `apps` grants. Returns an error message or the normalized map. */
function normalizeApps(raw: unknown): Record<string, string[]> | string {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return 'apps must map an app name to its capabilities';
  }
  const apps: Record<string, string[]> = {};
  for (const [rawName, caps] of Object.entries(raw as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!APP_NAME_PATTERN.test(name)) {
      return `app "${name}" is invalid: use letters, digits, ".", "_" or "-" (max 64 chars)`;
    }
    const capabilities = normalizeCapabilities(caps ?? []);
    if (typeof capabilities === 'string') return `apps.${name}: ${capabilities}`;
    apps[name] = capabilities;
  }
  if (Object.keys(apps).length > MAX_APPS) return `at most ${MAX_APPS} apps per client`;
  return apps;
}

/** `true` when the raw client payload is disabled. */
export function isClientDisabled(payload: Record<string, unknown> | undefined | null): boolean {
  return payload?.[CLIENT_DISABLED_KEY] === true;
}

/**
 * Validates and normalizes service-tenant input. Returns an error message or the
 * normalized value (trimmed, de-duplicated capabilities).
 */
export function normalizeServiceTenant(input: {
  partition: string;
  capabilities?: string[];
  environment?: string | null;
  apps?: Record<string, string[]> | null;
}): ServiceTenantInfo | string {
  // Called directly too (not only behind the HTTP validators): check the types here.
  const rawPartition: unknown = input?.partition;
  const partition = typeof rawPartition === 'string' ? rawPartition.trim() : '';
  if (!PARTITION_PATTERN.test(partition)) {
    return `partition "${partition}" is invalid: use letters, digits, ".", "_", ":" or "-" (max 128 chars)`;
  }
  const capabilities = normalizeCapabilities(input.capabilities ?? []);
  if (typeof capabilities === 'string') return capabilities;
  const apps = normalizeApps(input.apps);
  if (typeof apps === 'string') return apps;
  const withApps = Object.keys(apps).length ? { apps } : {};
  const rawEnvironment: unknown = input.environment ?? undefined;
  if (rawEnvironment === undefined || rawEnvironment === '') {
    return { partition, capabilities, ...withApps };
  }
  if (typeof rawEnvironment !== 'string') return 'environment must be a string';
  const environment = rawEnvironment.trim();
  if (environment === '') return { partition, capabilities, ...withApps };
  if (!ENVIRONMENT_PATTERN.test(environment)) {
    return `environment "${environment}" is invalid: use letters, digits, ".", "_" or "-" (max 64 chars)`;
  }
  return { partition, capabilities, environment, ...withApps };
}

/**
 * Wraps the provider's `Client` adapter so a disabled client is "not found": every
 * endpoint answers `invalid_client` from the next request on, on every instance that
 * shares the adapter. Writes are untouched.
 */
export function hideDisabledClients<T extends OidcAdapter>(adapter: T): T {
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === 'find') {
        return async (id: string) => {
          const payload = await target.find(id);
          return isClientDisabled(payload as Record<string, unknown> | undefined)
            ? undefined
            : payload;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
