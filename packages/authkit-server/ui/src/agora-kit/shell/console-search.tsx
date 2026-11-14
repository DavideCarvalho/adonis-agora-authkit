import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { fetchSearchGroups, type SearchGroup } from '../console-data';
import { ConsoleTile, consoleAccent, SearchIcon } from '../icons';
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
 * A console-local ⌘K entry (a page, a filter, a view), matched in the browser on its label and
 * keywords and listed above the cross-console hits. `onSelect` runs in-app (no navigation).
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
  onSelect: () => void;
}

/** Case-insensitive substring match on label + keywords; an empty query keeps everything. */
export function filterCommands(commands: readonly SearchCommand[], q: string): SearchCommand[] {
  const query = q.trim().toLowerCase();
  if (query === '') return [...commands];
  return commands.filter((c) =>
    [c.label, ...(c.keywords ?? [])].some((text) => text.toLowerCase().includes(query)),
  );
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
 * ⌘K: one query across every console the viewer may open, grouped by console (shadcn `Command`
 * on cmdk, server-filtered). Enter or click follows the hit (a same-origin link). A console may
 * add its own `commands` (local jumps, filtered in the browser, listed first); without a `config`
 * only those are searched.
 *
 * Loading: a spinner in the input row while a request is in flight (debounce included), skeleton
 * rows until the first answer, the previous hits dimmed during a re-search, and "Nothing found"
 * only once an answer came back empty. A failed request shows a muted line with a retry.
 */
export function ConsoleSearch({
  config,
  commands,
  open,
  onOpenChange,
  placeholder = 'Search runs, payments, users…',
}: {
  config?: SearchConfig | undefined;
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

  const local = useMemo(() => filterCommands(commands ?? [], q), [commands, q]);
  const localGroups = useMemo(() => {
    const byGroup = new Map<string, SearchCommand[]>();
    for (const c of local) byGroup.set(c.group, [...(byGroup.get(c.group) ?? []), c]);
    return [...byGroup.entries()];
  }, [local]);

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
  const hitCount = groups.reduce((n, g) => n + g.hits.length, 0) + local.length;
  const nothing =
    query !== '' && local.length === 0 && groups.length === 0 && (!remote || phase === 'done');

  const label = config ? 'Search all consoles' : 'Search';
  const go = (href: string) => {
    onOpenChange(false);
    window.location.assign(href);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={label}
      description={config ? 'Search every console you can open' : 'Jump to a page'}
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
          {query === '' && local.length === 0 && (
            <p className="px-3 py-6 text-center text-[13px] text-dim">Type to search.</p>
          )}
          {nothing && (
            <p data-agora-search-empty="" className="px-3 py-6 text-center text-[13px] text-dim">
              Nothing found.
            </p>
          )}
          {localGroups.map(([group, items]) => (
            <CommandGroup
              key={`local:${group}`}
              heading={<span className="uppercase tracking-[0.14em]">{group}</span>}
            >
              {items.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`local:${c.id}`}
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
                    href={hit.href}
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
