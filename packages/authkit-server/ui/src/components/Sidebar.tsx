import React from 'react';
import { getConfig } from '../lib/config';
import { type Route, useRouter } from '../lib/router';
import { useTheme } from '../lib/theme';

const navItems = [
  {
    section: 'Monitor',
    items: [
      {
        id: 'overview',
        label: 'Overview',
        icon: (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.5" />
            <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.5" />
            <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.5" />
            <rect x="9" y="9" width="5.5" height="5.5" rx="1.5" />
          </svg>
        ),
      },
      {
        id: 'audit',
        label: 'Audit Log',
        icon: (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M2.5 4h11M2.5 8h7M2.5 12h5" strokeLinecap="round" />
          </svg>
        ),
      },
    ],
  },
  {
    section: 'Identity',
    items: [
      {
        id: 'users',
        label: 'Users',
        icon: (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="8" cy="5.5" r="2.5" />
            <path d="M2 13c0-2.76 2.69-5 6-5s6 2.24 6 5" strokeLinecap="round" />
          </svg>
        ),
      },
      {
        id: 'sessions',
        label: 'Sessions',
        icon: (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
            <path d="M5.5 3.5V2.5M10.5 3.5V2.5" strokeLinecap="round" />
            <circle cx="8" cy="8.5" r="2" />
          </svg>
        ),
      },
      {
        id: 'roles',
        label: 'Roles',
        icon: (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="8" cy="8" r="6.5" />
            <path d="M8 5v3l2 2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ),
      },
      {
        id: 'orgs',
        label: 'Organizations',
        icon: (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="6" y="1.5" width="4" height="4" rx="1" />
            <rect x="1.5" y="10.5" width="4" height="4" rx="1" />
            <rect x="10.5" y="10.5" width="4" height="4" rx="1" />
            <path d="M8 5.5v2.5M8 8H4M8 8h4M4 10.5V8M12 10.5V8" strokeLinecap="round" />
          </svg>
        ),
      },
    ],
  },
  {
    section: 'OAuth2',
    items: [
      {
        id: 'clients',
        label: 'Clients',
        icon: (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M7 2.5H3.5a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1V9" strokeLinecap="round" />
            <path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ),
      },
    ],
  },
  {
    section: 'Agents',
    // Só com `personalAgents` no config (ver `features` no shell).
    feature: 'personalAgents' as const,
    items: [
      {
        id: 'agents',
        label: 'Personal Agents',
        icon: (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="3" y="5" width="10" height="8" rx="2" />
            <path d="M8 2.5V5M6 9h.01M10 9h.01M1.5 9v1.5M14.5 9v1.5" strokeLinecap="round" />
          </svg>
        ),
      },
    ],
  },
  {
    section: 'Config',
    items: [
      {
        id: 'keys',
        label: 'Signing Keys',
        icon: (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="5" cy="8" r="3" />
            <path d="M8 8h6.5M12.5 8v2.5M10.5 8v2" strokeLinecap="round" />
          </svg>
        ),
      },
      {
        id: 'settings',
        label: 'Settings',
        icon: (
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="8" cy="8" r="2" />
            <path
              d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.42 1.42M11.53 11.53l1.42 1.42M3.05 12.95l1.42-1.42M11.53 4.47l1.42-1.42"
              strokeLinecap="round"
            />
          </svg>
        ),
      },
    ],
  },
];

export function Sidebar() {
  const { route, navigate } = useRouter();
  const { theme, toggle } = useTheme();
  const cfg = getConfig();

  const initials = cfg.currentUser?.email?.slice(0, 2).toUpperCase() ?? '?';

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-logo">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="8" cy="8" r="6.5" />
            <path d="M5 8l2.5 2.5L11 5.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div className="ring" />
        </div>
        <div className="brand-text">
          <div className="brand-name">
            Auth<span>Kit</span>
          </div>
          <div className="brand-sub">Admin Console</div>
        </div>
      </div>

      <nav className="nav">
        {navItems
          .filter((section) => !section.feature || cfg.features?.[section.feature])
          .map((section) => (
            <div key={section.section}>
              <div className="nav-section">{section.section}</div>
              {section.items.map((item) => (
                <a
                  key={item.id}
                  className={`nav-item${route === item.id ? ' active' : ''}`}
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(item.id as Route);
                  }}
                  href={item.id === 'overview' ? '?' : `?view=${item.id}`}
                  style={{ textDecoration: 'none' }}
                >
                  <span className="nav-ico">{item.icon}</span>
                  {item.label}
                </a>
              ))}
            </div>
          ))}
      </nav>

      <div className="sidebar-foot">
        <div className="user-row">
          <div className="avatar">{initials}</div>
          <div className="user-info">
            <div className="user-email truncate">{cfg.currentUser?.email ?? '—'}</div>
            <div className="user-role">{cfg.currentUser?.roles?.[0] ?? 'admin'}</div>
          </div>
        </div>
        <div className="foot-actions">
          <button
            className="btn btn-ghost btn-sm flex-center gap-2"
            onClick={toggle}
            title="Toggle theme"
            style={{ flex: 1 }}
          >
            {theme === 'dark' ? (
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
              >
                <circle cx="8" cy="8" r="3.5" />
                <path
                  d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
              >
                <path
                  d="M13.5 9A6 6 0 116.5 2.5a4.5 4.5 0 007 6.5z"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
          {/* Logout de verdade: POST /account/logout (session.forget → /account/login).
              Um <a href="/account/login"> NÃO desloga — como a sessão segue ativa, o
              /account/login redireciona pro accountHome (/account/security) e o usuário
              "desloga" mas continua logado. Por isso é um form POST com CSRF. */}
          <form method="POST" action="/account/logout" style={{ display: 'contents' }}>
            <input type="hidden" name="_csrf" value={getConfig().csrfToken ?? ''} />
            <button type="submit" className="btn btn-ghost btn-sm" title="Sign out">
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
              >
                <path d="M10 11l4-3.5L10 4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M14 7.5H5" strokeLinecap="round" />
                <path d="M6 3H3a1 1 0 00-1 1v7a1 1 0 001 1h3" strokeLinecap="round" />
              </svg>
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
