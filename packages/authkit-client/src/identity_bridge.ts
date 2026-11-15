/**
 * Puts an identity verified somewhere else (an MCP bearer token, a remote JWT) on the
 * request the way a browser session would, so `ctx.authkit` / `getAuthkit(ctx)` and an
 * `authkitClientGuard` default guard see it. A console gated by `authkitDashboardAuthorize`
 * then accepts the caller.
 */

import type { Identity } from '@adonis-agora/authkit-core';
import type { HttpContext } from '@adonisjs/core/http';
import { Authenticator } from './authenticator.js';
import { type DiscoverOptions, discoverEndpoints } from './discovery.js';
import { buildIdentityFromClaims } from './resolvers/identity.js';
import { verifyJwtAccessToken } from './verify_access_token.js';

export interface AuthkitAccessTokenIdentityOptions {
  /** Issuer URL of the authkit server. Its `jwks_uri` comes from discovery. */
  issuer: string;
  /** The `aud` the token must carry (the resource URL of the endpoint that received it). */
  audience: string | string[];
  /** Claim holding the global roles. Default: `'roles'`. */
  globalRolesClaim?: string;
  /** Accept a token without `typ: at+jwt`. Default: `false`. */
  allowAnyTyp?: boolean;
  /** Discovery options (custom `fetchImpl`, cache TTL, resilience policy). */
  discovery?: Pick<DiscoverOptions, 'fetchImpl' | 'cacheTtlMs' | 'resilience' | 'overrides'>;
}

/**
 * Verifies an authkit JWT access token (RFC 9068) against the issuer's discovered JWKS and
 * maps it to an {@link Identity} (`userId`, `email`, `globalRoles`, org, `actor`). `null`
 * for an invalid token or a `client_credentials` token (no user behind it). Throws when the
 * issuer cannot be discovered.
 */
export async function identityFromAccessToken(
  token: string,
  options: AuthkitAccessTokenIdentityOptions,
): Promise<Identity | null> {
  if (typeof token !== 'string' || !token) return null;
  const endpoints = await discoverEndpoints(options.issuer, {
    ...options.discovery,
    onError: 'throw',
  });
  let claims: Record<string, unknown>;
  try {
    claims = (await verifyJwtAccessToken(token, {
      issuer: endpoints.issuer,
      jwksUri: endpoints.jwksUri,
      audience: options.audience,
      ...(options.allowAnyTyp ? { allowAnyTyp: true } : {}),
    })) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof claims.sub !== 'string' || !claims.sub) return null;
  // A client_credentials token authenticates a client, never a user.
  if (typeof claims.client_id === 'string' && claims.sub === claims.client_id) return null;
  return buildIdentityFromClaims(claims, options.globalRolesClaim ?? 'roles');
}

interface ManagerLike {
  createAuthenticator(
    ctx: HttpContext,
    options: { resolver: { resolver(rc: unknown): Promise<{ resolve(): Promise<unknown> }> } },
  ): Promise<unknown>;
}

interface AdonisAuthLike {
  use(guard?: string): {
    driverName?: string;
    isAuthenticated?: boolean;
    authenticationAttempted?: boolean;
  };
  check(): Promise<boolean>;
}

/**
 * Binds `identity` to the request:
 *
 * 1. `ctx.authkit` becomes an `Authenticator` resolving to it, built by this app's authkit
 *    client when there is one (so `resolveUser`, e.g. `lucidMirror`, gives `getUser()` the
 *    app's user, and the tenant reaches `@adonis-agora/context`), else a plain one.
 * 2. When `ctx.auth`'s default guard is `authkitClientGuard`, it is authenticated from it,
 *    so `ctx.auth.user` sees the account too.
 *
 * Best effort past step 1.
 */
export async function bindAuthkitIdentity(ctx: HttpContext, identity: Identity): Promise<void> {
  const resolver = { resolve: async () => identity };
  let authenticator: unknown;
  try {
    const container = (ctx as unknown as { containerResolver?: any }).containerResolver;
    const manager = (await container?.make?.('authkit.client')) as ManagerLike | undefined;
    if (manager && typeof manager.createAuthenticator === 'function') {
      authenticator = await manager.createAuthenticator(ctx, {
        resolver: { resolver: async () => resolver },
      });
    }
  } catch {
    authenticator = undefined;
  }
  (ctx as unknown as { authkit?: unknown }).authkit =
    authenticator ?? new Authenticator(ctx, { resolver });

  const auth = (ctx as unknown as { auth?: AdonisAuthLike }).auth;
  if (auth === undefined || typeof auth.use !== 'function') return;
  try {
    const guard = auth.use();
    if (guard?.driverName !== 'authkit_client' || guard.isAuthenticated === true) return;
    // A silent-auth middleware may already have tried (and found no browser session).
    guard.authenticationAttempted = false;
    await auth.check();
  } catch {
    // leave ctx.auth alone
  }
}

/**
 * {@link identityFromAccessToken} then {@link bindAuthkitIdentity}: the one call an MCP or
 * API endpoint makes after reading a bearer token issued by a remote authkit. Returns the
 * identity, or `null` (nothing bound) when the token does not verify.
 */
export async function bridgeAuthkitToken(
  ctx: HttpContext,
  token: string,
  options: AuthkitAccessTokenIdentityOptions,
): Promise<Identity | null> {
  const identity = await identityFromAccessToken(token, options);
  if (identity) await bindAuthkitIdentity(ctx, identity);
  return identity;
}
