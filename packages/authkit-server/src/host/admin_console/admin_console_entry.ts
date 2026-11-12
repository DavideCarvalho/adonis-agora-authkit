import type { HttpContext } from '@adonisjs/core/http';
import { getBootedApp } from '../../../services/booted_app.js';
import { supportsOrganizations } from '../../accounts/account_store.js';
import {
  type AgoraConsoleEntry,
  type AgoraConsoleRegistry,
  type AgoraConsoleSearchHit,
  readAgoraConsoles,
} from '../../console_switcher.js';

/** The admin console's id in the `'agora.consoles'` registry. */
export const ADMIN_CONSOLE_ID = 'authkit';

/** The `'agora.consoles'` registry, or `null` (none bound, or no booted app). */
export async function consoleRegistry(): Promise<AgoraConsoleRegistry | null> {
  try {
    return await readAgoraConsoles(getBootedApp() as never);
  } catch {
    return null;
  }
}

type OrgRow = { id: string; name: string; slug: string };

const ORG_CACHE_MS = 30_000;
const orgCache = new WeakMap<object, { at: number; rows: Promise<OrgRow[]> }>();

/** The store's organizations, cached for 30 s per store so a search session does one query. */
function cachedOrgs(store: object, load: () => Promise<OrgRow[]>): Promise<OrgRow[]> {
  const hit = orgCache.get(store);
  if (hit && Date.now() - hit.at < ORG_CACHE_MS) return hit.rows;
  const rows = load();
  orgCache.set(store, { at: Date.now(), rows });
  rows.catch(() => orgCache.delete(store));
  return rows;
}

/**
 * Global search of the admin console: users by email (as the account store's `listAccounts`
 * search matches them), and organizations by name or slug.
 * Each hit opens the matching drawer in the console.
 */
export async function searchAdminConsole(
  ctx: HttpContext,
  adminPrefix: string,
  query: string,
  limit: number,
): Promise<AgoraConsoleSearchHit[]> {
  const service = await ctx.containerResolver.make('authkit.server');
  const store = service.config.accountStore;
  const hits: AgoraConsoleSearchHit[] = [];

  const accounts = await store.listAccounts({ search: query, page: 1, size: limit });
  for (const account of accounts.data.slice(0, limit)) {
    hits.push({
      title: account.email,
      subtitle: account.name ? `User · ${account.name}` : 'User',
      href: `${adminPrefix}?view=users&user=${encodeURIComponent(account.id)}`,
    });
  }

  // Organizations only from a store that lists them in one query, for queries of 2+ characters,
  // from a list cached briefly per process: search runs on every (debounced) keystroke.
  if (hits.length < limit && query.length >= 2 && supportsOrganizations(store)) {
    const listAll = (store as { listAllOrgsWithMemberCount?: () => Promise<unknown> })
      .listAllOrgsWithMemberCount;
    if (typeof listAll === 'function') {
      const needle = query.toLowerCase();
      const orgs = await cachedOrgs(store, () => listAll.call(store) as Promise<OrgRow[]>);
      for (const org of orgs) {
        if (hits.length >= limit) break;
        if (!org.name.toLowerCase().includes(needle) && !org.slug.toLowerCase().includes(needle)) {
          continue;
        }
        hits.push({
          title: org.name,
          subtitle: `Organization · ${org.slug}`,
          href: `${adminPrefix}?view=orgs&org=${encodeURIComponent(org.id)}`,
        });
      }
    }
  }
  return hits;
}

/** The admin console's registry entry, for the shell mounted at `adminPrefix`. */
export function adminConsoleEntry(
  adminPrefix: string,
  authorize: AgoraConsoleEntry['authorize'],
): AgoraConsoleEntry {
  return {
    id: ADMIN_CONSOLE_ID,
    title: 'Identity',
    package: '@adonis-agora/authkit-server',
    icon: 'identity',
    path: adminPrefix,
    order: 90,
    authorize,
    search: (ctx, query, limit) => searchAdminConsole(ctx, adminPrefix, query, limit),
  };
}
