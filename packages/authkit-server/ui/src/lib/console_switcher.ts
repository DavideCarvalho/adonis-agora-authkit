/**
 * Console switcher data (no React, no DOM): the shapes the admin API answers, plus the guards the
 * switcher, the Overview cards and the search palette share.
 */

export type ConsoleIconKey =
  | 'workflow'
  | 'telescope'
  | 'media'
  | 'payments'
  | 'agent'
  | 'identity'
  | 'generic';

const ICON_KEYS: readonly ConsoleIconKey[] = [
  'workflow',
  'telescope',
  'media',
  'payments',
  'agent',
  'identity',
  'generic',
];

export interface ConsoleLink {
  id: string;
  title: string;
  package?: string;
  icon: ConsoleIconKey;
  href: string;
}

export interface ConsoleSearchGroup {
  id: string;
  title: string;
  icon: ConsoleIconKey;
  hits: Array<{ title: string; subtitle?: string; href: string }>;
}

/** An unknown icon renders as `generic`. */
export function iconKey(value: unknown): ConsoleIconKey {
  return ICON_KEYS.includes(value as ConsoleIconKey) ? (value as ConsoleIconKey) : 'generic';
}

/** Only same-origin absolute paths are followed: `/x`, never `//host`, a scheme or a backslash. */
export function isSafeHref(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The `consoles` of `GET {admin}/api/consoles`, with unsafe or malformed entries dropped. */
export function parseConsoles(body: unknown): ConsoleLink[] {
  if (!isRecord(body) || !Array.isArray(body.consoles)) return [];
  const links: ConsoleLink[] = [];
  for (const entry of body.consoles) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.title !== 'string') {
      continue;
    }
    if (!isSafeHref(entry.href)) continue;
    links.push({
      id: entry.id,
      title: entry.title,
      ...(typeof entry.package === 'string' ? { package: entry.package } : {}),
      icon: iconKey(entry.icon),
      href: entry.href,
    });
  }
  return links;
}

/** The `groups` of `GET {admin}/api/consoles/search`, with unsafe hits dropped. */
export function parseSearchGroups(body: unknown): ConsoleSearchGroup[] {
  if (!isRecord(body) || !Array.isArray(body.groups)) return [];
  const groups: ConsoleSearchGroup[] = [];
  for (const group of body.groups) {
    if (!isRecord(group) || typeof group.id !== 'string' || typeof group.title !== 'string') {
      continue;
    }
    const hits = (Array.isArray(group.hits) ? group.hits : [])
      .filter(
        (hit): hit is { title: string; subtitle?: unknown; href: string } =>
          isRecord(hit) && typeof hit.title === 'string' && isSafeHref(hit.href),
      )
      .map((hit) => ({
        title: hit.title,
        ...(typeof hit.subtitle === 'string' ? { subtitle: hit.subtitle } : {}),
        href: hit.href,
      }));
    if (hits.length > 0)
      groups.push({ id: group.id, title: group.title, icon: iconKey(group.icon), hits });
  }
  return groups;
}

/** Arrow / Home / End navigation over `count` items (wraps around). */
export function moveIndex(current: number, key: string, count: number): number {
  if (count <= 0) return -1;
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count;
    case 'ArrowUp':
      return current <= 0 ? count - 1 : current - 1;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return current;
  }
}

/** GETs a same-origin JSON endpoint with the console's session cookie. */
export async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
