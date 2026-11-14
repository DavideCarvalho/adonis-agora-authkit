import { type CSSProperties, type ReactNode, useCallback, useState } from 'react';
import { ChevronDownIcon } from '../icons';
import { cn } from '../lib/utils';
import type { AgoraShellConfig } from '../shell-config';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '../ui/sidebar';
import { TooltipProvider } from '../ui/tooltip';
import {
  ConsoleSearch,
  type SearchCommand,
  SearchTrigger,
  useSearchShortcut,
} from './console-search';
import { ConsoleSwitcher, type CurrentConsole } from './console-switcher';
import { UserFooter } from './user-footer';

/** One sidebar entry. Give it an `href` (a real link) or an `onSelect` (an in-app action). */
export interface NavItem {
  id: string;
  label: string;
  /** A 16px stroke icon. */
  icon: ReactNode;
  href?: string;
  onSelect?: () => void;
  /** A small count/status at the end of the row. */
  badge?: ReactNode;
}

/** A group of entries under an UPPERCASE section label. */
export interface NavSection {
  section: string;
  items: NavItem[];
  /** agora: the label becomes a toggle that folds the section (a long list such as watchers). */
  collapsible?: boolean;
  /** agora: initial state of a collapsible section (default open). */
  defaultOpen?: boolean;
}

/** Per-console brand, passed from OUTSIDE the kit. */
export interface ConsoleBrand {
  /** Shown big in the sidebar ("durable"). */
  name: ReactNode;
  /** Shown small under the name ("control plane"). */
  subtitle?: ReactNode;
  /** The console's mark (an SVG in currentColor; the kit tints it with the accent). */
  mark: ReactNode;
  /** The switcher's view of this console. */
  current: CurrentConsole;
}

/** The brand block: accent-tinted mark tile + name + subtitle. */
export function BrandBlock({ brand }: { brand: ConsoleBrand }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="relative grid size-[30px] shrink-0 place-items-center rounded-md border border-brand-border bg-brand-soft text-brand [&_svg]:size-4">
        {brand.mark}
        <span className="agora-ring" aria-hidden />
      </div>
      <div className="min-w-0 overflow-hidden">
        <div className="truncate text-sm font-bold tracking-[0.03em] text-fg">{brand.name}</div>
        {brand.subtitle && (
          <div className="mt-px truncate text-[10px] font-medium uppercase tracking-[0.08em] text-faint">
            {brand.subtitle}
          </div>
        )}
      </div>
    </div>
  );
}

function NavMenu({ nav, activeId }: { nav: NavSection[]; activeId: string | undefined }) {
  const { isMobile, setOpenMobile } = useSidebar();
  const after = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);
  return (
    <>
      {nav
        .filter((section) => section.items.length > 0)
        .map((section) =>
          section.collapsible ? (
            <Collapsible key={section.section} defaultOpen={section.defaultOpen ?? true}>
              <SidebarGroup className="px-2.5 py-0">
                <SidebarGroupLabel
                  className={cn(navLabelClass, 'p-0')}
                  render={
                    <CollapsibleTrigger className="flex w-full items-center gap-1 rounded-md px-2 pt-3 pb-1.5 text-left uppercase hover:text-dim" />
                  }
                >
                  {section.section}
                  <ChevronDownIcon className="ml-auto size-3! -rotate-90 transition-transform in-data-panel-open:rotate-0" />
                </SidebarGroupLabel>
                <CollapsibleContent>
                  <SidebarGroupContent>
                    <NavItems items={section.items} activeId={activeId} after={after} />
                  </SidebarGroupContent>
                </CollapsibleContent>
              </SidebarGroup>
            </Collapsible>
          ) : (
            <SidebarGroup key={section.section} className="px-2.5 py-0">
              <SidebarGroupLabel className={navLabelClass}>{section.section}</SidebarGroupLabel>
              <SidebarGroupContent>
                <NavItems items={section.items} activeId={activeId} after={after} />
              </SidebarGroupContent>
            </SidebarGroup>
          ),
        )}
    </>
  );
}

const navLabelClass =
  'h-auto px-2 pt-3 pb-1.5 text-[9.5px] font-semibold uppercase tracking-[0.14em] text-faint';

function NavItems({
  items,
  activeId,
  after,
}: {
  items: NavItem[];
  activeId: string | undefined;
  after: () => void;
}) {
  return (
    <SidebarMenu className="gap-0.5">
      {items.map((item) => {
        const active = item.id === activeId;
        const content = (
          <>
            {item.icon}
            <span>{item.label}</span>
          </>
        );
        return (
          <SidebarMenuItem key={item.id}>
            {item.href ? (
              <SidebarMenuButton
                isActive={active}
                aria-current={active ? 'page' : undefined}
                className={navButtonClass}
                render={
                  <a
                    href={item.href}
                    onClick={(e) => {
                      if (item.onSelect) {
                        e.preventDefault();
                        item.onSelect();
                      }
                      after();
                    }}
                  />
                }
              >
                {content}
              </SidebarMenuButton>
            ) : (
              <SidebarMenuButton
                isActive={active}
                aria-current={active ? 'page' : undefined}
                className={navButtonClass}
                onClick={() => {
                  item.onSelect?.();
                  after();
                }}
              >
                {content}
              </SidebarMenuButton>
            )}
            {item.badge !== undefined && (
              <SidebarMenuBadge className="mono tnum text-[10px]">{item.badge}</SidebarMenuBadge>
            )}
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

/** authkit's `.nav-item`: 12.5px muted label, faint 15px icon; active = accent-soft fill, accent
 *  hairline, accent icon. */
const navButtonClass =
  'h-auto gap-[9px] rounded-md border border-transparent px-[9px] py-[7px] text-[12.5px] font-medium text-dim transition-colors hover:bg-hover hover:text-fg data-active:border-brand-border data-active:bg-brand-soft data-active:font-medium data-active:text-fg [&_svg]:size-[15px]! [&_svg]:text-faint hover:[&_svg]:text-dim data-active:[&_svg]:text-brand';

/** The topbar: sidebar toggle (drawer on phones), page title, page-level pickers, ⌘K. */
export function Topbar({
  title,
  actions,
  search,
}: {
  title: ReactNode;
  actions?: ReactNode;
  search?: ReactNode;
}) {
  return (
    <header className="sticky top-0 z-20 flex h-(--agora-topbar-h) shrink-0 items-center gap-3 border-b border-border bg-(--agora-topbar) px-3 backdrop-blur-md md:px-5">
      <SidebarTrigger className="-ml-1 text-dim md:hidden" />
      <div className="min-w-0 truncate text-sm font-semibold text-fg">{title}</div>
      <div className="ml-auto flex min-w-0 items-center gap-2">
        {actions}
        {search}
      </div>
    </header>
  );
}

/**
 * The console shell (shadcn `Sidebar` composition): left sidebar — brand + switcher, nav grouped
 * by UPPERCASE sections, footer with the viewer, theme toggle and sign-out — collapsing to a drawer
 * below 768px; a topbar with the page title, page-level pickers and ⌘K; the page in the content
 * column. Everything console-specific comes in through props.
 */
export function AppShell({
  brand,
  nav,
  activeId,
  shell,
  title,
  actions,
  children,
  searchPlaceholder,
  contentClassName,
  commands,
}: {
  brand: ConsoleBrand;
  nav: NavSection[];
  activeId: string | undefined;
  /** The parsed data block (`readShellConfig`). */
  shell: AgoraShellConfig;
  /** Topbar title (usually the page's name). */
  title: ReactNode;
  /** Topbar pickers / actions (tenant, environment, a quick-open…). */
  actions?: ReactNode;
  children: ReactNode;
  searchPlaceholder?: string | undefined;
  /** Classes for the scrolling content column (pages that manage their own scroll pass `overflow-hidden`). */
  contentClassName?: string | undefined;
  /** agora: console-local ⌘K entries (pages, filters); ⌘K works with these even without `shell.search`. */
  commands?: readonly SearchCommand[] | undefined;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const searchEnabled = shell.search !== undefined || (commands?.length ?? 0) > 0;
  useSearchShortcut(searchEnabled, setSearchOpen);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  return (
    <TooltipProvider delay={150}>
      <div className="agora-glow" aria-hidden />
      <SidebarProvider
        className="relative z-[1] h-svh min-h-0 overflow-hidden"
        style={{ '--sidebar-width': 'var(--agora-sidebar-w)' } as CSSProperties}
      >
        <Sidebar className="border-sidebar-border [&_[data-slot=sidebar-inner]]:backdrop-blur-md">
          <SidebarHeader className="border-b border-sidebar-border px-[18px] pt-[18px] pb-3.5">
            <ConsoleSwitcher
              brand={<BrandBlock brand={brand} />}
              current={brand.current}
              config={shell.switcher}
              {...(searchEnabled ? { onSearch: openSearch } : {})}
            />
          </SidebarHeader>
          <SidebarContent className="pt-1 pb-2">
            <nav aria-label="Console">
              <NavMenu nav={nav} activeId={activeId} />
            </nav>
          </SidebarContent>
          <SidebarFooter className="border-t border-sidebar-border px-3.5 py-3">
            <UserFooter
              {...(shell.viewer ? { viewer: shell.viewer } : {})}
              {...(shell.signOut ? { signOut: shell.signOut } : {})}
            />
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="min-h-0 min-w-0 overflow-hidden bg-transparent">
          <Topbar
            title={title}
            actions={actions}
            search={searchEnabled ? <SearchTrigger onOpen={openSearch} /> : undefined}
          />
          <div className={cn('relative min-h-0 flex-1 overflow-y-auto', contentClassName)}>
            {children}
          </div>
        </SidebarInset>
      </SidebarProvider>
      {searchEnabled && (
        <ConsoleSearch
          config={shell.search}
          commands={commands}
          open={searchOpen}
          onOpenChange={setSearchOpen}
          {...(searchPlaceholder ? { placeholder: searchPlaceholder } : {})}
        />
      )}
    </TooltipProvider>
  );
}

/** Page body padding + max width, matching the authkit reference layout. */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-4 px-4 pt-5 pb-16 md:px-6 md:pt-6', className)}>
      {children}
    </div>
  );
}
