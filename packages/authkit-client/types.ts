import './src/host/request_authenticator.js';
import type { AuthkitClientManager } from './providers/authkit_client_provider.js';
import type { Authenticator } from './src/authenticator.js';

/**
 * Types of `@adonis-agora/authkit-client`.
 *
 * Importing this module brings the container bindings (`authkit.client`) and the
 * `ctx.authkit` declaration into your program. `ctx.auth` belongs to
 * `@adonisjs/auth`; use `authkitClientGuard` to back it with the AuthKit session.
 *
 * ```ts
 * // any file in your app, e.g. app/types.ts
 * import '@adonis-agora/authkit-client/types'
 * ```
 */
export type { Authenticator, AuthkitClientManager };
