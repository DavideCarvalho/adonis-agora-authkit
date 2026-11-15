import { timingSafeEqual } from 'node:crypto';
import type { AccountStore } from '../accounts/account_store.js';
import type { OidcAdapter } from '../adapters/adapter_contract.js';
import type { OidcAdapterClass } from '../adapters/factory.js';
import { isClientDisabled, serviceTenantOf } from '../service_tenants/client_metadata.js';
import { authkitTenantLabels } from '../tenancy/tenant_labels.js';
import { isFirstPartyClient } from './branding.js';

/** Default path of the org labels endpoint (`GET /api/orgs/labels?ids=`). */
export const ORG_LABELS_PATH = '/api/orgs/labels';
/** At most this many ids per call; the rest are ignored. */
export const ORG_LABELS_MAX_IDS = 100;

/** The parts of the resolved authkit config the endpoint reads. */
export interface OrgLabelsDeps {
  AdapterClass: OidcAdapterClass;
  accountStore: AccountStore;
  firstPartyClients?: readonly string[];
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `client_id`/`client_secret` from an `Authorization: Basic` header (RFC 6749 §2.3.1), or `null`. */
export function parseBasicCredentials(
  header: string | undefined | null,
): { clientId: string; clientSecret: string } | null {
  if (typeof header !== 'string' || !/^basic\s/i.test(header)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = decoded.indexOf(':');
  if (colon <= 0) return null;
  try {
    return {
      clientId: decodeURIComponent(decoded.slice(0, colon)),
      clientSecret: decodeURIComponent(decoded.slice(colon + 1)),
    };
  } catch {
    return null;
  }
}

/**
 * The client a labels request authenticates as, or `null`. Only a relying party an admin
 * registered may read org labels: a confidential, enabled, first-party client (the same
 * clients that receive the `org_*` claims), never a dynamically registered one, never a
 * service tenant.
 */
export async function authenticateLabelsClient(
  deps: Pick<OrgLabelsDeps, 'AdapterClass' | 'firstPartyClients'>,
  authorization: string | undefined | null,
): Promise<string | null> {
  const credentials = parseBasicCredentials(authorization);
  if (!credentials) return null;
  const adapter = new (deps.AdapterClass as any)('Client') as OidcAdapter;
  const payload = (await adapter.find(credentials.clientId)) as Record<string, unknown> | undefined;
  if (!payload) return null;
  const secret = payload.client_secret;
  if (typeof secret !== 'string' || !secret) return null;
  if (!sameSecret(credentials.clientSecret, secret)) return null;
  if (isClientDisabled(payload)) return null;
  if (payload.client_id_issued_at !== undefined) return null;
  if (serviceTenantOf(payload)) return null;
  if (!isFirstPartyClient(deps.firstPartyClients, credentials.clientId)) return null;
  return credentials.clientId;
}

/** The requested ids: `?ids=a,b` and/or repeated `?ids=a&ids=b`, de-duplicated and capped. */
export function parseLabelIds(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const ids = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    for (const id of value.split(',')) {
      const trimmed = id.trim();
      if (trimmed && trimmed.length <= 255) ids.add(trimmed);
      if (ids.size >= ORG_LABELS_MAX_IDS) return [...ids];
    }
  }
  return [...ids];
}

/**
 * `GET /api/orgs/labels?ids=a,b`: `{ labels: { [orgId]: name } }` for the ids that are
 * authkit organizations. Authenticated with the relying party's own client id and secret
 * (`Authorization: Basic`). Unknown ids are left out. Read by authkit-client's tenant
 * labeler, so a console on another server shows org names instead of ids.
 */
export async function orgLabelsHandler(ctx: any): Promise<unknown> {
  const service = await ctx.containerResolver.make('authkit.server');
  const deps = service.config as OrgLabelsDeps;
  const clientId = await authenticateLabelsClient(deps, ctx.request.header('authorization'));
  if (!clientId) {
    ctx.response.header('www-authenticate', 'Basic realm="authkit"');
    return ctx.response.unauthorized({ error: 'invalid_client' });
  }
  const ids = parseLabelIds(ctx.request.qs().ids);
  ctx.response.header('cache-control', 'no-store');
  if (ids.length === 0) return { labels: {} };
  const labels = await authkitTenantLabels({ store: () => deps.accountStore })(ids);
  return { labels };
}
