import type { HttpContext } from '@adonisjs/core/http';

/**
 * The console switcher contract, version 1.
 *
 * Every `@adonis-agora` console registers itself into ONE data-only registry bound as a value at
 * `'agora.consoles'` (created by whichever lib boots first). Each console then shows a switcher to
 * the other consoles the viewer may open. The types are declared locally in every lib (TypeScript is
 * structural), so no lib imports another.
 */

/** The container binding the registry lives at. */
export const AGORA_CONSOLES_BINDING = 'agora.consoles';

/** Bound as a VALUE under `'agora.consoles'`. Data only, so every lib's copy is identical. */
export interface AgoraConsoleRegistry {
  readonly version: 1;
  readonly entries: AgoraConsoleEntry[];
  /**
   * What the account console (authkit) announces to every other console. Optional: consoles read
   * it structurally, so a registry without it (or created by an older lib) is still valid.
   */
  account?: AgoraConsoleAccount;
}

/**
 * The account console's announcements. `signOut` is where every console's footer signs the viewer
 * out: a same-origin POST action (the console adds its CSRF token as `_csrf`) or a link.
 */
export interface AgoraConsoleAccount {
  signOut?: { action: string; method?: 'POST' } | { href: string };
}

export type AgoraConsoleIcon =
  | 'workflow'
  | 'telescope'
  | 'media'
  | 'payments'
  | 'agent'
  | 'identity'
  | 'flags'
  | 'cms'
  | 'generic';

/** The decision a console's gate returns. Never throws. */
export interface AgoraConsoleDecision {
  allowed: boolean;
  reason?: string;
  redirectTo?: string;
}

/** One search hit. `href` is a same-origin absolute path. */
export interface AgoraConsoleSearchHit {
  title: string;
  subtitle?: string;
  href: string;
}

export interface AgoraConsoleEntry {
  /** `/^[a-z][a-z0-9-]*$/`: `'durable'`, `'telescope'`, `'authkit'`, … */
  id: string;
  /** Product title (`'Identity'`). */
  title: string;
  /** Package name, shown as secondary text (`'@adonis-agora/authkit-server'`). */
  package?: string;
  /** Unknown values render as `'generic'`. */
  icon: AgoraConsoleIcon;
  /** Same-origin absolute path of the console shell (`'/admin'`). */
  path: string;
  /** Lower first. durable 10, telescope 20, agent 30, payments 40, media 50, authkit 90. */
  order: number;
  /**
   * The console's resolved gate (the one its own routes run). While a switcher runs it for another
   * console, ``ctx.agoraProbe` is `true` (see `isAgoraProbe`), so an authorizer that writes an audit entry per call can skip.
   */
  authorize(ctx: HttpContext): Promise<AgoraConsoleDecision>;
  /** Global search provider. Only called after `authorize` allowed the viewer. */
  search?(ctx: HttpContext, query: string, limit: number): Promise<AgoraConsoleSearchHit[]>;
}

/** What `GET <console api>/consoles` answers. */
export interface VisibleConsoles {
  version: 1;
  current: string;
  consoles: Array<{
    id: string;
    title: string;
    package?: string;
    icon: AgoraConsoleIcon;
    href: string;
  }>;
}

/** What `GET <console api>/consoles/search?q=` answers. */
export interface ConsoleSearchResults {
  version: 1;
  query: string;
  groups: Array<{
    id: string;
    title: string;
    icon: AgoraConsoleIcon;
    hits: AgoraConsoleSearchHit[];
  }>;
}

const CONSOLE_ID = /^[a-z][a-z0-9-]*$/;
const ICONS: readonly AgoraConsoleIcon[] = [
  'workflow',
  'telescope',
  'media',
  'payments',
  'agent',
  'identity',
  'flags',
  'cms',
  'generic',
];

/** Default time each console's `authorize` (and `search`) gets before it counts as hidden. */
export const CONSOLE_PROBE_TIMEOUT_MS = 300;
/** Hits returned per console by the global search. */
export const CONSOLE_SEARCH_LIMIT = 5;

interface ContainerLike {
  hasBinding(binding: string): boolean;
  bindValue(binding: string, value: unknown): void;
  make(binding: string): Promise<unknown>;
}

interface AppLike {
  container: ContainerLike;
}

interface LoggerLike {
  warn(message: string): void;
  debug?(message: string): void;
}

/** A same-origin absolute path: starts with `/`, not `//`, no backslash, no control characters. */
export function isSameOriginPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/**
 * Add a console to the shared `'agora.consoles'` registry, creating it when absent. Skips (never
 * throws) a registry of another version; warns and skips a duplicate id. Throws on an invalid `id`
 * or `path`: that is a programming error. Apps can call it to register a console they mount by hand.
 *
 * ```ts
 * await registerAgoraConsole(app, { id: 'reports', title: 'Reports', icon: 'generic', path: '/reports',
 *   order: 100, authorize: async (ctx) => ({ allowed: await isStaff(ctx) }) })
 * ```
 */
export async function registerAgoraConsole(
  app: AppLike,
  entry: AgoraConsoleEntry,
  logger?: LoggerLike,
): Promise<boolean> {
  if (typeof entry?.id !== 'string' || !CONSOLE_ID.test(entry.id)) {
    throw new Error(
      `registerAgoraConsole: console id ${JSON.stringify(entry?.id)} must match /^[a-z][a-z0-9-]*$/`,
    );
  }
  if (!isSameOriginPath(entry.path)) {
    throw new Error(
      `registerAgoraConsole: console "${entry.id}" path ${JSON.stringify(entry.path)} must be a same-origin absolute path`,
    );
  }
  if (typeof entry.authorize !== 'function') {
    throw new Error(`registerAgoraConsole: console "${entry.id}" needs an authorize(ctx)`);
  }
  const container = app.container;
  if (!container.hasBinding(AGORA_CONSOLES_BINDING)) {
    container.bindValue(AGORA_CONSOLES_BINDING, { version: 1, entries: [] });
  }
  const registry = (await container.make(AGORA_CONSOLES_BINDING)) as Partial<AgoraConsoleRegistry>;
  if (registry?.version !== 1 || !Array.isArray(registry.entries)) return false;
  if (registry.entries.some((e) => e.id === entry.id)) {
    logger?.warn(`[@adonis-agora/authkit-server] console id "${entry.id}" already registered`);
    return false;
  }
  registry.entries.push(entry);
  return true;
}

/**
 * Announce where the viewer signs out (`account.signOut` on the `'agora.consoles'` registry), so
 * every other `@adonis-agora` console shows a working sign-out in its footer. Creates the registry
 * when absent. Keeps a sign-out something else already announced (an app may set its own first),
 * skips a registry of another version and never throws on one; throws on a non same-origin `action`
 * (a programming error).
 */
export async function announceAgoraSignOut(app: AppLike, action: string): Promise<boolean> {
  if (!isSameOriginPath(action)) {
    throw new Error(
      `announceAgoraSignOut: sign-out action ${JSON.stringify(action)} must be a same-origin absolute path`,
    );
  }
  const container = app.container;
  if (!container.hasBinding(AGORA_CONSOLES_BINDING)) {
    container.bindValue(AGORA_CONSOLES_BINDING, { version: 1, entries: [] });
  }
  const registry = (await container.make(AGORA_CONSOLES_BINDING)) as Partial<AgoraConsoleRegistry>;
  if (registry?.version !== 1 || !Array.isArray(registry.entries)) return false;
  const account =
    typeof registry.account === 'object' && registry.account !== null ? registry.account : {};
  if (account.signOut !== undefined) return false;
  registry.account = { ...account, signOut: { action, method: 'POST' } };
  return true;
}

/** The registry, when one is bound and is version 1. */
export async function readAgoraConsoles(app: AppLike): Promise<AgoraConsoleRegistry | null> {
  if (!app.container.hasBinding(AGORA_CONSOLES_BINDING)) return null;
  const registry = (await app.container.make(
    AGORA_CONSOLES_BINDING,
  )) as Partial<AgoraConsoleRegistry>;
  if (registry?.version !== 1 || !Array.isArray(registry.entries)) return null;
  return registry as AgoraConsoleRegistry;
}

/** How many consoles besides `selfId` are registered (the shell's `switcher.others`). */
export function countOtherConsoles(registry: AgoraConsoleRegistry | null, selfId: string): number {
  return registry ? registry.entries.filter((e) => e.id !== selfId).length : 0;
}

function sortEntries(entries: readonly AgoraConsoleEntry[]): AgoraConsoleEntry[] {
  return [...entries].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function iconOf(icon: unknown): AgoraConsoleIcon {
  return ICONS.includes(icon as AgoraConsoleIcon) ? (icon as AgoraConsoleIcon) : 'generic';
}

const TIMED_OUT = Symbol('timed out');

/** Resolves to `TIMED_OUT` when `promise` takes longer than `ms`, or `undefined` when it rejects. */
async function race<T>(
  promise: () => Promise<T>,
  ms: number,
): Promise<T | typeof TIMED_OUT | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(promise),
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Whether a console switcher is running this `authorize` on behalf of another console (it only asks
 * whether to list it). The marker is `ctx.agoraProbe === true`, set structurally by every
 * `@adonis-agora` console; an authorizer that audits every call can skip then.
 */
export function isAgoraProbe(ctx: unknown): boolean {
  return (ctx as { agoraProbe?: unknown } | null)?.agoraProbe === true;
}

/** Runs `fn` with `ctx.agoraProbe = true`, restoring the previous value afterwards. */
async function probing<T>(ctx: HttpContext, fn: () => Promise<T>): Promise<T> {
  const holder = ctx as unknown as { agoraProbe?: boolean };
  const previous = holder.agoraProbe;
  holder.agoraProbe = true;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete holder.agoraProbe;
    else holder.agoraProbe = previous;
  }
}

/** Runs every other console's gate in parallel (each raced against `timeoutMs`); keeps the allowed. */
async function allowedEntries(
  entries: readonly AgoraConsoleEntry[],
  ctx: HttpContext,
  timeoutMs: number,
  logger?: LoggerLike,
): Promise<AgoraConsoleEntry[]> {
  return probing(ctx, async () => {
    const decisions = await Promise.all(
      entries.map(async (entry) => {
        const decision = await race(() => entry.authorize(ctx), timeoutMs);
        if (decision === TIMED_OUT || decision === undefined) {
          logger?.debug?.(
            `[@adonis-agora/authkit-server] console "${entry.id}" hidden: authorize ${decision === TIMED_OUT ? 'timed out' : 'failed'}`,
          );
          return false;
        }
        return decision?.allowed === true;
      }),
    );
    return entries.filter((_, i) => decisions[i]);
  });
}

/**
 * The consoles (other than `selfId`) the viewer may open: every `authorize` runs in parallel, each
 * raced against 300 ms; a timeout, a rejection or anything but `allowed: true` hides the console.
 */
export async function listVisibleConsoles(
  registry: AgoraConsoleRegistry | null,
  selfId: string,
  ctx: HttpContext,
  options: { timeoutMs?: number; logger?: LoggerLike } = {},
): Promise<VisibleConsoles> {
  const others = sortEntries((registry?.entries ?? []).filter((e) => e.id !== selfId));
  const allowed = await allowedEntries(
    others,
    ctx,
    options.timeoutMs ?? CONSOLE_PROBE_TIMEOUT_MS,
    options.logger,
  );
  return {
    version: 1,
    current: selfId,
    consoles: allowed
      .filter((e) => isSameOriginPath(e.path))
      .map((e) => ({
        id: e.id,
        title: e.title,
        ...(typeof e.package === 'string' ? { package: e.package } : {}),
        icon: iconOf(e.icon),
        href: e.path,
      })),
  };
}

/**
 * Global search across the consoles the viewer may open. The current console (`selfId`, already
 * authorized by its own route guard) is searched without re-running its gate; the others only after
 * their `authorize` allowed. Each `search` gets `timeoutMs` and returns at most `limit` hits; a hit
 * whose `href` is not a same-origin path is dropped.
 */
export async function searchConsoles(
  registry: AgoraConsoleRegistry | null,
  selfId: string,
  ctx: HttpContext,
  query: string,
  options: { timeoutMs?: number; limit?: number; logger?: LoggerLike } = {},
): Promise<ConsoleSearchResults> {
  const q = query.trim().slice(0, 200);
  const result: ConsoleSearchResults = { version: 1, query: q, groups: [] };
  if (q.length === 0 || !registry) return result;
  const timeoutMs = options.timeoutMs ?? CONSOLE_PROBE_TIMEOUT_MS;
  const limit = options.limit ?? CONSOLE_SEARCH_LIMIT;
  const searchable = sortEntries(registry.entries.filter((e) => typeof e.search === 'function'));
  const self = searchable.filter((e) => e.id === selfId);
  const others = await allowedEntries(
    searchable.filter((e) => e.id !== selfId),
    ctx,
    timeoutMs,
    options.logger,
  );
  const targets = sortEntries([...self, ...others]);
  // Real searches by the viewer: run without the probe marker.
  const hits = await Promise.all(
    targets.map((entry) => race(() => entry.search!(ctx, q, limit), timeoutMs)),
  );
  targets.forEach((entry, i) => {
    const found = hits[i];
    if (!Array.isArray(found)) return;
    const safe = found
      .filter((h) => h && typeof h.title === 'string' && isSameOriginPath(h.href))
      .slice(0, limit)
      .map((h) => ({
        title: h.title,
        ...(typeof h.subtitle === 'string' ? { subtitle: h.subtitle } : {}),
        href: h.href,
      }));
    if (safe.length > 0) {
      result.groups.push({
        id: entry.id,
        title: entry.title,
        icon: iconOf(entry.icon),
        hits: safe,
      });
    }
  });
  return result;
}
