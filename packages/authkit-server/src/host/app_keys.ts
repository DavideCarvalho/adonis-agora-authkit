import { authenticateCatalogPublisher } from '../service_tenants/app_catalog.js';
import {
  APP_KEYS_PATH,
  APP_KEYS_READ_PATH,
  appKeysStoreOf,
  KEY_PURPOSE_PATTERN,
  presentAppKeys,
  validateAppKeys,
} from '../service_tenants/app_keys.js';
import { APP_NAME_PATTERN } from '../service_tenants/config.js';
import { jsonApiErrors } from './api_errors.js';
import { parseBasicCredentials } from './org_labels.js';

export { APP_KEYS_PATH, APP_KEYS_READ_PATH };

async function storeOf(ctx: any) {
  const service = await ctx.containerResolver.make('authkit.server');
  const store = await appKeysStoreOf(service, () => ctx.containerResolver.make('lucid.db'));
  return { service, store };
}

/** The service app the request authenticates as (`Authorization: Basic` of its client), or 401. */
async function authenticate(ctx: any, service: any) {
  const credentials = parseBasicCredentials(ctx.request.header('authorization'));
  const app = await authenticateCatalogPublisher(service.config.AdapterClass, credentials);
  if (!app) {
    ctx.response.header('www-authenticate', 'Basic realm="authkit"');
    ctx.response.unauthorized({
      error: 'invalid_client',
      message: "Authenticate with this app's service client id and secret (HTTP Basic).",
    });
    return null;
  }
  return { app, clientId: credentials!.clientId };
}

/**
 * `PUT /api/apps/keys` with `{ keys: [{ purpose, jwk }] }`: an app publishes its own public keys,
 * authenticated with its service tenant's client id and secret (the app is the tenant's
 * `partition`). Each purpose in the body replaces that purpose's keys. Public OKP JWKs only.
 */
export const publishAppKeysHandler = jsonApiErrors(
  'publishing app keys',
  'auth_app_keys',
  async (ctx: any): Promise<unknown> => {
    const { service, store } = await storeOf(ctx);
    const caller = await authenticate(ctx, service);
    if (!caller) return;
    if (!store) return ctx.response.serviceUnavailable({ error: 'no_database' });
    const keys = validateAppKeys(ctx.request.input('keys'));
    if (!(keys instanceof Map)) {
      return ctx.response.unprocessableEntity({ error: 'invalid_keys', message: keys.error });
    }
    const entries = await store.put(caller.app, keys);
    await service.config.audit?.record({
      type: 'app.keys_published',
      clientId: caller.clientId,
      ip: ctx.request.ip?.() ?? null,
      metadata: {
        app: caller.app,
        keys: entries.map((e) => ({
          purpose: e.purpose,
          keys: e.keys.map((k) => ({ crv: k.crv, x: k.x, ...(k.kid ? { kid: k.kid } : {}) })),
        })),
      },
    });
    ctx.response.header('cache-control', 'no-store');
    return { keys: entries.map(presentAppKeys) };
  },
);

/**
 * `GET /api/apps/:app/keys?purpose=`: the app's current public keys for the purpose, for any
 * authenticated service client. 404 when the app published none for it.
 */
export const readAppKeysHandler = jsonApiErrors(
  'reading app keys',
  'auth_app_keys',
  async (ctx: any): Promise<unknown> => {
    const { service, store } = await storeOf(ctx);
    const caller = await authenticate(ctx, service);
    if (!caller) return;
    const app = String(ctx.request.param('app') ?? '');
    const purpose = ctx.request.qs?.().purpose ?? ctx.request.input('purpose');
    if (!APP_NAME_PATTERN.test(app)) {
      return ctx.response.badRequest({ error: 'invalid_request', message: 'Invalid app name.' });
    }
    if (typeof purpose !== 'string' || !KEY_PURPOSE_PATTERN.test(purpose)) {
      return ctx.response.badRequest({
        error: 'invalid_request',
        message: `\`purpose\` is required and must match ${KEY_PURPOSE_PATTERN}.`,
      });
    }
    if (!store) return ctx.response.serviceUnavailable({ error: 'no_database' });
    const entry = await store.find(app, purpose);
    ctx.response.header('cache-control', 'no-store');
    if (!entry) {
      return ctx.response.notFound({
        error: 'not_found',
        message: `${app} has published no key for "${purpose}".`,
      });
    }
    return presentAppKeys(entry);
  },
);

/** Console: `GET …/api/apps/keys` → `{ keys: [{ app, purpose, keys, updatedAt }] }`. */
export const listAppKeysHandler = jsonApiErrors(
  'listing app keys',
  'auth_app_keys',
  async (ctx: any): Promise<unknown> => {
    const { store } = await storeOf(ctx);
    const app = ctx.request.qs?.().app;
    return {
      keys: store
        ? (await store.list(typeof app === 'string' ? app : undefined)).map(presentAppKeys)
        : [],
    };
  },
);
