/**
 * The apps and what links them, as this authkit server knows it: each app's service-tenant
 * client, the apps it may call (and with which capabilities), and what each app accepts (the
 * catalogs the apps publish). Published on a well-known global symbol slot so other Agora libs
 * (telescope's Architecture page) read it without importing authkit.
 */
import type { AppCatalogEntry, AppCatalogStore } from './app_catalog.js';

/** The symbol slot authkit-server writes its app-graph reader into. */
export const AUTHKIT_APP_GRAPH_SLOT = Symbol.for('@adonis-agora/authkit:app-graph');

/** One app with one or more service-tenant clients (merged by `partition`). */
export interface AppGraphApp {
  /** The app's name (the clients' `partition`). */
  app: string;
  /** Its service-tenant clients. */
  clientIds: string[];
  /** Every one of its clients is disabled: it gets no token. */
  disabled: boolean;
  /** The environments its clients are bound to, when any. */
  environments: string[];
  /**
   * The apps it may call, each with the capabilities its tokens for that app carry (the union
   * over its enabled clients; over all of them when every one is disabled).
   */
  calls: Record<string, string[]>;
}

export interface AppGraphSnapshot {
  apps: AppGraphApp[];
  /** What each app accepts from the others, as it published it. */
  catalogs: Array<{ app: string; capabilities: string[]; updatedAt: string }>;
}

/** What the slot holds. */
export interface AuthkitAppGraphReader {
  /**
   * The graph. Rejects when the clients cannot be read (the reader then knows nothing about
   * grants, which is not the same as "no grant"); a failed read is not cached. Catalogs that
   * cannot be read come back empty.
   */
  snapshot(): Promise<AppGraphSnapshot>;
}

/** The clients the snapshot reads: the admin clients service's view of each client. */
export interface AppGraphClient {
  clientId: string;
  disabled: boolean;
  serviceTenant: {
    partition: string;
    environment?: string;
    apps?: Record<string, string[]>;
  } | null;
}

/** The graph from the clients and the catalog store. One app may have several clients: merged. */
export async function buildAppGraph(
  clients: readonly AppGraphClient[],
  catalogs: AppCatalogStore | null,
): Promise<AppGraphSnapshot> {
  const byApp = new Map<string, AppGraphClient[]>();
  for (const client of clients) {
    const tenant = client.serviceTenant;
    if (!tenant) continue;
    const list = byApp.get(tenant.partition) ?? [];
    list.push(client);
    byApp.set(tenant.partition, list);
  }
  const apps: AppGraphApp[] = [];
  for (const [app, list] of byApp) {
    const disabled = list.every((c) => c.disabled);
    // A disabled client gets no token: its grants count only when every client is disabled.
    const counted = disabled ? list : list.filter((c) => !c.disabled);
    const calls: Record<string, Set<string>> = {};
    for (const client of counted) {
      for (const [target, caps] of Object.entries(client.serviceTenant?.apps ?? {})) {
        const set = calls[target] ?? new Set<string>();
        for (const cap of caps) set.add(cap);
        calls[target] = set;
      }
    }
    apps.push({
      app,
      clientIds: list.map((c) => c.clientId).sort(),
      disabled,
      environments: [
        ...new Set(list.map((c) => c.serviceTenant?.environment).filter((e): e is string => !!e)),
      ].sort(),
      calls: Object.fromEntries(
        Object.entries(calls).map(([target, set]) => [target, [...set].sort()]),
      ),
    });
  }
  apps.sort((a, b) => a.app.localeCompare(b.app));
  const entries: AppCatalogEntry[] = catalogs ? await catalogs.list().catch(() => []) : [];
  return {
    apps,
    catalogs: entries.map((e) => ({
      app: e.app,
      capabilities: e.capabilities,
      updatedAt: e.updatedAt.toISOString(),
    })),
  };
}

/** How long a snapshot is reused: the graph changes only when an admin edits a client. */
export const APP_GRAPH_TTL_MS = 30_000;

/** A reader that caches {@link buildAppGraph} for {@link APP_GRAPH_TTL_MS}. */
export function cachedAppGraphReader(
  load: () => Promise<AppGraphSnapshot>,
  now: () => number = Date.now,
): AuthkitAppGraphReader {
  let cached: { value: AppGraphSnapshot; expiresAt: number } | undefined;
  let pending: Promise<AppGraphSnapshot> | undefined;
  return {
    async snapshot() {
      if (cached && cached.expiresAt > now()) return cached.value;
      pending ??= load()
        .then((value) => {
          cached = { value, expiresAt: now() + APP_GRAPH_TTL_MS };
          return value;
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    },
  };
}

/** Publish `reader` on the slot. */
export function publishAppGraph(reader: AuthkitAppGraphReader): void {
  (globalThis as Record<symbol, unknown>)[AUTHKIT_APP_GRAPH_SLOT] = reader;
}
