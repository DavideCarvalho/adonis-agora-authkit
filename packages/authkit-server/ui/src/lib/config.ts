export interface AuthKitConfig {
  adminBase: string;
  csrfToken: string | null;
  locale: string;
  messages: Record<string, string>;
  currentUser: { id: string; email: string; roles: string[] } | null;
  endpoints: { api: string; confirm?: string };
  features?: { personalAgents?: boolean; rolesManagedExternally?: boolean };
}

/** Id of the JSON data block the server embeds (see `admin_shell_controller.ts`). */
const CONFIG_ELEMENT_ID = 'authkit-admin-config';

let cached: AuthKitConfig | undefined;

/**
 * The console config, read once from the `<script type="application/json">`
 * data block the server embeds in the shell. A data block is never executed,
 * so a strict CSP cannot drop it. Without it the console cannot work (no API
 * base, no CSRF token, no user), so this throws instead of guessing.
 */
export function getConfig(): AuthKitConfig {
  if (cached) return cached;
  const element = document.getElementById(CONFIG_ELEMENT_ID);
  if (!element?.textContent) {
    throw new Error(
      `AuthKit admin: the #${CONFIG_ELEMENT_ID} config block is missing. Open the console through the server route.`,
    );
  }
  cached = JSON.parse(element.textContent) as AuthKitConfig;
  return cached;
}

export function t(key: string, fallback?: string): string {
  const cfg = getConfig();
  return cfg.messages[key] ?? fallback ?? key;
}
