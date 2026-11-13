import { type ConsoleIconKey, consoleIconKey } from './icons';
import { isSafeHref, type SearchConfig, type SwitcherConfig } from './shell-config';

/**
 * The two requests the switcher and ⌘K make, with every entry sanitized (unsafe hrefs dropped,
 * unknown icons → `generic`). Any failure reads as "nothing": the shell never breaks on them.
 */

export interface SwitcherConsole {
  id: string;
  title: string;
  package?: string;
  icon: ConsoleIconKey;
  href: string;
}

export interface SearchHit {
  title: string;
  subtitle?: string;
  href: string;
}

export interface SearchGroup {
  id: string;
  title: string;
  icon: ConsoleIconKey;
  hits: SearchHit[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function sanitizeConsoles(value: unknown): SwitcherConsole[] {
  if (!Array.isArray(value)) return [];
  const out: SwitcherConsole[] = [];
  for (const item of value) {
    const c = record(item);
    if (!c || typeof c.id !== 'string' || typeof c.title !== 'string' || !isSafeHref(c.href)) {
      continue;
    }
    out.push({
      id: c.id,
      title: c.title,
      ...(typeof c.package === 'string' ? { package: c.package } : {}),
      icon: consoleIconKey(c.icon),
      href: c.href,
    });
  }
  return out;
}

/** Search answers come as `{ results: [...] }` (durable & co.) or `{ groups: [...] }` (authkit). */
export function sanitizeSearchGroups(body: unknown): SearchGroup[] {
  const b = record(body);
  const list = Array.isArray(b?.results) ? b.results : Array.isArray(b?.groups) ? b.groups : [];
  const groups: SearchGroup[] = [];
  for (const item of list as unknown[]) {
    const g = record(item);
    if (!g || typeof g.id !== 'string' || typeof g.title !== 'string' || !Array.isArray(g.hits)) {
      continue;
    }
    const hits: SearchHit[] = [];
    for (const raw of g.hits as unknown[]) {
      const h = record(raw);
      if (!h || typeof h.title !== 'string' || !isSafeHref(h.href)) continue;
      hits.push({
        title: h.title,
        ...(typeof h.subtitle === 'string' ? { subtitle: h.subtitle } : {}),
        href: h.href,
      });
    }
    if (hits.length > 0)
      groups.push({ id: g.id, title: g.title, icon: consoleIconKey(g.icon), hits });
  }
  return groups;
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let cached: { endpoint: string; result: Promise<SwitcherConsole[]> } | undefined;

/** The other consoles this viewer may open, fetched once per page life. */
export function loadConsoles(config: SwitcherConfig): Promise<SwitcherConsole[]> {
  if (cached?.endpoint === config.endpoint) return cached.result;
  const result = getJson(config.endpoint)
    .then((body) => sanitizeConsoles(record(body)?.consoles))
    .catch(() => []);
  cached = { endpoint: config.endpoint, result };
  return result;
}

/** Forget the cached console list (tests). */
export function resetConsoleCache(): void {
  cached = undefined;
}

/** One query across every console the viewer may open. */
export async function searchConsoles(
  config: SearchConfig,
  q: string,
  signal?: AbortSignal,
): Promise<SearchGroup[]> {
  try {
    return sanitizeSearchGroups(
      await getJson(`${config.endpoint}?q=${encodeURIComponent(q)}`, signal),
    );
  } catch {
    return [];
  }
}
