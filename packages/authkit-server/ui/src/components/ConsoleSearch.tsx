import { useQuery } from '@tanstack/react-query';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { getConfig } from '../lib/config';
import { getJson, moveIndex, parseSearchGroups } from '../lib/console_switcher';
import { useDebounce } from '../lib/use_debounce';
import { ConsoleIcon } from './console-switcher-icons';

/**
 * Global search (Ctrl/Cmd-K) across this console and every other `@adonis-agora` console the viewer
 * may open: users and organizations here, runs, payments, files… in the others.
 */
export function ConsoleSearch() {
  const endpoint = getConfig().search?.endpoint;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!endpoint) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [endpoint]);

  if (!endpoint) return null;
  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm search-trigger"
        onClick={() => setOpen(true)}
        aria-keyshortcuts="Control+K Meta+K"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14" strokeLinecap="round" />
        </svg>
        Search
        <kbd>⌘K</kbd>
      </button>
      {open && <SearchDialog endpoint={endpoint} onClose={() => setOpen(false)} />}
    </>
  );
}

function SearchDialog({ endpoint, onClose }: { endpoint: string; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const debounced = useDebounce(query.trim(), 200);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const returnFocus = useRef<Element | null>(null);

  useEffect(() => {
    returnFocus.current = document.activeElement;
    inputRef.current?.focus();
    return () => {
      (returnFocus.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  const { data, isFetching, isError } = useQuery({
    queryKey: ['agora-console-search', endpoint, debounced],
    queryFn: async ({ signal }) =>
      parseSearchGroups(await getJson(`${endpoint}?q=${encodeURIComponent(debounced)}`, signal)),
    enabled: debounced.length > 0,
    staleTime: 30_000,
    retry: false,
  });
  const groups = data ?? [];
  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);

  useEffect(() => setActive(0), [debounced]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Enter') {
      const hit = flat[active];
      if (hit) {
        event.preventDefault();
        window.location.assign(hit.href);
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => moveIndex(current, event.key, flat.length));
    }
  };

  let index = -1;
  return (
    <div className="modal-overlay search-overlay" onMouseDown={onClose}>
      <div
        className="search-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Search consoles"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="search-input"
          type="search"
          placeholder="Search users, organizations and every console you can open…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls={listId}
          aria-activedescendant={flat.length > 0 ? `${listId}-${active}` : undefined}
          aria-autocomplete="list"
        />
        <div id={listId} className="search-results" role="listbox" aria-label="Results">
          {debounced.length === 0 && <div className="search-empty">Type to search.</div>}
          {debounced.length > 0 && isFetching && groups.length === 0 && (
            <div className="search-empty">Searching…</div>
          )}
          {debounced.length > 0 && !isFetching && isError && (
            <div className="search-empty">Search failed. Try again.</div>
          )}
          {debounced.length > 0 && !isFetching && !isError && groups.length === 0 && (
            <div className="search-empty">No results.</div>
          )}
          {groups.map((group) => (
            <div key={group.id} className="search-group" role="group" aria-label={group.title}>
              <div className="search-group-title">
                <ConsoleIcon icon={group.icon} size={14} />
                {group.title}
              </div>
              {group.hits.map((hit) => {
                index += 1;
                const position = index;
                return (
                  <a
                    key={`${group.id}-${hit.href}`}
                    id={`${listId}-${position}`}
                    className={`search-hit${position === active ? ' active' : ''}`}
                    role="option"
                    aria-selected={position === active}
                    href={hit.href}
                    tabIndex={-1}
                    onMouseEnter={() => setActive(position)}
                  >
                    <span className="search-hit-title">{hit.title}</span>
                    {hit.subtitle && <span className="search-hit-sub">{hit.subtitle}</span>}
                  </a>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
