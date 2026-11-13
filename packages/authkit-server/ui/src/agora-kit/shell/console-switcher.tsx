import { type ReactNode, useEffect, useState } from 'react';
import { loadConsoles, type SwitcherConsole } from '../console-data';
import {
  CheckIcon,
  ChevronDownIcon,
  type ConsoleIconKey,
  ConsoleTile,
  consoleAccent,
  SearchIcon,
} from '../icons';
import { cn } from '../lib/utils';
import type { SwitcherConfig } from '../shell-config';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

export interface CurrentConsole {
  /** Product title shown in the menu ("Workflows"). */
  title: string;
  package?: string;
  icon: ConsoleIconKey;
}

/** The other consoles this viewer may open (fetched once, after first paint; `[]` until then). */
export function useConsoles(config: SwitcherConfig | undefined): SwitcherConsole[] {
  const [consoles, setConsoles] = useState<SwitcherConsole[]>([]);
  useEffect(() => {
    if (!config) return;
    let live = true;
    void loadConsoles(config).then((list) => {
      if (live) setConsoles(list);
    });
    return () => {
      live = false;
    };
  }, [config]);
  return consoles;
}

/**
 * The brand, turned into a switcher to the other Agora consoles (shadcn `DropdownMenu`). With no
 * `config` or an empty list it is the plain brand and makes no request. The current console is
 * listed first (checked, not a link); the others are plain links (same origin = same session).
 */
export function ConsoleSwitcher({
  brand,
  current,
  config,
  onSearch,
}: {
  brand: ReactNode;
  current: CurrentConsole;
  config: SwitcherConfig | undefined;
  /** Adds "Search all consoles ⌘K" at the bottom of the menu. */
  onSearch?: () => void;
}) {
  const consoles = useConsoles(config);
  if (!config || consoles.length === 0) return <>{brand}</>;
  return (
    <div data-agora-switcher="" className="min-w-0">
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`${current.title}: switch console`}
          className="flex w-full min-w-0 items-center gap-2 rounded-md p-1 text-left outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-ring/60 data-popup-open:bg-sidebar-accent/60"
        >
          <span className="min-w-0 flex-1">{brand}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-dim" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-64 border border-border bg-popover shadow-(--agora-shadow) ring-0"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.16em] text-dim">
              Consoles
            </DropdownMenuLabel>
            <DropdownMenuItem disabled aria-current="page" className="data-disabled:opacity-100">
              <ConsoleTile icon={current.icon} accent="var(--agora-accent)" />
              <ConsoleLabel title={current.title} pkg={current.package} />
              <CheckIcon aria-label="Current console" className="ml-auto text-brand" />
            </DropdownMenuItem>
            {consoles.map((c) => (
              <DropdownMenuItem key={c.id} render={<a href={c.href} />}>
                <ConsoleTile icon={c.icon} accent={consoleAccent(c.id, c.icon)} />
                <ConsoleLabel title={c.title} pkg={c.package} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          {onSearch && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onSearch}>
                <SearchIcon className="text-dim" />
                Search all consoles
                <DropdownMenuShortcut className="mono">⌘K</DropdownMenuShortcut>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ConsoleLabel({ title, pkg }: { title: string; pkg: string | undefined }) {
  return (
    <span className={cn('flex min-w-0 flex-col leading-tight')}>
      <span className="truncate">{title}</span>
      {pkg && <span className="mono truncate text-[10px] text-dim">{pkg}</span>}
    </span>
  );
}
