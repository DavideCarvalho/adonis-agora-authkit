import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDownIcon } from '../icons';
import { cn } from '../lib/utils';
import { buttonVariants } from '../ui/button';

/** One choice in a {@link ScopeMenu}. */
export interface ScopeOption {
  id: string;
  label: string;
  /** Shown on the right instead of the id (`federated`). */
  hint?: string;
}

/** The words a {@link ScopeMenu} shows. */
export interface ScopeMenuText {
  /** The control's label (`Organization`, `App`). */
  noun: string;
  /** The "everything" option (`All organizations`). */
  all: string;
  /** The button text with nothing picked and no "everything" option. */
  some: string;
  /** The search box's label (and placeholder). */
  search: string;
  /** Shown when the search matches nothing. */
  empty: string;
}

const ALL = '*';

/** The small text on an option's right: its hint, else its id when the label differs. */
function sideText(option: ScopeOption): string | undefined {
  return option.hint ?? (option.label !== option.id ? option.id : undefined);
}

/** Arrow navigation over `count` options (wraps around). */
function moveIndex(current: number, key: string, count: number): number {
  if (count <= 0) return -1;
  if (key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % count;
  if (key === 'ArrowUp') return current <= 0 ? count - 1 : current - 1;
  return current;
}

/** The fixed chip a header picker shows when the viewer has one choice (or none). */
export function ScopeChip({ noun, label, kind }: { noun: string; label: string; kind: string }) {
  return (
    <span
      className="inline-flex h-[26px] items-center gap-1.5 rounded-[6px] border border-border bg-panel-2 px-2.5 text-[11px]"
      {...{ [`data-${kind}-chip`]: '' }}
    >
      <span className="hidden text-faint sm:inline">{noun}</span>
      <span className="max-w-32 truncate text-fg">{label}</span>
    </span>
  );
}

/**
 * The header's App / Organization pickers of every console: one look everywhere. A searchable header picker: the button opens a combobox over a listbox (arrows move, Enter
 * picks, Escape closes), with the "everything" option first when `all` is offered.
 * `onChoose(undefined)` means everything.
 */
export function ScopeMenu({
  items,
  all,
  current,
  text,
  labelOf,
  onChoose,
}: {
  items: ScopeOption[];
  all: boolean;
  current: string | undefined;
  text: ScopeMenuText;
  labelOf: (id: string) => string;
  onChoose: (id: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const options = useMemo<ScopeOption[]>(() => {
    const base = all ? [{ id: ALL, label: text.all }, ...items] : items;
    const q = query.trim().toLowerCase();
    return q === ''
      ? base
      : base.filter((o) => o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q));
  }, [items, all, text.all, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  const choose = (option: ScopeOption | undefined) => {
    if (!option) return;
    setOpen(false);
    const next = option.id === ALL ? undefined : option.id;
    if (next !== current) onChoose(next);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(options[active]);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => moveIndex(i, event.key, options.length));
    }
  };

  const label = current === undefined ? (all ? text.all : text.some) : labelOf(current);

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={buttonVariants({ variant: 'outline', size: 'sm', className: 'max-w-56' })}
      >
        <span className="hidden text-faint sm:inline">{text.noun}</span>
        <span className="max-w-32 truncate text-fg">{label}</span>
        <ChevronDownIcon className="text-faint" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-md border border-border bg-popover text-[13px] shadow-(--agora-shadow)">
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-label={text.search}
            {...(options[active] ? { 'aria-activedescendant': `${listId}-${active}` } : {})}
            placeholder={`${text.search}…`}
            onKeyDown={onKeyDown}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            className="w-full border-b border-border bg-transparent px-3 py-2.5 text-xs text-fg outline-hidden placeholder:text-faint"
          />
          {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: composite ARIA listbox driven from the combobox input. */}
          <ul id={listId} role="listbox" className="max-h-64 overflow-y-auto py-1">
            {options.length === 0 && <li className="px-3 py-2 text-xs text-faint">{text.empty}</li>}
            {options.map((option, i) => {
              const selected = option.id === ALL ? current === undefined : option.id === current;
              return (
                // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the combobox input.
                <li
                  key={option.id}
                  id={`${listId}-${i}`}
                  // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: composite ARIA option.
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(option);
                  }}
                  className={cn(
                    'mx-1 flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-xs',
                    i === active ? 'bg-hover text-fg' : 'text-fg-2',
                    selected && 'font-medium text-brand',
                  )}
                >
                  <span className="truncate">{option.label}</span>
                  {option.id !== ALL && sideText(option) !== undefined && (
                    <span className="mono shrink-0 text-[10.5px] text-faint">
                      {sideText(option)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
