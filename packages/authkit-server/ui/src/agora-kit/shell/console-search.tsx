import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { fetchSearchGroups, type SearchGroup } from '../console-data';
import { ConsoleTile, consoleAccent, SearchIcon } from '../icons';
import { withPageScope } from '../lib/scope-carry';
import { cn } from '../lib/utils';
import type { SearchConfig } from '../shell-config';
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../ui/command';
import { Kbd } from '../ui/kbd';
import { Skeleton } from '../ui/skeleton';

/**
 * One ⌘K entry matched in the browser on its label and keywords: a page of this console, another
 * console, or a console-local command (a filter, a view). `onSelect` runs in-app.
 */
export interface SearchCommand {
  id: string;
  label: string;
  /** Group heading ("Pages", "Entry types"). */
  group: string;
  hint?: string;
  /** A 16px icon or a colour dot. */
  icon?: ReactNode;
  keywords?: string[];
  /** Listed only once something is typed (a long secondary list such as watchers). */
  hideUntilTyped?: boolean;
  onSelect: () => void;
}

/** Lower case, accents stripped, whitespace collapsed: "Agêntes " → "agentes". */
export function normalizeSearchText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function wordsOf(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** "agents" → "agent", "queues" → "queu": enough for "agente" to reach "Agents". */
function stem(word: string): string {
  return word.replace(/(es|s)$/, '');
}

/** A typed word reaches a word: as its prefix, or as the word's stem plus a short ending. */
function wordMatches(token: string, word: string): boolean {
  if (word.startsWith(token)) return true;
  const root = stem(word);
  return root.length >= 4 && token.startsWith(root) && token.length - root.length <= 2;
}

/**
 * How well `query` matches `label` / `keywords` (lower is better), or `undefined` for no match.
 * Case- and accent-insensitive: exact label, label prefix, a label word's prefix, label substring,
 * then the same on keywords, then every typed word reaching some word (with plural/gender endings
 * forgiven). An empty query matches everything with score 0.
 */
export function matchScore(
  query: string,
  label: string,
  keywords: readonly string[] = [],
): number | undefined {
  const q = normalizeSearchText(query);
  if (q === '') return 0;
  const l = normalizeSearchText(label);
  if (l === q) return 0;
  if (l.startsWith(q)) return 1;
  const labelWords = wordsOf(l);
  if (labelWords.some((w) => w.startsWith(q))) return 2;
  if (l.includes(q)) return 3;
  const keys = keywords.map(normalizeSearchText);
  if (keys.some((k) => k === q || k.startsWith(q))) return 4;
  if (keys.some((k) => wordsOf(k).some((w) => w.startsWith(q)) || k.includes(q))) return 5;
  const tokens = wordsOf(q);
  const words = [...labelWords, ...keys.flatMap(wordsOf)];
  if (tokens.length > 0 && tokens.every((t) => words.some((w) => wordMatches(t, w)))) return 6;
  return undefined;
}

/**
 * The commands matching `q` on label + keywords, best match first (ties keep their order). An
 * empty query keeps everything except `hideUntilTyped` entries.
 */
export function filterCommands(commands: readonly SearchCommand[], q: string): SearchCommand[] {
  if (normalizeSearchText(q) === '') return commands.filter((c) => !c.hideUntilTyped);
  return commands
    .map((command, index) => ({
      command,
      index,
      score: matchScore(q, command.label, command.keywords),
    }))
    .filter(
      (m): m is { command: SearchCommand; index: number; score: number } => m.score !== undefined,
    )
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((m) => m.command);
}

/**
 * `commands` grouped by `group` (groups keep their first-seen order), each group filtered and
 * ranked by {@link filterCommands}; groups left empty are dropped.
 */
export function groupCommands(
  commands: readonly SearchCommand[],
  q: string,
): [string, SearchCommand[]][] {
  const groups = new Map<string, SearchCommand[]>();
  for (const c of commands) groups.set(c.group, [...(groups.get(c.group) ?? []), c]);
  return [...groups.entries()]
    .map(([group, items]): [string, SearchCommand[]] => [group, filterCommands(items, q)])
    .filter(([, items]) => items.length > 0);
}

/** Ctrl/Cmd-K toggles `setOpen` while `enabled`. */
export function useSearchShortcut(
  enabled: boolean,
  setOpen: (fn: (open: boolean) => boolean) => void,
) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, setOpen]);
}

/** The topbar's search button ("Search ⌘K"). */
export function SearchTrigger({
  onOpen,
  className,
  label = 'Search all consoles',
}: {
  onOpen: () => void;
  className?: string;
  /** Match the palette it opens: "Search" when only console-local commands are searched. */
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-keyshortcuts="Control+K Meta+K"
      aria-label={label}
      className={cn(
        'flex h-[26px] items-center gap-2 rounded-[6px] px-2.5 text-[11px] font-medium text-dim transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        className,
      )}
    >
      <SearchIcon className="size-[13px]" />
      <span className="hidden sm:inline">Search</span>
      <Kbd className="mono hidden h-4 text-[9px] sm:inline-flex">⌘K</Kbd>
    </button>
  );
}

/** The ring in the input row while a search is in flight (static under reduced motion). */
function Spinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      aria-hidden
      data-agora-search-spinner=""
      className={cn('animate-spin text-dim motion-reduce:animate-none', className)}
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity={0.25} strokeWidth={1.8} />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
    </svg>
  );
}

/** Placeholder rows shaped like hits (console tile + title + subtitle) while the first answer loads. */
function SearchSkeleton() {
  return (
    <div data-agora-search-skeleton="" aria-hidden className="p-1">
      <div className="px-2 py-1.5 text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
        Searching consoles…
      </div>
      {[0.55, 0.4, 0.48].map((width) => (
        <div key={width} className="flex items-center gap-2.5 px-2 py-1.5">
          <Skeleton className="size-[18px] shrink-0 rounded-[5px] bg-fg/[0.08] motion-reduce:animate-none" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton
              className="h-3 rounded-sm bg-fg/[0.08] motion-reduce:animate-none"
              style={{ width: `${width * 100}%` }}
            />
            <Skeleton
              className="h-2.5 rounded-sm bg-fg/[0.08] motion-reduce:animate-none"
              style={{ width: `${width * 55}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

type Phase = 'idle' | 'loading' | 'done' | 'error';

/**
 * ⌘K (shadcn `Command` on cmdk): `navigation` (this console's pages, then the other consoles) and
 * the console's own `commands` are matched in the browser and listed first, in that order; then one
 * query across every console the viewer may open (`config`), grouped by console. Enter or click
 * runs the entry or follows the hit (a same-origin link). Before anything is typed the navigation
 * and commands are listed (minus `hideUntilTyped` ones). Without a `config` nothing is fetched.
 *
 * Loading: a spinner in the input row while a request is in flight (debounce included), skeleton
 * rows until the first answer, the previous hits dimmed during a re-search, and "Nothing found"
 * only once an answer came back empty. A failed request shows a muted line with a retry.
 */
export function ConsoleSearch({
  config,
  navigation,
  commands,
  open,
  onOpenChange,
  placeholder = config ? 'Jump to a page, or search runs, payments, users…' : 'Jump to a page…',
}: {
  config?: SearchConfig | undefined;
  /** Pages and consoles to jump to (AppShell builds them from the nav and the switcher). */
  navigation?: readonly SearchCommand[] | undefined;
  commands?: readonly SearchCommand[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  // Navigation first (pages of this console, then consoles), then the console's own commands.
  // `local:` keeps their cmdk values apart from the server hits.
  const localGroups = useMemo(
    () => [
      ...groupCommands(navigation ?? [], q).map(
        ([group, items]): [string, string, SearchCommand[]] => [`nav:${group}`, group, items],
      ),
      ...groupCommands(commands ?? [], q).map(
        ([group, items]): [string, string, SearchCommand[]] => [`cmd:${group}`, group, items],
      ),
    ],
    [navigation, commands, q],
  );
  const localCount = localGroups.reduce((n, [, , items]) => n + items.length, 0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` re-runs the search (Retry)
  useEffect(() => {
    const query = q.trim();
    if (query === '' || !config) {
      setGroups([]);
      setPhase('idle');
      return;
    }
    const controller = new AbortController();
    setPhase('loading');
    const timer = setTimeout(() => {
      fetchSearchGroups(config, query, controller.signal).then(
        (found) => {
          if (controller.signal.aborted) return;
          setGroups(found);
          setPhase('done');
        },
        () => {
          if (controller.signal.aborted) return;
          setGroups([]);
          setPhase('error');
        },
      );
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [q, config, attempt]);

  const query = q.trim();
  const remote = config !== undefined && query !== '';
  const pending = remote && phase === 'loading';
  const stale = pending && groups.length > 0;
  const hitCount = groups.reduce((n, g) => n + g.hits.length, 0) + localCount;
  const nothing =
    query !== '' && localCount === 0 && groups.length === 0 && (!remote || phase === 'done');

  const label = config ? 'Search all consoles' : 'Search';
  const go = (href: string) => {
    onOpenChange(false);
    window.location.assign(withPageScope(href));
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={label}
      description={
        config
          ? 'Jump to a page or console, or search every console you can open'
          : 'Jump to a page or console'
      }
      className="sm:max-w-xl"
    >
      <Command shouldFilter={false} label={label}>
        <div className="relative">
          <CommandInput
            value={q}
            onValueChange={setQ}
            placeholder={placeholder}
            aria-label={label}
            className="pr-7"
          />
          {pending && (
            <Spinner className="pointer-events-none absolute top-[calc(50%+2px)] right-3.5 -translate-y-1/2" />
          )}
        </div>
        <span role="status" className="sr-only">
          {pending
            ? 'Searching…'
            : remote && phase === 'error'
              ? 'Search failed'
              : query !== ''
                ? `${hitCount} results`
                : ''}
        </span>
        <CommandList className="max-h-[60vh]" aria-busy={pending}>
          {query === '' && localCount === 0 && (
            <p className="px-3 py-6 text-center text-[13px] text-dim">Type to search.</p>
          )}
          {nothing && (
            <p data-agora-search-empty="" className="px-3 py-6 text-center text-[13px] text-dim">
              Nothing found.
            </p>
          )}
          {localGroups.map(([key, group, items]) => (
            <CommandGroup
              key={key}
              heading={<span className="uppercase tracking-[0.14em]">{group}</span>}
            >
              {items.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`local:${key}:${c.id}`}
                  onSelect={() => {
                    onOpenChange(false);
                    c.onSelect();
                  }}
                >
                  {c.icon}
                  <span className="truncate text-[13px] text-fg">{c.label}</span>
                  {c.hint && <span className="ml-auto text-[11px] text-dim">{c.hint}</span>}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
          {pending && groups.length === 0 && <SearchSkeleton />}
          {groups.map((group) => (
            <CommandGroup
              key={group.id}
              data-stale={stale ? '' : undefined}
              className={cn(
                'transition-opacity duration-150 motion-reduce:transition-none',
                stale && 'opacity-50',
              )}
              heading={
                <span className="flex items-center gap-1.5 uppercase tracking-[0.14em]">
                  <ConsoleTile
                    icon={group.icon}
                    accent={consoleAccent(group.id, group.icon)}
                    size={18}
                  />
                  {group.title}
                </span>
              }
            >
              {group.hits.map((hit) => (
                <CommandItem
                  key={hit.href}
                  value={`${group.id}:${hit.href}`}
                  onSelect={() => go(hit.href)}
                >
                  <a
                    href={withPageScope(hit.href)}
                    tabIndex={-1}
                    className="flex min-w-0 flex-col"
                    onClick={(e) => {
                      e.preventDefault();
                      go(hit.href);
                    }}
                  >
                    <span className="mono truncate text-[13px] text-fg">{hit.title}</span>
                    {hit.subtitle && (
                      <span className="truncate text-[11px] text-dim">{hit.subtitle}</span>
                    )}
                  </a>
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
          {remote && phase === 'error' && (
            <p
              data-agora-search-error=""
              className="flex items-center justify-center gap-2 px-3 py-3 text-[12px] text-faint"
            >
              The other consoles didn't answer.
              <button
                type="button"
                onClick={() => setAttempt((n) => n + 1)}
                className="rounded-sm text-dim underline underline-offset-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                Retry
              </button>
            </p>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
