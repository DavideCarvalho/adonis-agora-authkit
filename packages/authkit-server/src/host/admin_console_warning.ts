/** The boot warning for an admin console with no `admin.authorize`. Same wording in every console. */
export const ADMIN_CONSOLE_NO_AUTHORIZE_WARNING =
  '[@adonis-agora/authkit-server] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/authkit.ts.';

let warned = false;

/** Logs {@link ADMIN_CONSOLE_NO_AUTHORIZE_WARNING} once per process. */
export function warnAdminConsoleUnauthorized(
  logger: { warn: (message: string) => unknown } | null | undefined,
): boolean {
  if (warned) return false;
  warned = true;
  if (logger) logger.warn(ADMIN_CONSOLE_NO_AUTHORIZE_WARNING);
  else console.warn(ADMIN_CONSOLE_NO_AUTHORIZE_WARNING);
  return true;
}

/** Test helper: lets the warning fire again. */
export function resetAdminConsoleWarning(): void {
  warned = false;
}
