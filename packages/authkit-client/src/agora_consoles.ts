/**
 * The `'agora.consoles'` registry every `@adonis-agora` console reads (declared
 * structurally, like in every other lib: nothing is imported). authkit-client only
 * writes `account.signOut` into it, so every console on a relying-party app shows a
 * working sign-out with no per-console config.
 */

/** The container binding the registry lives at. */
export const AGORA_CONSOLES_BINDING = 'agora.consoles';

/** Where every console's footer signs the viewer out. */
export type AgoraConsoleSignOut = { action: string; method?: 'POST' } | { href: string };

interface RegistryLike {
  version?: unknown;
  entries?: unknown;
  account?: { signOut?: AgoraConsoleSignOut } & Record<string, unknown>;
}

/** The slice of an AdonisJS application the announcement needs. */
export interface ConsolesAppLike {
  container: {
    hasBinding(binding: string): boolean;
    bindValue(binding: string, value: unknown): void;
    make(binding: string): Promise<unknown>;
  };
}

function isSameOriginPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.startsWith('/') &&
    !path.startsWith('//') &&
    !path.includes('\\') &&
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    !/[\u0000-\u001f\u007f]/.test(path)
  );
}

/**
 * Announces `action` (a same-origin `POST` route, e.g. `/auth/logout`) as
 * `account.signOut` on the `'agora.consoles'` registry. Creates the registry when no
 * console bound it yet. Keeps a sign-out something else announced first (authkit-server
 * in the same app, or the app itself), skips a registry of another version, and never
 * throws on one. Returns `true` when it wrote the announcement.
 */
export async function announceAgoraSignOut(app: ConsolesAppLike, action: string): Promise<boolean> {
  if (!isSameOriginPath(action)) {
    throw new Error(
      `announceAgoraSignOut: sign-out action ${JSON.stringify(action)} must be a same-origin absolute path`,
    );
  }
  const container = app.container;
  if (!container.hasBinding(AGORA_CONSOLES_BINDING)) {
    container.bindValue(AGORA_CONSOLES_BINDING, { version: 1, entries: [] });
  }
  const registry = (await container.make(AGORA_CONSOLES_BINDING)) as RegistryLike | null;
  if (!registry || registry.version !== 1 || !Array.isArray(registry.entries)) return false;
  const account =
    typeof registry.account === 'object' && registry.account !== null ? registry.account : {};
  if (account.signOut !== undefined) return false;
  registry.account = { ...account, signOut: { action, method: 'POST' } };
  return true;
}
