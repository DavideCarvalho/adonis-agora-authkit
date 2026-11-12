import { getBootedApp } from '../../services/booted_app.js';
import type { AccountStore, OrgSummary } from '../accounts/account_store.js';
import { supportsOrganizations } from '../accounts/account_store.js';

/** What `config/context.ts` → `tenancy.label` expects: tenant id → display label. */
export type TenantLabelResolver = (ids: readonly string[]) => Promise<Record<string, string>>;

export interface AuthkitTenantLabelsOptions {
  /** Which field labels an organization: `'name'` (default), `'slug'`, or your own function. */
  label?: 'name' | 'slug' | ((org: OrgSummary) => string);
  /**
   * Where the account store comes from. Default: the `authkit.server` binding of the
   * booted app (`config/authkit.ts` → `accountStore`).
   */
  store?: () => AccountStore | Promise<AccountStore>;
}

/** Fallback walk without `findOrgsByIds`: one lookup per id, at most this many ids. */
const FALLBACK_MAX = 200;

const defaultStore = async (): Promise<AccountStore> => {
  const service = (await getBootedApp().container.make('authkit.server')) as unknown as {
    config: { accountStore: AccountStore };
  };
  return service.config.accountStore;
};

/**
 * A tenant label resolver backed by authkit organizations, for
 * `config/context.ts` → `tenancy.label`. Consoles call it with the tenant ids they
 * are about to show; it returns `{ [orgId]: name }` for the ids that are authkit
 * organizations. Ids it does not know (personal tenants, other kinds) are left
 * out, so the console shows the id. It only reads labels: no membership, role or
 * metadata leaves it.
 *
 * ```ts
 * // config/context.ts
 * import { authkitTenantLabels } from '@adonis-agora/authkit-server'
 *
 * export default defineConfig({
 *   tenancy: { enabled: true, kinds: ['organization'], label: authkitTenantLabels() },
 * })
 * ```
 */
export function authkitTenantLabels(options: AuthkitTenantLabelsOptions = {}): TenantLabelResolver {
  const pick =
    typeof options.label === 'function'
      ? options.label
      : options.label === 'slug'
        ? (org: OrgSummary) => org.slug
        : (org: OrgSummary) => org.name;

  return async (ids) => {
    const wanted = [
      ...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id)),
    ];
    if (wanted.length === 0) return {};
    const store = await (options.store ?? defaultStore)();
    if (!store || !supportsOrganizations(store)) return {};

    let orgs: OrgSummary[];
    if (typeof store.findOrgsByIds === 'function') {
      orgs = await store.findOrgsByIds(wanted);
    } else {
      orgs = [];
      for (const id of wanted.slice(0, FALLBACK_MAX)) {
        const org = await store.findOrgById(id);
        if (org) orgs.push(org);
      }
    }

    const asked = new Set(wanted);
    const labels: Record<string, string> = {};
    for (const org of orgs) {
      if (!asked.has(org.id)) continue;
      const label = pick(org);
      if (typeof label === 'string' && label !== '') labels[org.id] = label;
    }
    return labels;
  };
}
