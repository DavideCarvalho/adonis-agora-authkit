import { createLocalJWKSet, type JWTPayload, errors as joseErrors, jwtVerify } from 'jose';
import { getBootedApp } from '../../services/booted_app.js';
import type { ResolvedServiceTenantsConfig } from './config.js';

/**
 * What a verified tenant token authenticates as. The same shape as authkit-client's
 * `VerifiedTenantToken`, so the in-process and the remote verifier are interchangeable in any
 * Agora control plane's `verifyTenant`. Everything comes from the token, never the request.
 */
export interface VerifiedTenantToken {
  /** The `partition` claim: the app this tenant is. */
  partition: string;
  /** The `environment` claim, when the token has one. */
  environment?: string;
  /** The `capabilities` claim (product-defined). `[]` when absent. */
  capabilities: string[];
  /** The `client_id` of the service-tenant client. */
  clientId: string;
  /** Epoch ms at which the token expires. */
  expiresAt: number;
}

/** What a control plane hands to its tenant verifier. Only `token` is trusted, once verified. */
export interface TenantVerifierRequest {
  /** The token the tenant presented. */
  token?: string | undefined;
  /** The partition the request claims to be. Advisory only: the token decides. */
  partition?: string | undefined;
  /** Same as `partition` (the wire name some libs use). Advisory only. */
  tenant?: string | undefined;
}

/** The issuer the verifier checks against: the local authkit server. */
export interface TenantTokenIssuer {
  readonly publicJwks: { keys: Record<string, any>[] };
  readonly config: { issuer: string; serviceTenants?: ResolvedServiceTenantsConfig };
}

export interface AuthkitTenantVerifierOptions {
  /**
   * Expected `aud`. Default: the audience of the only resource in
   * `serviceTenants.resources` (required when several are declared).
   */
  audience?: string;
  /** Claim holding the partition. Default: `'partition'`. */
  partitionClaim?: string;
  /** Claim holding the capabilities. Default: `'capabilities'`. */
  capabilitiesClaim?: string;
  /** Allowed clock skew in seconds for `exp`/`nbf`/`iat`. Default: 30. */
  clockToleranceSec?: number;
  /**
   * The environment this control plane serves. Only tokens whose `environment` claim is
   * exactly this value are accepted (a token without the claim is rejected). Same rule as
   * authkit-client's `authkitTenantVerifier`.
   */
  environment?: string;
  /**
   * Where the issuer comes from. Default: the `authkit.server` binding of the booted
   * app. Read on every call, so a signing-key rotation applies right away.
   */
  issuer?: () => TenantTokenIssuer | Promise<TenantTokenIssuer>;
}

/** Asymmetric JWS algorithms only: never `none`, never `HS*`. */
const ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
  'Ed25519',
];

const defaultIssuer = async (): Promise<TenantTokenIssuer> =>
  (await getBootedApp().container.make('authkit.server')) as unknown as TenantTokenIssuer;

function audienceFor(issuer: TenantTokenIssuer, explicit: string | undefined): string {
  if (explicit) return explicit;
  const resources = Object.values(issuer.config.serviceTenants?.resources ?? {});
  if (resources.length === 1) return resources[0].audience;
  throw new Error(
    resources.length === 0
      ? 'authkitTenantVerifier: no serviceTenants.resources declared in config/authkit.ts'
      : 'authkitTenantVerifier: several serviceTenants.resources are declared; pass { audience }',
  );
}

/**
 * Verifies service-tenant tokens against the local authkit issuer and its JWKS (no
 * network call), and returns the tenant they authenticate as, or `null`.
 *
 * Usable as a class in any Agora control plane's `verifyTenant` (built by the container with
 * the default options) or through {@link authkitTenantVerifier}.
 */
export class AuthkitTenantVerifier {
  #options: AuthkitTenantVerifierOptions;
  #jwks: { keys: Record<string, any>[] } | undefined;
  #keySet: ReturnType<typeof createLocalJWKSet> | undefined;

  constructor(options: AuthkitTenantVerifierOptions = {}) {
    this.#options = options;
  }

  #keySetFor(jwks: { keys: Record<string, any>[] }) {
    // `publicJwks` is a new object whenever the keys change (rotation/reload).
    if (jwks !== this.#jwks || !this.#keySet) {
      this.#jwks = jwks;
      this.#keySet = createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0]);
    }
    return this.#keySet;
  }

  async verify(request: TenantVerifierRequest): Promise<VerifiedTenantToken | null> {
    const token = request?.token;
    if (typeof token !== 'string' || !token) return null;
    const issuer = await (this.#options.issuer ?? defaultIssuer)();
    const audience = audienceFor(issuer, this.#options.audience);

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.#keySetFor(issuer.publicJwks), {
        issuer: issuer.config.issuer,
        audience,
        algorithms: ALGORITHMS,
        typ: 'at+jwt',
        clockTolerance: this.#options.clockToleranceSec ?? 30,
        requiredClaims: ['exp', 'sub'],
      }));
    } catch (error) {
      if (error instanceof joseErrors.JOSEError) return null;
      throw error;
    }

    // A client_credentials token: no user behind it, `sub` is the client.
    const clientId = (payload as { client_id?: unknown }).client_id;
    if (typeof clientId !== 'string' || payload.sub !== clientId) return null;

    const partition = (payload as Record<string, unknown>)[
      this.#options.partitionClaim ?? 'partition'
    ];
    if (typeof partition !== 'string' || !partition) return null;

    const environment = (payload as Record<string, unknown>).environment;
    if (environment !== undefined && (typeof environment !== 'string' || !environment)) {
      return null;
    }
    // Pinned: fail closed, a token without the claim is not "this environment".
    if (this.#options.environment && environment !== this.#options.environment) return null;

    const rawCapabilities = (payload as Record<string, unknown>)[
      this.#options.capabilitiesClaim ?? 'capabilities'
    ];
    if (
      rawCapabilities !== undefined &&
      (!Array.isArray(rawCapabilities) || rawCapabilities.some((c) => typeof c !== 'string'))
    ) {
      return null;
    }
    return {
      partition,
      ...(environment ? { environment: environment as string } : {}),
      capabilities: (rawCapabilities as string[] | undefined) ?? [],
      clientId,
      expiresAt: (payload.exp as number) * 1000,
    };
  }
}

/** A tenant verifier usable both as a function and as an object with `verify`. */
export type AuthkitTenantVerifierFn = ((
  request: TenantVerifierRequest,
) => Promise<VerifiedTenantToken | null>) & {
  verify(request: TenantVerifierRequest): Promise<VerifiedTenantToken | null>;
};

/**
 * Tenant verifier for a control plane that runs in the authkit app itself (no discovery, no
 * network call). On any other server use authkit-client's `authkitTenantVerifier`; both
 * return the same `{ partition, environment?, capabilities, clientId, expiresAt }`.
 *
 * ```ts
 * // config/durable.ts
 * verifyTenant: authkitTenantVerifier({ audience: 'urn:agora:durable' })
 * ```
 *
 * The result is a function that also has `verify` (the class form).
 */
export function authkitTenantVerifier(
  options: AuthkitTenantVerifierOptions = {},
): AuthkitTenantVerifierFn {
  const verifier = new AuthkitTenantVerifier(options);
  const verify = (request: TenantVerifierRequest) => verifier.verify(request);
  return Object.assign(verify, { verify });
}
