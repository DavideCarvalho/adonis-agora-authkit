import './container_bindings.js';
import type { AuthkitClientManager } from './providers/authkit_client_provider.js';
import type { Authenticator } from './src/authenticator.js';

/**
 * OPT-IN typing for `ctx.auth`.
 *
 * Reference this module from your app when you want `ctx.auth` typed as
 * AuthKit's `Authenticator` and you are NOT declaring the property yourself:
 *
 * ```ts
 * // any file in your app, e.g. app/types.ts
 * import '@adonis-agora/authkit-client/types'
 * ```
 *
 * NOTHING in this package imports this module on your behalf, and that is the
 * point. `Authenticator` is generic (`Authenticator<TUser>`), and most apps
 * declare their own augmentation so `auth.getUser()` returns their user model:
 *
 * ```ts
 * declare module '@adonisjs/core/http' {
 *   interface HttpContext {
 *     auth: Authenticator<AppUser>
 *   }
 * }
 * ```
 *
 * Two declarations of the same property with different types do not merge —
 * they conflict, and because `skipLibCheck` is on in every AdonisJS app the
 * conflict is never reported: one simply wins by include order. When the
 * library's won, `auth.getUser()` collapsed to `unknown` across the whole app.
 * So the library ships the declaration and lets you decide whether to load it,
 * rather than forcing it through a middleware import.
 *
 * The container bindings come along with it (see `container_bindings.ts`); they
 * are also available on their own, which is what the provider and the middleware
 * use.
 */
declare module '@adonisjs/core/http' {
  interface HttpContext {
    auth: Authenticator;
  }
}

export type { Authenticator, AuthkitClientManager };
