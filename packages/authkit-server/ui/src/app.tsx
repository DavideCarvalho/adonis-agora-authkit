import React, { Suspense } from 'react';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { useRouter } from './lib/router';
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

const PAGE_TITLES: Record<string, string> = {
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

function PageContent() {
  const { route } = useRouter();

  switch (route) {
    case 'overview':
      return <Overview />;
    case 'users':
      return <Users />;
    case 'sessions':
      return <Sessions />;
    case 'clients':
      return <Clients />;
    case 'roles':
      return <Roles />;
    case 'orgs':
      return <Orgs />;
    case 'audit':
      return <Audit />;
    case 'keys':
      return <Keys />;
    case 'agents':
      return <PersonalAgents />;
    case 'settings':
      return <Settings />;
    default:
      return <Overview />;
  }
}

export function App() {
  const { route } = useRouter();

  return (
    <div className="app-shell">
      <Sidebar />
      <main className="main">
        <Topbar title={PAGE_TITLES[route] ?? 'AuthKit Admin'} />
        <div className="content">
          <Suspense
            fallback={
              <div className="loading-row">
                <div className="spinner lg" />
              </div>
            }
          >
            <PageContent />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
