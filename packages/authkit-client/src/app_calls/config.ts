/**
 * Calls between apps: the `service` and `apps` options of `config/authkit_client.ts`.
 *
 * - Which app an origin is comes from the published service discovery (telescope), and
 *   from `apps` (name → origin), which overrides it and is the whole answer without one.
 *   A plain `fetch` to exactly a known app's origin carries a token for `urn:agora:app:<name>`.
 * - `service` is this app as a service: its name (the audience of the tokens it accepts)
 *   and the credentials of its service-tenant client (only needed to call other apps).
 */

import type { AppCatalogSource } from './catalog.js';

/** Resource indicator prefix of an app: `urn:agora:app:<name>`. */
export const APP_RESOURCE_PREFIX = 'urn:agora:app:';

/** Letters, digits, `.`, `_` and `-`; starts with a letter or digit; up to 64 chars. */
export const APP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The resource indicator (and token audience) of an app. */
export const appResource = (name: string) => `${APP_RESOURCE_PREFIX}${name}`;

/** An invalid `service` / `apps` in `config/authkit_client.ts`. Fails the boot. */
export class AppCallsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppCallsConfigError';
  }
}

/** `service` in `config/authkit_client.ts`. */
export interface ServiceInput {
  /**
   * This app's name. Requests carrying a token for `urn:agora:app:<name>` are verified
   * and their caller is exposed as `ctx.agora.caller`.
   */
  name: string;
  /**
   * Client id of this app's service-tenant client. With `clientSecret`, calls to other
   * apps (found by discovery or in `apps`) are authenticated.
   */
  clientId?: string;
  /** Client secret of this app's service-tenant client (needed to call other apps). */
  clientSecret?: string;
  /**
   * Accept only callers whose token carries this `environment` (a token without it is
   * refused). Default: any.
   */
  environment?: string;
  /**
   * Also add the token to `node:http` / `node:https` requests (axios, got, …), not only
   * to `fetch`. Tokens are fetched ahead (at boot for `apps`, when discovery announces an
   * app) and refreshed before they expire; a request to a known app with no token ready
   * fails with `E_AGORA_APP_TOKEN_UNAVAILABLE` instead of leaving without one.
   * Default: `false`.
   */
  nodeHttp?: boolean;
  /**
   * With `nodeHttp`: how long the app's start waits for the tokens of the apps in `apps`
   * (it reports ready only once they are in). On timeout a warning names the apps still
   * without a token and the start goes on. Default: 5000 ms.
   */
  prewarmTimeoutMs?: number;
  /**
   * What this app accepts from the other apps, published to the authkit server at start so
   * the console's "Apps it can call" offers it (needs `clientId`/`clientSecret`):
   * - omitted: `authz.permissionCatalog()` when `@adonis-agora/authz` is in the app, else nothing;
   * - `'authz'`: the same, and a warning when authz is not there;
   * - a function returning the list (your own RBAC tables, a constant…);
   * - `false`: publish nothing (calls still work: the token says who is calling).
   */
  catalog?: AppCatalogSource;
  /** The publish endpoint. Default: `/api/apps/catalog` on the issuer's origin. */
  catalogEndpoint?: string;
}

/** Resolved `service` + `apps`. */
export interface ResolvedAppCalls {
  name: string;
  clientId?: string;
  clientSecret?: string;
  environment?: string;
  nodeHttp: boolean;
  /** See {@link ServiceInput.prewarmTimeoutMs}. */
  prewarmTimeoutMs: number;
  /** Static origin (`https://billing.example.com`) → app name; overrides discovery. */
  origins: Map<string, string>;
  /** See {@link ServiceInput.catalog}. */
  catalog?: AppCatalogSource;
  /** See {@link ServiceInput.catalogEndpoint}. */
  catalogEndpoint?: string;
}

/**
 * Validates `service` and `apps`. Throws on an invalid name, an origin that is not an
 * absolute http(s) origin, two apps on the same origin, or `apps` without credentials.
 */
export function resolveAppCalls(
  service: ServiceInput | undefined,
  apps: Record<string, string> | undefined,
): ResolvedAppCalls | undefined {
  const entries = Object.entries(apps ?? {});
  if (!service) {
    if (entries.length) {
      throw new AppCallsConfigError(
        'authkit_client: `apps` needs `service: { name, clientId, clientSecret }` (this app as a service).',
      );
    }
    return undefined;
  }
  if (typeof service.name !== 'string' || !APP_NAME_PATTERN.test(service.name)) {
    throw new AppCallsConfigError(
      `authkit_client: service.name "${service.name}" is invalid: use letters, digits, ".", "_" or "-" (max 64 chars).`,
    );
  }
  if (
    service.prewarmTimeoutMs !== undefined &&
    (!Number.isFinite(service.prewarmTimeoutMs) || service.prewarmTimeoutMs < 0)
  ) {
    throw new AppCallsConfigError(
      'authkit_client: service.prewarmTimeoutMs must be a number of ms >= 0.',
    );
  }
  const catalog = service.catalog;
  if (
    catalog !== undefined &&
    catalog !== false &&
    catalog !== 'authz' &&
    typeof catalog !== 'function'
  ) {
    throw new AppCallsConfigError(
      'authkit_client: service.catalog must be "authz", false or a function returning the list.',
    );
  }
  if (service.catalogEndpoint !== undefined && !URL.canParse(service.catalogEndpoint)) {
    throw new AppCallsConfigError(
      'authkit_client: service.catalogEndpoint must be an absolute URL.',
    );
  }
  const origins = new Map<string, string>();
  for (const [name, raw] of entries) {
    if (!APP_NAME_PATTERN.test(name)) {
      throw new AppCallsConfigError(`authkit_client: apps["${name}"]: invalid app name.`);
    }
    const url = typeof raw === 'string' ? URL.parse(raw) : null;
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
      throw new AppCallsConfigError(
        `authkit_client: apps.${name} must be an http(s) URL, got "${raw}".`,
      );
    }
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username) {
      throw new AppCallsConfigError(
        `authkit_client: apps.${name} must be an origin only (e.g. "https://billing.example.com"), got "${raw}".`,
      );
    }
    const taken = origins.get(url.origin);
    if (taken) {
      throw new AppCallsConfigError(
        `authkit_client: apps.${name} and apps.${taken} share the origin ${url.origin}.`,
      );
    }
    origins.set(url.origin, name);
  }
  if (origins.size && (!service.clientId || !service.clientSecret)) {
    throw new AppCallsConfigError(
      'authkit_client: calling other apps (`apps`) needs service.clientId and service.clientSecret (a service-tenant client).',
    );
  }
  return {
    name: service.name,
    ...(service.clientId ? { clientId: service.clientId } : {}),
    ...(service.clientSecret ? { clientSecret: service.clientSecret } : {}),
    ...(service.environment ? { environment: service.environment } : {}),
    nodeHttp: service.nodeHttp === true,
    prewarmTimeoutMs: service.prewarmTimeoutMs ?? 5_000,
    origins,
    ...(catalog !== undefined ? { catalog } : {}),
    ...(service.catalogEndpoint ? { catalogEndpoint: service.catalogEndpoint } : {}),
  };
}
