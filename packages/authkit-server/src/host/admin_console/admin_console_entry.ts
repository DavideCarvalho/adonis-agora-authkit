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

/**
 * Global search of the admin console: users by email or name, and organizations by name or slug.
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

  // Organizations only from a store that lists them in one query: search must stay cheap.
  if (hits.length < limit && supportsOrganizations(store)) {
    const listAll = (store as { listAllOrgsWithMemberCount?: () => Promise<unknown> })
      .listAllOrgsWithMemberCount;
    if (typeof listAll === 'function') {
      const needle = query.toLowerCase();
      const orgs = (await listAll.call(store)) as Array<{ id: string; name: string; slug: string }>;
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
