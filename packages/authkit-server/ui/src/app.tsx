import { Suspense, useMemo } from 'react';
import { ErrorBoundary } from './agora-kit/blocks/error-boundary';
import { AppShell, type NavSection } from './agora-kit/shell/app-shell';
import { readShellConfig } from './agora-kit/shell-config';
import {
  AgentsIcon,
  AuditIcon,
  AuthkitMark,
  ClientsIcon,
  KeysIcon,
  OrgsIcon,
  OverviewIcon,
  RolesIcon,
  SessionsIcon,
  SettingsIcon,
  UsersIcon,
} from './components/nav-icons';
import { PageSkeleton } from './components/Skeleton';
import { CONFIG_ELEMENT_ID, getConfig } from './lib/config';
import { type Route, useRouter } from './lib/router';
import { Audit } from './pages/Audit';
import { Clients } from './pages/Clients';
import { Keys } from './pages/Keys';
import { Orgs } from './pages/Orgs';
import { Overview } from './pages/Overview';
import { PersonalAgents } from './pages/PersonalAgents';
import { Roles } from './pages/Roles';
import { Sessions } from './pages/Sessions';
import { Settings } from './pages/Settings';
import { Users } from './pages/Users';

/** authkit's one accent (CONSOLE-SHELL-SPEC): indigo. */
export const AUTHKIT_ACCENT = '#625fff';

const PAGE_TITLES: Record<Route, string> = {
  overview: 'Overview',
  users: 'Users',
  sessions: 'Sessions',
  clients: 'OAuth Clients',
  roles: 'Roles',
  orgs: 'Organizations',
  audit: 'Audit Log',
  keys: 'Signing Keys',
  agents: 'Personal Agents',
  settings: 'Settings',
};

const PAGES: Record<Route, () => React.JSX.Element> = {
  overview: Overview,
  users: Users,
  sessions: Sessions,
  clients: Clients,
  roles: Roles,
  orgs: Orgs,
  audit: Audit,
  keys: Keys,
  agents: PersonalAgents,
  settings: Settings,
};

interface NavEntry {
  id: Route;
  label: string;
  icon: React.ReactNode;
}

/** MONITOR · IDENTITY · OAUTH2 · AGENTS (only with `personalAgents`) · CONFIG. */
const NAV: Array<{ section: string; feature?: 'personalAgents'; items: NavEntry[] }> = [
  {
    section: 'Monitor',
    items: [
      { id: 'overview', label: 'Overview', icon: <OverviewIcon /> },
      { id: 'audit', label: 'Audit Log', icon: <AuditIcon /> },
    ],
  },
  {
    section: 'Identity',
    items: [
      { id: 'users', label: 'Users', icon: <UsersIcon /> },
      { id: 'sessions', label: 'Sessions', icon: <SessionsIcon /> },
      { id: 'roles', label: 'Roles', icon: <RolesIcon /> },
      { id: 'orgs', label: 'Organizations', icon: <OrgsIcon /> },
    ],
  },
  {
    section: 'OAuth2',
    items: [{ id: 'clients', label: 'Clients', icon: <ClientsIcon /> }],
  },
  {
    section: 'Agents',
    feature: 'personalAgents',
    items: [{ id: 'agents', label: 'Personal Agents', icon: <AgentsIcon /> }],
  },
  {
    section: 'Config',
    items: [
      { id: 'keys', label: 'Signing Keys', icon: <KeysIcon /> },
      { id: 'settings', label: 'Settings', icon: <SettingsIcon /> },
    ],
  },
];

export function App() {
  const { route, navigate } = useRouter();
  const config = getConfig();
  const shell = useMemo(() => readShellConfig(CONFIG_ELEMENT_ID), []);

  const nav: NavSection[] = NAV.filter((s) => !s.feature || config.features?.[s.feature]).map(
    (s) => ({
      section: s.section,
      items: s.items.map((item) => ({
        ...item,
        href: item.id === 'overview' ? '?' : `?view=${item.id}`,
        onSelect: () => navigate(item.id),
      })),
    }),
  );

  const Page = PAGES[route] ?? Overview;

  return (
    <AppShell
      brand={{
        name: (
          <>
            Auth<span className="text-brand">Kit</span>
          </>
        ),
        subtitle: 'Admin Console',
        mark: <AuthkitMark />,
        current: { title: 'Identity', package: '@adonis-agora/authkit-server', icon: 'identity' },
      }}
      nav={nav}
      activeId={route}
      shell={shell}
      title={PAGE_TITLES[route] ?? 'AuthKit Admin'}
      searchPlaceholder="Search users, organizations…"
    >
      <ErrorBoundary label={PAGE_TITLES[route]} resetKeys={[route]} className="m-6">
        <Suspense fallback={<PageSkeleton />}>
          <Page />
        </Suspense>
      </ErrorBoundary>
    </AppShell>
  );
}
