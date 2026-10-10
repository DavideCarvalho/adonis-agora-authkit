import { SignJWT } from 'jose';
import { importSigningKey, type StoredKey } from './keys.js';
import type { ClientMetadata } from './types.js';
import { nowSeconds, randomId, requireSecureUrl, type SecurityOptions } from './util.js';

export interface IdentityConfig {
  /** Where the identity documents are served, e.g. `https://agent.example`. */
  baseUrl: string;
  clientName: string;
  /** Defaults to `{baseUrl}/logo.svg`, which `serve-identity` serves. */
  logoUri?: string;
  /** Signing keys; the first one signs. Public halves go in `jwks_uri`. */
  keys: StoredKey[];
  /** Extensions this agent supports (3.3). None by default. */
  extensions?: Record<string, { version: string }>;
}

/** Lifetime of every assertion this agent signs. The browser assertion caps at 60s (section 5). */
export const ASSERTION_TTL_SECONDS = 60;

/**
 * The Personal Agent's identity (4.1): its `client_id` URL, its metadata document, and the
 * keys from `jwks_uri` that sign client assertions, Session assertions and browser assertions.
 */
export class AgentIdentity {
  readonly baseUrl: string;
  readonly clientName: string;
  readonly logoUri: string;
  readonly keys: StoredKey[];
  readonly extensions?: Record<string, { version: string }>;

  constructor(cfg: IdentityConfig, sec: SecurityOptions = {}) {
    const base = requireSecureUrl(cfg.baseUrl, 'identity base URL', sec);
    if (base.search || base.hash) throw new TypeError('identity base URL must not have a query');
    this.baseUrl = base.toString().replace(/\/+$/, '');
    this.clientName = cfg.clientName;
    this.logoUri = cfg.logoUri ?? `${this.baseUrl}/logo.svg`;
    if (cfg.keys.length === 0) throw new TypeError('identity needs at least one signing key');
    this.keys = cfg.keys;
    this.extensions = cfg.extensions;
  }

  /** `client_id` is the URL the metadata document is fetched from (4.1). */
  get clientId(): string {
    return `${this.baseUrl}/agent.json`;
  }

  get jwksUri(): string {
    return `${this.baseUrl}/jwks.json`;
  }

  /** Same origin as `client_id`, as 4.1 requires for `redirect_uris`. */
  get redirectUri(): string {
    return `${this.baseUrl}/oauth/callback`;
  }

  metadata(): ClientMetadata {
    const doc: ClientMetadata = {
      client_id: this.clientId,
      client_name: this.clientName,
      logo_uri: this.logoUri,
      jwks_uri: this.jwksUri,
      redirect_uris: [this.redirectUri],
      token_endpoint_auth_method: 'private_key_jwt',
    };
    if (this.extensions && Object.keys(this.extensions).length > 0) {
      doc.extensions = this.extensions;
    }
    return doc;
  }

  /** The public key set. Never contains private members. */
  jwks(): { keys: Record<string, unknown>[] } {
    return { keys: this.keys.map((k) => ({ ...k.publicJwk })) };
  }

  private async sign(payload: Record<string, unknown>, typ?: string): Promise<string> {
    const key = this.keys[0];
    const header: { alg: string; kid: string; typ?: string } = { alg: 'ES256', kid: key.kid };
    if (typ) header.typ = typ;
    return new SignJWT(payload).setProtectedHeader(header).sign(await importSigningKey(key));
  }

  /**
   * `private_key_jwt` client assertion (RFC 7523 section 2.2): `iss` = `sub` = `client_id`,
   * `aud` = the authorization server (its token endpoint by default), fresh `jti`.
   */
  clientAssertion(audience: string): Promise<string> {
    const iat = nowSeconds();
    return this.sign({
      iss: this.clientId,
      sub: this.clientId,
      aud: audience,
      iat,
      exp: iat + ASSERTION_TTL_SECONDS,
      jti: randomId(),
    });
  }

  /**
   * The JWT bearer grant assertion that starts or renews a Session (4.2): names the agent in
   * `iss` and the User ID in `sub`; `aud` is the token endpoint as a single string.
   */
  sessionAssertion(userId: string, tokenEndpoint: string): Promise<string> {
    const iat = nowSeconds();
    return this.sign({
      iss: this.clientId,
      sub: userId,
      aud: tokenEndpoint,
      iat,
      exp: iat + ASSERTION_TTL_SECONDS,
      jti: randomId(),
    });
  }

  /** Browser assertion (section 5), header `typ: poppy-browser+jwt`, `exp` <= `iat` + 60. */
  browserAssertion(input: {
    userId: string;
    endpoint: string;
    sessionId: string;
    returnTo: string;
  }): Promise<string> {
    const iat = nowSeconds();
    return this.sign(
      {
        iss: this.clientId,
        sub: input.userId,
        aud: input.endpoint,
        session_id: input.sessionId,
        return_to: input.returnTo,
        iat,
        exp: iat + ASSERTION_TTL_SECONDS,
        jti: randomId(),
      },
      'poppy-browser+jwt',
    );
  }
}
