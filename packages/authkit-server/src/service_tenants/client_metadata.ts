import type { OidcAdapter } from '../adapters/adapter_contract.js';

/**
 * authkit-owned keys in a persisted `Client` payload. oidc-provider strips unknown
 * metadata when it builds a `Client` (and when dynamic registration persists one), so
 * these keys can only be written by authkit itself (console, Admin API, CLI) and are
 * read straight from the adapter.
 */
export const SERVICE_TENANT_KEY = 'authkit_service_tenant';
export const CLIENT_DISABLED_KEY = 'authkit_disabled';

/** The service-tenant part of a client. */
export interface ServiceTenantInfo {
  /** Partition (tenant) the client acts as. Emitted as the `partition` claim. */
  partition: string;
  /** Granted capabilities. Emitted as the `capabilities` claim when non-empty. */
  capabilities: string[];
}

/** Letters, digits, `.`, `_`, `:` and `-`; starts with a letter or digit; up to 128 chars. */
export const PARTITION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Like {@link PARTITION_PATTERN}, plus `*` and `/`. */
export const CAPABILITY_PATTERN = /^[A-Za-z0-9*][A-Za-z0-9._:*/-]{0,127}$/;
export const MAX_CAPABILITIES = 64;

/** Reads the service-tenant metadata from a raw client payload, or `null`. */
export function serviceTenantOf(
  payload: Record<string, unknown> | undefined | null,
): ServiceTenantInfo | null {
  const raw = payload?.[SERVICE_TENANT_KEY] as
    | { partition?: unknown; capabilities?: unknown }
    | undefined;
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.partition !== 'string' || !PARTITION_PATTERN.test(raw.partition)) return null;
  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities.filter((c): c is string => typeof c === 'string' && c.length > 0)
    : [];
  return { partition: raw.partition, capabilities };
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
}): ServiceTenantInfo | string {
  const partition = input.partition.trim();
  if (!PARTITION_PATTERN.test(partition)) {
    return `partition "${partition}" is invalid: use letters, digits, ".", "_", ":" or "-" (max 128 chars)`;
  }
  const capabilities: string[] = [];
  for (const raw of input.capabilities ?? []) {
    const cap = raw.trim();
    if (!CAPABILITY_PATTERN.test(cap)) {
      return `capability "${cap}" is invalid: use letters, digits, ".", "_", ":", "*", "/" or "-" (max 128 chars)`;
    }
    if (!capabilities.includes(cap)) capabilities.push(cap);
  }
  if (capabilities.length > MAX_CAPABILITIES) {
    return `at most ${MAX_CAPABILITIES} capabilities per client`;
  }
  return { partition, capabilities };
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
