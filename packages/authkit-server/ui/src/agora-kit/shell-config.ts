/**
 * The shell fields every Agora console's JSON data block may carry (`<script type="application/json"
 * id="<console>-config">`), read and validated. Absent or malformed fields read as absent: the shell
 * then hides that piece (no switcher, no ⌘K, no user row, no sign-out). No React, no fetch.
 *
 *   switcher?: { endpoint: string; others: number }       // GET → { consoles: [...] }
 *   search?:   { endpoint: string }                       // GET ?q= → { results|groups: [...] }
 *   viewer?:   { label: string; email?: string; role?: string }
 *   signOut?:  { action: string; csrfToken?: string } | { href: string }
 */

export interface SwitcherConfig {
  endpoint: string;
  others: number;
}

export interface SearchConfig {
  endpoint: string;
}

export interface Viewer {
  label: string;
  email?: string;
  role?: string;
}

export type SignOut = { action: string; csrfToken?: string } | { href: string };

export interface AgoraShellConfig {
  switcher?: SwitcherConfig;
  search?: SearchConfig;
  viewer?: Viewer;
  signOut?: SignOut;
}

/** Only same-origin absolute paths are followed: `/x`, never `//host`, a scheme, a backslash or a
 *  control character. */
export function isSafeHref(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Validate the shell fields of an already-parsed data block. */
export function parseShellConfig(raw: unknown): AgoraShellConfig {
  const block = record(raw) ?? {};
  const out: AgoraShellConfig = {};

  const switcher = record(block.switcher);
  if (
    switcher &&
    isSafeHref(switcher.endpoint) &&
    typeof switcher.others === 'number' &&
    switcher.others > 0
  ) {
    out.switcher = { endpoint: switcher.endpoint, others: switcher.others };
  }

  const search = record(block.search);
  if (search && isSafeHref(search.endpoint)) out.search = { endpoint: search.endpoint };
  // Consoles that predate the `search` field serve it at `<switcher endpoint>/search`.
  else if (out.switcher) out.search = { endpoint: `${out.switcher.endpoint}/search` };

  const viewer = record(block.viewer);
  const label = text(viewer?.label);
  if (viewer && label) {
    const email = text(viewer.email);
    const role = text(viewer.role);
    out.viewer = { label, ...(email ? { email } : {}), ...(role ? { role } : {}) };
  }

  const signOut = record(block.signOut);
  if (signOut && isSafeHref(signOut.action)) {
    const csrfToken = text(signOut.csrfToken);
    out.signOut = { action: signOut.action, ...(csrfToken ? { csrfToken } : {}) };
  } else if (signOut && isSafeHref(signOut.href)) {
    out.signOut = { href: signOut.href };
  }
  return out;
}

/** Read the shell fields from the data block `elementId` (`{}` when absent or unreadable). */
export function readShellConfig(elementId: string): AgoraShellConfig {
  if (typeof document === 'undefined') return {};
  const element = document.getElementById(elementId);
  if (element === null) return {};
  try {
    return parseShellConfig(JSON.parse(element.textContent ?? ''));
  } catch {
    return {};
  }
}
