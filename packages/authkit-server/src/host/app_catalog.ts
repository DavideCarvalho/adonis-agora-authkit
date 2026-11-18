import {
  APP_CATALOG_PATH,
  appCatalogStoreOf,
  authenticateCatalogPublisher,
  presentCatalog,
  validateCatalog,
} from '../service_tenants/app_catalog.js';
import { parseBasicCredentials } from './org_labels.js';

export { APP_CATALOG_PATH };

async function storeOf(ctx: any) {
  const service = await ctx.containerResolver.make('authkit.server');
  const store = await appCatalogStoreOf(service, () => ctx.containerResolver.make('lucid.db'));
  return { service, store };
}

/**
 * `PUT /api/apps/catalog` with `{ capabilities: string[] }`: an app publishes what it accepts
 * from the other apps. Authenticated with its service tenant's client id and secret
 * (`Authorization: Basic`); the app is the tenant's `partition`. Replaces that app's catalog.
 */
export async function publishAppCatalogHandler(ctx: any): Promise<unknown> {
  const { service, store } = await storeOf(ctx);
  const app = await authenticateCatalogPublisher(
    service.config.AdapterClass,
    parseBasicCredentials(ctx.request.header('authorization')),
  );
  if (!app) {
    ctx.response.header('www-authenticate', 'Basic realm="authkit"');
    return ctx.response.unauthorized({ error: 'invalid_client' });
  }
  if (!store) return ctx.response.serviceUnavailable({ error: 'no_database' });
  const capabilities = validateCatalog(ctx.request.input('capabilities'));
  if (!Array.isArray(capabilities)) {
    return ctx.response.unprocessableEntity({
      error: 'invalid_catalog',
      message: capabilities.error,
    });
  }
  const entry = await store.put(app, capabilities);
  ctx.response.header('cache-control', 'no-store');
  return presentCatalog(entry);
}

/** Console and Admin API: `GET …/apps/catalog` → `{ apps: [{ app, capabilities, updatedAt }] }`. */
export async function listAppCatalogsHandler(ctx: any): Promise<unknown> {
  const { store } = await storeOf(ctx);
  return { apps: store ? (await store.list()).map(presentCatalog) : [] };
}
