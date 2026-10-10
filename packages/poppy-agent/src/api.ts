import type { CompanyClient } from './company.js';
import { throwForResponse } from './company.js';
import { PoppyError } from './errors.js';
import { readJson } from './http.js';
import type { PoppyApiEntry } from './types.js';
import { requireSecureUrl } from './util.js';

/** API types this client understands (section 6). Others are skipped. */
export const KNOWN_API_TYPES = ['openapi', 'mcp'];

export function listApis(company: CompanyClient): PoppyApiEntry[] {
  return (company.document.apis ?? []).filter(
    (a) => a && KNOWN_API_TYPES.includes(a.type) && typeof a.url === 'string',
  );
}

export function pickApi(
  company: CompanyClient,
  type: 'openapi' | 'mcp',
  index?: number,
): PoppyApiEntry {
  const apis = listApis(company).filter((a) => a.type === type);
  if (apis.length === 0) throw new PoppyError('no_api', `Company lists no ${type} API`);
  const api = apis[index ?? 0];
  if (!api) throw new PoppyError('no_api', `no ${type} API at index ${index}`);
  requireSecureUrl(api.url, `${type} url`, company.security);
  return api;
}

export interface OpenApiDoc {
  servers?: { url: string }[];
  paths?: Record<string, Record<string, { summary?: string; operationId?: string }>>;
  [k: string]: unknown;
}

/** Loads an OpenAPI description. Tried without a token first; with DPoP if that's refused. */
export async function loadOpenApi(company: CompanyClient, api: PoppyApiEntry): Promise<OpenApiDoc> {
  const res = await company.http.request(api.url, { headers: { accept: 'application/json' } });
  if (res.ok) return (await readJson<OpenApiDoc>(res)) ?? {};
  if (res.status === 401 || res.status === 403) {
    const { body } = await company.json<OpenApiDoc>(api.url, {
      headers: { accept: 'application/json' },
      resource: api.resource,
    });
    return body ?? {};
  }
  throw new PoppyError(`http_${res.status}`, `could not load ${api.url}`);
}

/** The API's base URL: `servers[0].url` resolved against the description's URL. */
export function apiBaseUrl(doc: OpenApiDoc, api: PoppyApiEntry): string {
  const server = doc.servers?.[0]?.url;
  return new URL(server ?? '/', api.url).toString().replace(/\/+$/, '');
}

/**
 * Calls an endpoint of a listed OpenAPI API with a DPoP Session Token (section 6). Refuses
 * absolute URLs outside the API's own origin, so tokens never go to a third party.
 */
export async function callOpenApi(
  company: CompanyClient,
  input: { method: string; path: string; body?: unknown; apiIndex?: number; scope?: string },
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const api = pickApi(company, 'openapi', input.apiIndex);
  const doc = await loadOpenApi(company, api);
  const base = apiBaseUrl(doc, api);
  const url = /^https?:\/\//i.test(input.path)
    ? new URL(input.path)
    : new URL(base + (input.path.startsWith('/') ? input.path : `/${input.path}`));
  const allowed = new Set([new URL(base).origin, new URL(api.url).origin]);
  if (!allowed.has(url.origin)) {
    throw new PoppyError(
      'foreign_origin',
      `${url.origin} is not this API's origin; refusing to send the token`,
    );
  }
  requireSecureUrl(url.toString(), 'API URL', company.security);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (input.body !== undefined) headers['content-type'] = 'application/json';
  const res = await company.fetch(url.toString(), {
    method: input.method.toUpperCase(),
    headers,
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    resource: api.resource,
    scope: input.scope,
  });
  if (res.status === 401 || res.status === 403) {
    if (res.headers.get('www-authenticate')) await throwForResponse(res);
  }
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {}
  return { status: res.status, headers: res.headers, body };
}
