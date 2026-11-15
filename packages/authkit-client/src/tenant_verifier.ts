/**
 * The control-plane half of service-tenant auth: verifies the `client_credentials` JWT
 * a tenant process presents (see `authkitTenantToken`) against the issuer's keys, found
 * by OIDC discovery. Remote-safe: authkit-server does not have to run in this process.
 */

import { type JWTPayload, errors as joseErrors, jwtVerify } from 'jose';
import { type DiscoverOptions, discoverEndpoints } from './discovery.js';
import { DEFAULT_ALGS, getJwks } from './jwks.js';

/** What a control plane hands to its verifier. Only `token` is trusted, once verified. */
export interface TenantVerifierRequest {
  /** The token the tenant presented. */
  token?: string | undefined;
  /** The partition the request claims to be. Advisory only: the token decides. */
  partition?: string | undefined;
  /** Same as `partition` (the wire name some libs use). Advisory only. */
  tenant?: string | undefined;
}

/** What a verified tenant token authenticates as. Everything comes from the token. */
export interface VerifiedTenantToken {
  /** The `partition` claim: the app this tenant is. */
  partition: string;
  /** The `environment` claim, when the token has one. */
  environment?: string;
  /** The `capabilities` claim (product-defined, e.g. `flags:ruleset:read`). `[]` when absent. */
  capabilities: string[];
  /** The `client_id` of the service-tenant client. */
  clientId: string;
  /** Epoch ms at which the token expires. */
  expiresAt: number;
}

/** The function form every Agora control plane accepts as `verifyTenant`. */
export type TenantVerifier = (
  request: TenantVerifierRequest,
) => Promise<VerifiedTenantToken | null>;

export interface AuthkitTenantVerifierOptions {
  /** Issuer URL of the authkit server (the `iss` of its tokens). */
  issuer: string;
  /**
   * The resource this control plane answers for, e.g. `'urn:agora:flags'`. The token's
   * `aud` must contain it.
   */
  resource: string;
  /**
   * The environment this control plane serves. Only tokens whose `environment` claim is
   * exactly this value are accepted (a token without the claim is rejected). Without it,
   * any environment is accepted and returned as claimed.
   */
  environment?: string;
  /** Expected `aud` when the server declares a different `audience` for the resource. Default: `resource`. */
  audience?: string;
  /** Allowed clock skew in seconds for `exp`/`nbf`/`iat`. Default: 30. */
  clockToleranceSec?: number;
  /** Discovery options (custom `fetchImpl`, cache TTL, resilience policy). */
  discovery?: Pick<DiscoverOptions, 'fetchImpl' | 'cacheTtlMs' | 'resilience' | 'overrides'>;
}

/** A tenant verifier usable both as a function and as an object with `verify`. */
export type AuthkitTenantVerifierFn = TenantVerifier & {
  verify(request: TenantVerifierRequest): Promise<VerifiedTenantToken | null>;
};

function stringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return null;
  return value as string[];
}

/**
 * Verifies service-tenant tokens issued by an authkit server, on any server:
 *
 * - finds `jwks_uri` and the exact `issuer` through `{issuer}/.well-known/openid-configuration`
 *   (cached; never a guessed path);
 * - checks the signature (asymmetric algorithms only), `iss`, `aud` (= `resource`),
 *   `typ: at+jwt`, `exp`, and that `sub` is the client (a `client_credentials` token);
 * - reads `partition`, `capabilities` and `environment` from the token, never from the request.
 *
 * Returns `null` for a token that does not verify; throws when the issuer cannot be
 * discovered (the request fails instead of being silently refused).
 */
export class AuthkitTenantVerifier {
  #options: AuthkitTenantVerifierOptions;

  constructor(options: AuthkitTenantVerifierOptions) {
    if (!options?.issuer || !options.resource) {
      throw new TypeError('authkitTenantVerifier: issuer and resource are required');
    }
    this.#options = options;
  }

  async verify(request: TenantVerifierRequest): Promise<VerifiedTenantToken | null> {
    const token = request?.token;
    if (typeof token !== 'string' || !token) return null;
    const o = this.#options;
    const endpoints = await discoverEndpoints(o.issuer, { ...o.discovery, onError: 'throw' });

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, getJwks(endpoints.jwksUri), {
        issuer: endpoints.issuer,
        audience: o.audience ?? o.resource,
        algorithms: DEFAULT_ALGS,
        typ: 'at+jwt',
        clockTolerance: o.clockToleranceSec ?? 30,
        requiredClaims: ['exp', 'sub'],
      }));
    } catch (error) {
      if (error instanceof joseErrors.JOSEError) return null;
      throw error;
    }

    const claims = payload as Record<string, unknown>;
    // A client_credentials token: no user behind it, `sub` is the client.
    const clientId = claims.client_id;
    if (typeof clientId !== 'string' || payload.sub !== clientId) return null;

    const partition = claims.partition;
    if (typeof partition !== 'string' || !partition) return null;

    const capabilities = stringArray(claims.capabilities);
    if (capabilities === null) return null;

    const claimed = claims.environment;
    if (claimed !== undefined && (typeof claimed !== 'string' || !claimed)) return null;
    // Pinned: fail closed, a token without the claim is not "this environment".
    if (o.environment && claimed !== o.environment) return null;
    const environment = claimed as string | undefined;

    return {
      partition,
      ...(environment ? { environment } : {}),
      capabilities,
      clientId,
      expiresAt: (payload.exp as number) * 1000,
    };
  }
}

/**
 * The `verifyTenant` of a control plane, wherever authkit runs:
 *
 * ```ts
 * // config/flags.ts (control plane)
 * import { authkitTenantVerifier } from '@adonis-agora/authkit-client'
 *
 * verifyTenant: authkitTenantVerifier({
 *   issuer: env.get('AUTHKIT_ISSUER'),
 *   resource: 'urn:agora:flags',
 * })
 * ```
 *
 * The result is a function that also has `verify` (the class form).
 */
export function authkitTenantVerifier(
  options: AuthkitTenantVerifierOptions,
): AuthkitTenantVerifierFn {
  const verifier = new AuthkitTenantVerifier(options);
  const verify = (request: TenantVerifierRequest) => verifier.verify(request);
  return Object.assign(verify, { verify });
}
