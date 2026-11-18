/**
 * The console's URL lives in the hash: `#/<route path>?<query>`. The route path picks the page;
 * the query holds that page's view state (filters, search, tabs, window, page cursors). These
 * helpers split and join the two halves and tell subscribers when either changes, whoever changed
 * it: a link or `location.hash = …` (`hashchange`), back/forward (`popstate`), or a
 * `history.pushState`/`replaceState` write made through {@link writeHashSearch} — which fires
 * neither event, so it notifies subscribers itself.
 *
 * No React, no nuqs: a console's own hash router can subscribe here too, so its route state follows
 * query-only writes.
 */

/** `#/entries?type=query` → `{ path: '/entries', search: 'type=query' }`. Splits on the first `?`. */
export function splitHash(hash: string): { path: string; search: string } {
  const clean = hash.startsWith('#') ? hash.slice(1) : hash;
  const at = clean.indexOf('?');
  return at === -1
    ? { path: clean, search: '' }
    : { path: clean.slice(0, at), search: clean.slice(at + 1) };
}

/** `('/entries', '?type=query')` → `#/entries?type=query`. A leading `?` on `search` is optional;
 *  an empty search leaves no trailing `?`. */
export function joinHash(path: string, search: string): string {
  const query = search.startsWith('?') ? search.slice(1) : search;
  return query === '' ? `#${path}` : `#${path}?${query}`;
}

/** The query half of the current `location.hash` (empty outside a browser). */
export function readHashSearch(): URLSearchParams {
  if (typeof window === 'undefined') return new URLSearchParams();
  return new URLSearchParams(splitHash(window.location.hash).search);
}

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Write a new query into the hash, keeping the route path. `push` adds a history entry (back
 * returns to the previous view), `replace` rewrites the current one (typing in a search box).
 * A no-op when the hash would not change.
 */
export function writeHashSearch(search: string, history: 'push' | 'replace' = 'replace'): void {
  if (typeof window === 'undefined') return;
  const { path } = splitHash(window.location.hash);
  const hash = joinHash(path, search);
  if (hash === window.location.hash || (hash === '#' && window.location.hash === '')) return;
  const { pathname, search: pageSearch } = window.location;
  const url = `${pathname}${pageSearch}${hash}`;
  if (history === 'push') window.history.pushState(window.history.state, '', url);
  else window.history.replaceState(window.history.state, '', url);
  notify();
}

/**
 * Call `listener` whenever the hash (path or query) may have changed. Returns the unsubscribe.
 * Shaped for `useSyncExternalStore`.
 */
export function subscribeHashUrl(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window === 'undefined') {
    return () => {
      listeners.delete(listener);
    };
  }
  window.addEventListener('hashchange', listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('hashchange', listener);
    window.removeEventListener('popstate', listener);
  };
}
