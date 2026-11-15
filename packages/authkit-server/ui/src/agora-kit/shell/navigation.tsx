import type { SwitcherConsole } from '../console-data';
import { type ConsoleIconKey, ConsoleTile, consoleAccent } from '../icons';
import type { NavItem, NavSection } from './app-shell';
import type { SearchCommand } from './console-search';

/**
 * ⌘K navigation, built from what the shell already has: the console's `nav` (its pages) and the
 * switcher's list (the other consoles this viewer may open). Consoles wire nothing.
 */

/** What a console is usually called, by registry icon key, so "auth" finds authkit's console. */
const CONSOLE_KEYWORDS: Record<ConsoleIconKey, string[]> = {
  workflow: ['durable', 'workflows', 'runs', 'jobs', 'schedules'],
  telescope: ['telescope', 'observability', 'monitoring', 'logs', 'traces', 'requests'],
  identity: ['authkit', 'auth', 'identity', 'users', 'login', 'sessions'],
  payments: ['payments', 'billing', 'charges', 'subscriptions'],
  media: ['media', 'files', 'uploads', 'images'],
  agent: ['agent', 'agents', 'ai', 'threads', 'assistants'],
  flags: ['flags', 'feature flags', 'experiments', 'toggles'],
  cms: ['cms', 'content', 'posts', 'admin'],
  generic: [],
};

/** Follow a nav item the way a click on it does. */
function follow(item: NavItem): void {
  if (item.onSelect) item.onSelect();
  else if (item.href !== undefined) window.location.assign(item.href);
}

/**
 * Every page in the sidebar `nav`, grouped under `consoleTitle`, with its section as the hint.
 * Pages of a `collapsible` section (a long list such as watchers) are listed only once something
 * is typed.
 */
export function pageCommands(nav: readonly NavSection[], consoleTitle: string): SearchCommand[] {
  return nav.flatMap((section) =>
    section.items
      .filter((item) => item.href !== undefined || item.onSelect !== undefined)
      .map((item) => ({
        id: `page:${item.id}`,
        label: item.label,
        group: consoleTitle,
        hint: section.section,
        icon: item.icon,
        keywords: [section.section, ...(item.keywords ?? [])],
        ...(section.collapsible ? { hideUntilTyped: true } : {}),
        onSelect: () => follow(item),
      })),
  );
}

/** "Go to <console>" for every console in the switcher list, matched by title, id and package. */
export function consoleCommands(consoles: readonly SwitcherConsole[]): SearchCommand[] {
  return consoles.map((c) => ({
    id: `console:${c.id}`,
    label: `Go to ${c.title}`,
    group: 'Consoles',
    ...(c.package ? { hint: c.package } : {}),
    icon: <ConsoleTile icon={c.icon} accent={consoleAccent(c.id, c.icon)} size={18} />,
    keywords: [
      c.title,
      c.id,
      ...(c.package ? [c.package, c.package.replace(/^@[^/]+\//, '')] : []),
      ...CONSOLE_KEYWORDS[c.icon],
    ],
    onSelect: () => window.location.assign(c.href),
  }));
}
