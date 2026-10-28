export interface AuthKitConfig {
  adminBase: string;
  csrfToken: string | null;
  locale: string;
  messages: Record<string, string>;
  currentUser: { id: string; email: string; roles: string[] } | null;
  endpoints: { api: string; confirm?: string };
  features?: { personalAgents?: boolean; rolesManagedExternally?: boolean };
}

declare global {
  interface Window {
    __AUTHKIT__: AuthKitConfig;
  }
}

export function getConfig(): AuthKitConfig {
  if (typeof window === 'undefined' || !window.__AUTHKIT__) {
    // Dev fallback
    return {
      adminBase: '/admin',
      csrfToken: null,
      locale: 'en',
      messages: {},
      currentUser: { id: 'dev', email: 'dev@example.com', roles: ['ADMIN'] },
      endpoints: { api: '/admin/api' },
    };
  }
  return window.__AUTHKIT__;
}

export function t(key: string, fallback?: string): string {
  const cfg = getConfig();
  return cfg.messages[key] ?? fallback ?? key;
}
