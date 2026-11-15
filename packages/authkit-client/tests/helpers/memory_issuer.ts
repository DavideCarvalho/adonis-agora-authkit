import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';

/**
 * A minimal OIDC issuer on a random local port: a discovery document (with a token
 * endpoint at a NON-conventional path, so a guessed `/token` would miss), a JWKS, and a
 * `sign()` helper for access tokens. `tokenResponse` answers the token endpoint.
 */
export interface MemoryIssuer {
  issuer: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** Signs a JWT with the issuer's key. Defaults: `typ: at+jwt`, `iss`, `iat`, `exp` = +600s. */
  sign(claims: JWTPayload, options?: { typ?: string; key?: 'issuer' | 'foreign' }): Promise<string>;
  /** Requests the token endpoint received. */
  tokenRequests: Array<{ authorization: string | undefined; body: URLSearchParams }>;
  tokenResponse: (
    body: URLSearchParams,
    authorization: string | undefined,
  ) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
  /** Answer discovery with this status instead of the document. */
  discoveryStatus?: number;
  close(): Promise<void>;
}

export async function startMemoryIssuer(): Promise<MemoryIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

  let state!: MemoryIssuer;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', state.issuer);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      if (state.discoveryStatus) return send(state.discoveryStatus, { error: 'down' });
      return send(200, {
        issuer: state.issuer,
        authorization_endpoint: `${state.issuer}/oauth2/v9/authorize`,
        token_endpoint: state.tokenEndpoint,
        jwks_uri: state.jwksUri,
      });
    }
    if (url.pathname === '/oauth2/v9/keys') return send(200, { keys: [jwk] });
    if (url.pathname === '/oauth2/v9/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', async () => {
        const body = new URLSearchParams(raw);
        state.tokenRequests.push({ authorization: req.headers.authorization, body });
        const answer = await state.tokenResponse(body, req.headers.authorization);
        send(answer.status, answer.body);
      });
      return;
    }
    send(404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  state = {
    issuer,
    tokenEndpoint: `${issuer}/oauth2/v9/token`,
    jwksUri: `${issuer}/oauth2/v9/keys`,
    tokenRequests: [],
    tokenResponse: () => ({ status: 500, body: { error: 'server_error' } }),
    async sign(claims, options = {}) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ iat: now, exp: now + 600, iss: issuer, ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: options.typ ?? 'at+jwt' })
        .sign(options.key === 'foreign' ? foreign.privateKey : privateKey);
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
  return state;
}
