/**
 * Agora console kit — copied verbatim into every @adonis-agora console (canonical copy:
 * `_1x/shared/console-kit`). `ui/` holds vendored shadcn/ui components (Base UI flavour); the rest
 * are compositions of them. Nothing here knows which console it is in: brand, accent and nav come
 * in as props. Import vendored components from `./ui/<name>` directly (shadcn convention); the
 * shell, blocks and helpers are re-exported here.
 */

export { ActionDialog } from './blocks/action-dialog';
export { type Column, DataTable } from './blocks/data-table';
export { EmptyState } from './blocks/empty-state';
export { ErrorBoundary, type ErrorBoundaryProps, RegionError } from './blocks/error-boundary';
export { Hint } from './blocks/hint';
export { MetricCard, MetricGrid, MetricGridSkeleton, type MetricTone } from './blocks/metric-card';
export { PageHeader, Toolbar } from './blocks/page-header';
export type { CursorMeta, OffsetMeta } from './blocks/pager';
export { LoadMore, Pager } from './blocks/pager';
export { Panel } from './blocks/panel';
export { errorStatus, QueryBoundary, type QueryLike } from './blocks/query-boundary';
export {
  loadConsoles,
  resetConsoleCache,
  type SearchGroup,
  type SearchHit,
  type SwitcherConsole,
  sanitizeConsoles,
  sanitizeSearchGroups,
  searchConsoles,
} from './console-data';
export * from './icons';
export { cn } from './lib/utils';
export {
  AppShell,
  BrandBlock,
  type ConsoleBrand,
  type NavItem,
  type NavSection,
  PageBody,
  Topbar,
} from './shell/app-shell';
export { ConsoleSearch, SearchTrigger, useSearchShortcut } from './shell/console-search';
export { ConsoleSwitcher, type CurrentConsole, useConsoles } from './shell/console-switcher';
export { UserFooter } from './shell/user-footer';
export {
  type AgoraShellConfig,
  isSafeHref,
  parseShellConfig,
  readShellConfig,
  type SearchConfig,
  type SignOut,
  type SwitcherConfig,
  type Viewer,
} from './shell-config';
export { applyTheme, type Theme, ThemeProvider, useTheme } from './theme';
