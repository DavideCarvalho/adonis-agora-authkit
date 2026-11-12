import { getBootedApp } from '../../services/booted_app.js';
import {
  type ConsoleAuthorize,
  type ConsoleAuthorizeDecision,
  resolveConsoleAuthorize,
} from '../console_authorize.js';

/**
 * Whether the app runs in production. Unknown (the provider did not register the
 * app) counts as production, so an omitted `admin.authorize` fails closed.
 */
export function appInProduction(): boolean {
  try {
    return getBootedApp().inProduction !== false;
  } catch {
    return true;
  }
}

/** One checker per configured `admin.authorize`, so a lazy import runs once. */
const adminAuthorizeCheckers = new WeakMap<
  object,
  (ctx: any) => Promise<ConsoleAuthorizeDecision>
>();

/** The resolved `admin.authorize` checker (memoized per configured value). Never throws. */
export function adminAuthorizeChecker(
  authorize: ConsoleAuthorize,
): (ctx: any) => Promise<ConsoleAuthorizeDecision> {
  let checker = adminAuthorizeCheckers.get(authorize);
  if (!checker) {
    checker = resolveConsoleAuthorize(authorize);
    adminAuthorizeCheckers.set(authorize, checker);
  }
  return checker;
}
