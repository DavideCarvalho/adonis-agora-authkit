import {
  type unstable_AdapterInterface as AdapterInterface,
  unstable_createAdapterProvider as createAdapterProvider,
  renderQueryString,
  type unstable_UpdateUrlFunction as UpdateUrlFunction,
} from 'nuqs/adapters/custom';
import { type ReactNode, useRef, useSyncExternalStore } from 'react';
import { readHashSearch, splitHash, subscribeHashUrl, writeHashSearch } from './hash-url';

/**
 * Writes nuqs' query into the hash, keeping the route path: `#/entries` + `{ type: 'query' }` →
 * `#/entries?type=query`. nuqs passes `history: 'replace'` (its default) or `'push'` (a hook or
 * setter called with `{ history: 'push' }`).
 */
const updateUrl: UpdateUrlFunction = (search, options) => {
  writeHashSearch(renderQueryString(search), options.history);
  if (options.scroll && typeof window !== 'undefined') window.scrollTo({ top: 0 });
};

function hashSearchString(): string {
  if (typeof window === 'undefined') return '';
  return splitHash(window.location.hash).search;
}

/** Only the keys this hook watches (all of them when it watches none), in URL order. */
function pick(search: string, watchKeys: string[]): URLSearchParams {
  const all = new URLSearchParams(search);
  if (watchKeys.length === 0) return all;
  const picked = new URLSearchParams();
  for (const [key, value] of all) if (watchKeys.includes(key)) picked.append(key, value);
  return picked;
}

function useHashAdapter(watchKeys: string[]): AdapterInterface {
  // `useSyncExternalStore` needs a stable snapshot: hand back the same object until the watched
  // keys' values change, so a write to another key does not re-render this hook.
  const cache = useRef<{ key: string; params: URLSearchParams } | null>(null);
  const snapshot = (): URLSearchParams => {
    const params = pick(hashSearchString(), watchKeys);
    const key = params.toString();
    if (cache.current?.key === key) return cache.current.params;
    cache.current = { key, params };
    return params;
  };
  const searchParams = useSyncExternalStore(subscribeHashUrl, snapshot, snapshot);
  return {
    searchParams,
    updateUrl,
    // nuqs reads the live URL through this after a flush; its default reads `location.search`,
    // which in a hash-routed console is not where the query lives.
    getSearchParamsSnapshot: readHashSearch,
  };
}

const HashAdapterProvider = createAdapterProvider(useHashAdapter);

/**
 * nuqs adapter for a hash-routed console (`#/<page>?<query>`). Wrap the console once; every
 * `useQueryState(s)` below it then reads and writes the hash's query, never the page's real
 * `?query` (which stays the server's: `?app=`, `?tenant=` …) and never the route path.
 *
 * Defaults: `clearOnDefault` (a value equal to its parser default leaves the URL) and
 * `history: 'replace'`. Pass `{ history: 'push' }` on a setter for changes back/forward should step
 * through (a page, a tab, a picked option).
 */
export function NuqsHashAdapter({ children }: { children: ReactNode }) {
  return (
    <HashAdapterProvider defaultOptions={{ clearOnDefault: true, history: 'replace' }}>
      {children}
    </HashAdapterProvider>
  );
}
