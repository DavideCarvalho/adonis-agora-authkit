import { DiscoveryError } from './errors.js';
import type { AuthServerMetadata, PoppyDocument } from './types.js';
import {
  type FetchLike,
  isLoopbackHost,
  normalizeDomain,
  requireSecureUrl,
  type SecurityOptions,
} from './util.js';

/** Major protocol versions this client implements (3.1). */
export const SUPPORTED_MAJOR_VERSIONS = ['0'];

const MAX_REDIRECTS = 5;

export interface DiscoveryOptions extends SecurityOptions {
  fetch?: FetchLike;
  /** Shared cache honoring `Cache-Control: max-age` (3, 3.2: SHOULD cache). */
  cache?: HttpJsonCache;
}

export interface Discovered {
  /** The host the agent asked for (no scheme), e.g. `example.com`. */
  domain: string;
  wellKnownUrl: string;
  document: PoppyDocument;
  /** Absent only when the Company publishes no `auth` (web-only). */
  metadata?: AuthServerMetadata;
}

/** In-memory cache of JSON documents by URL, by `Cache-Control: max-age`. */
export class HttpJsonCache {
  private readonly entries = new Map<string, { expires: number; value: unknown }>();
  get(url: string): unknown | undefined {
    const e = this.entries.get(url);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.entries.delete(url);
      return undefined;
    }
    return e.value;
  }
  set(url: string, value: unknown, cacheControl: string | null) {
    if (!cacheControl || /no-store|no-cache/i.test(cacheControl)) return;
    const m = /max-age=(\d+)/i.exec(cacheControl);
    if (!m) return;
    this.entries.set(url, { expires: Date.now() + Number(m[1]) * 1000, value });
  }
}

/**
 * Turns user input into the well-known URL. `example.com` → `https://example.com/...`.
 * With `insecureDev`, an explicit `http://host:port` is kept, and a bare loopback host
 * (`localhost:3333`) defaults to `http:`.
 */
export function wellKnownUrlFor(input: string, sec: SecurityOptions = {}): URL {
  let base: URL;
  if (/^[a-z]+:\/\//i.test(input)) {
    base = new URL(input);
  } else {
    const guess = new URL(`https://${input}`);
    base = sec.insecureDev && isLoopbackHost(guess.hostname) ? new URL(`http://${input}`) : guess;
  }
  requireSecureUrl(base.toString(), 'Company domain', sec);
  return new URL('/.well-known/poppy.json', base.origin);
}

async function fetchJson(
  url: URL,
  what: string,
  opts: DiscoveryOptions,
): Promise<{ json: unknown; finalUrl: URL }> {
  const cached = opts.cache?.get(url.toString());
  if (cached !== undefined) return { json: cached, finalUrl: url };
  const doFetch = opts.fetch ?? ((i, init) => globalThis.fetch(i, init));
  let current = url;
  for (let hop = 0; ; hop++) {
    const res = await doFetch(current.toString(), {
      redirect: 'manual',
      headers: { accept: 'application/json' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop >= MAX_REDIRECTS)
        throw new DiscoveryError('too_many_redirects', `${what}: too many redirects`);
      const next = new URL(res.headers.get('location')!, current);
      try {
        // Every redirect MUST be to an HTTPS URL (3).
        requireSecureUrl(next.toString(), `${what} redirect`, opts);
      } catch (e) {
        throw new DiscoveryError('insecure_redirect', (e as Error).message);
      }
      current = next;
      continue;
    }
    if (!res.ok) {
      throw new DiscoveryError('fetch_failed', `${what}: HTTP ${res.status} from ${current}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new DiscoveryError('invalid_json', `${what}: response is not JSON`);
    }
    opts.cache?.set(url.toString(), json, res.headers.get('cache-control'));
    return { json, finalUrl: current };
  }
}

function fail(code: string, message: string): never {
  throw new DiscoveryError(code, message);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkUrl(value: unknown, what: string, sec: SecurityOptions): string {
  try {
    return requireSecureUrl(value, what, sec).toString();
  } catch (e) {
    fail('invalid_document', (e as Error).message);
  }
}

/** Validates `poppy.json` against 3.1. Unknown fields are ignored, never rejected. */
export function validatePoppyDocument(
  json: unknown,
  requestedHost: string,
  sec: SecurityOptions = {},
): PoppyDocument {
  if (!isObject(json)) fail('invalid_document', 'poppy.json is not a JSON object');
  const version = json.protocol_version;
  if (typeof version !== 'string' || !/^\d+\.\d+$/.test(version)) {
    fail('invalid_document', 'protocol_version must be "major.minor"');
  }
  const major = version.split('.')[0];
  if (!SUPPORTED_MAJOR_VERSIONS.includes(major)) {
    fail(
      'unsupported_protocol_version',
      `poppy.json protocol_version ${version} has major ${major}; this agent supports ${SUPPORTED_MAJOR_VERSIONS.join(', ')}`,
    );
  }

  const org = json.organization;
  if (!isObject(org) || typeof org.name !== 'string' || typeof org.domain !== 'string') {
    fail('invalid_document', 'organization.name and organization.domain are required');
  }
  // organization.domain must match the host we requested, ignoring a leading www. The host
  // after a redirect doesn't count (3.1). Ports only appear in --insecure-dev setups.
  const requested = normalizeDomain(requestedHost);
  const requestedNoPort = normalizeDomain(requestedHost.replace(/:\d+$/, ''));
  const claimed = normalizeDomain(org.domain);
  if (claimed !== requested && claimed !== requestedNoPort) {
    fail(
      'domain_mismatch',
      `organization.domain "${org.domain}" does not match the requested host "${requestedHost}"`,
    );
  }

  const hasAgent = json.agent !== undefined;
  const hasApis = json.apis !== undefined;
  const hasWeb = json.web !== undefined;
  if (!hasAgent && !hasApis && !hasWeb) {
    fail('invalid_document', 'poppy.json must have at least one of agent, apis, web');
  }

  if (hasWeb) {
    if (!isObject(json.web)) fail('invalid_document', 'web must be an object');
    if (json.web.browser_session_endpoint !== undefined) {
      checkUrl(json.web.browser_session_endpoint, 'web.browser_session_endpoint', sec);
    }
  }
  const needsAuth =
    hasAgent || hasApis || (isObject(json.web) && json.web.browser_session_endpoint);
  if (needsAuth && json.auth === undefined) {
    fail(
      'invalid_document',
      'auth is required when agent, apis or web.browser_session_endpoint is present',
    );
  }
  if (json.auth !== undefined) {
    const auth = json.auth;
    if (!isObject(auth)) fail('invalid_document', 'auth must be an object');
    checkUrl(auth.issuer, 'auth.issuer', sec);
    for (const type of ['direct', 'device', 'mediated'] as const) {
      const t = auth[type];
      if (t === undefined) continue;
      if (
        !isObject(t) ||
        !Array.isArray(t.scopes) ||
        !t.scopes.every((s) => typeof s === 'string')
      ) {
        fail('invalid_document', `auth.${type}.scopes must be a list of strings`);
      }
    }
    if (isObject(auth.mediated)) {
      checkUrl(auth.mediated.endpoint, 'auth.mediated.endpoint', sec);
      const fields = auth.mediated.fields;
      if (
        !Array.isArray(fields) ||
        !fields.every(
          (f) => isObject(f) && typeof f.name === 'string' && typeof f.label === 'string',
        )
      ) {
        fail('invalid_document', 'auth.mediated.fields must list { name, label, secret }');
      }
    }
  }
  if (hasAgent) {
    if (!isObject(json.agent) || !Array.isArray(json.agent.protocols)) {
      fail('invalid_document', 'agent.protocols must be a list');
    }
  }
  if (hasApis && !Array.isArray(json.apis)) fail('invalid_document', 'apis must be a list');
  return json as unknown as PoppyDocument;
}

/** RFC 8414 section 3: the well-known suffix goes between the host and the issuer's path. */
export function authServerMetadataUrl(issuer: string): URL {
  const u = new URL(issuer);
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  return new URL(`${u.origin}/.well-known/oauth-authorization-server${path}`);
}

/** Validates the issuer metadata against 3.2. */
export function validateMetadata(
  json: unknown,
  doc: PoppyDocument,
  sec: SecurityOptions = {},
): AuthServerMetadata {
  if (!isObject(json)) fail('invalid_metadata', 'authorization server metadata is not an object');
  const auth = doc.auth!;
  if (json.issuer !== auth.issuer) {
    fail(
      'issuer_mismatch',
      `metadata issuer "${String(json.issuer)}" != auth.issuer "${auth.issuer}"`,
    );
  }
  const domains = json.poppy_domains;
  if (!Array.isArray(domains)) {
    fail(
      'domain_not_listed',
      'metadata has no poppy_domains, so it does not vouch for this domain',
    );
  }
  const wanted = doc.organization.domain.toLowerCase();
  if (!domains.some((d) => typeof d === 'string' && d.toLowerCase() === wanted)) {
    fail(
      'domain_not_listed',
      `poppy_domains of ${auth.issuer} does not include "${doc.organization.domain}"`,
    );
  }
  checkUrl(json.token_endpoint, 'token_endpoint', sec);
  checkUrl(json.revocation_endpoint, 'revocation_endpoint', sec);
  if (auth.direct) checkUrl(json.authorization_endpoint, 'authorization_endpoint', sec);
  if (auth.device)
    checkUrl(json.device_authorization_endpoint, 'device_authorization_endpoint', sec);
  return json as unknown as AuthServerMetadata;
}

/**
 * Discovery (section 3): fetches `/.well-known/poppy.json` (HTTPS-only redirects), validates
 * it, then fetches and validates the issuer's RFC 8414 metadata (3.2).
 */
export async function discover(input: string, opts: DiscoveryOptions = {}): Promise<Discovered> {
  const wellKnown = wellKnownUrlFor(input, opts);
  const { json } = await fetchJson(wellKnown, 'poppy.json', opts);
  const document = validatePoppyDocument(json, wellKnown.host, opts);
  let metadata: AuthServerMetadata | undefined;
  if (document.auth) {
    const { json: meta } = await fetchJson(
      authServerMetadataUrl(document.auth.issuer),
      'authorization server metadata',
      opts,
    );
    metadata = validateMetadata(meta, document, opts);
  }
  return { domain: wellKnown.host, wellKnownUrl: wellKnown.toString(), document, metadata };
}
