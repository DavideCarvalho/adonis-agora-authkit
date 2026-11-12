import {
  ACCOUNT_EXTENSIONS_MANIFEST_SUBJECT,
  ACCOUNT_EXTENSIONS_SCOPE,
  ACCOUNT_EXTENSIONS_TOKEN_MAX_TTL,
  ACCOUNT_EXTENSIONS_TOKEN_TYP,
  type AccountExtension,
  accountExtensionsBodyHash,
  BaseAccountExtensionRegistry,
  buildAccountExtensionsManifest,
  parseAccountExtensionCall,
  runAccountExtensionCall,
} from '@adonis-agora/authkit-core';
import { type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';
import type { ClientAccountConsoleConfig } from './define_config.js';
import { DEFAULT_ALGS } from './jwks.js';

/** The container binding contributors register into (same name as authkit-server's). */
export const ACCOUNT_EXTENSIONS_BINDING = 'authkit.accountExtensions';

/**
 * The account extensions registry of an app whose IdP runs elsewhere. Contributors register
 * exactly as they would next to authkit-server; this app then serves the pages to the IdP.
 */
export class ClientAccountExtensionRegistry extends BaseAccountExtensionRegistry {}

/** What verifying a remote-extension token needs. */
export interface AccountExtensionsVerifier {
  issuer: string;
  clientId: string;
  keys: JWTVerifyGetKey;
}

/** A refusal: `status` plus the JSON body to send. */
export interface AccountExtensionsAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const refuse = (status: 401 | 403, code: string, message: string): AccountExtensionsAnswer => ({
  status,
  body: { error: { code, message } },
  ...(status === 401
    ? {
        headers: {
          'WWW-Authenticate': `Bearer error="${code}", scope="${ACCOUNT_EXTENSIONS_SCOPE}"`,
        },
      }
    : {}),
});

/** Verifies the IdP's token: signature, issuer, audience, `typ`, lifetime and scope. */
export async function verifyAccountExtensionsToken(
  authorization: string | undefined,
  verifier: AccountExtensionsVerifier,
): Promise<{ ok: true; claims: JWTPayload } | { ok: false; answer: AccountExtensionsAnswer }> {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  if (!match?.[1]) {
    return { ok: false, answer: refuse(401, 'invalid_token', 'A bearer token is required.') };
  }
  let claims: JWTPayload;
  try {
    ({ payload: claims } = await jwtVerify(match[1], verifier.keys, {
      issuer: verifier.issuer,
      audience: verifier.clientId,
      typ: ACCOUNT_EXTENSIONS_TOKEN_TYP,
      algorithms: DEFAULT_ALGS,
      maxTokenAge: ACCOUNT_EXTENSIONS_TOKEN_MAX_TTL,
      requiredClaims: ['exp', 'iat', 'sub'],
    }));
  } catch {
    return { ok: false, answer: refuse(401, 'invalid_token', 'The token is not valid.') };
  }
  if ((claims.exp as number) - (claims.iat as number) > ACCOUNT_EXTENSIONS_TOKEN_MAX_TTL) {
    return { ok: false, answer: refuse(401, 'invalid_token', 'The token lives too long.') };
  }
  const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ') : [];
  if (!scopes.includes(ACCOUNT_EXTENSIONS_SCOPE)) {
    return {
      ok: false,
      answer: refuse(403, 'insufficient_scope', `The token lacks "${ACCOUNT_EXTENSIONS_SCOPE}".`),
    };
  }
  return { ok: true, claims };
}

export interface ServeAccountExtensionsInput {
  method: string;
  authorization: string | undefined;
  /** The exact POST body (its hash is signed by the IdP). */
  rawBody: string | null;
  extensions: readonly AccountExtension[];
  contract: number;
  verifier: AccountExtensionsVerifier;
  config: ClientAccountConsoleConfig;
  make: (binding: string) => Promise<any>;
  log?: (message: string) => void;
}

/**
 * Answers the IdP: `GET` → the manifest, `POST` → one call (visible, load or action). Only a token
 * the IdP signed for this app (audience = client id, scope `authkit:account-extensions`) gets in;
 * a POST must also match the signed body hash and name the token's account.
 */
export async function serveAccountExtensions(
  input: ServeAccountExtensionsInput,
): Promise<AccountExtensionsAnswer> {
  const verified = await verifyAccountExtensionsToken(input.authorization, input.verifier);
  if (!verified.ok) return verified.answer;
  const { claims } = verified;
  if (input.method === 'GET') {
    if (claims.sub !== ACCOUNT_EXTENSIONS_MANIFEST_SUBJECT) {
      return refuse(403, 'invalid_token', 'This token is not for the manifest.');
    }
    return { status: 200, body: buildAccountExtensionsManifest(input.extensions, input.contract) };
  }
  if (input.method !== 'POST') {
    return {
      status: 405,
      body: { error: { code: 'method_not_allowed', message: 'GET or POST.' } },
    };
  }
  if (input.rawBody === null || claims.bh !== accountExtensionsBodyHash(input.rawBody)) {
    return refuse(403, 'invalid_token', 'The token does not match the body.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(input.rawBody);
  } catch {
    raw = null;
  }
  const call = parseAccountExtensionCall(raw);
  if (!call) {
    return { status: 400, body: { error: { code: 'invalid_request', message: 'Bad call.' } } };
  }
  if (call.account.id !== claims.sub) {
    return refuse(403, 'invalid_token', 'The token is for another account.');
  }
  return runAccountExtensionCall(input.extensions, call, {
    ...(input.config.subject ? { subject: input.config.subject } : {}),
    make: input.make,
    ...(input.config.loadTimeoutMs !== undefined
      ? { loadTimeoutMs: input.config.loadTimeoutMs }
      : {}),
    ...(input.config.actionTimeoutMs !== undefined
      ? { actionTimeoutMs: input.config.actionTimeoutMs }
      : {}),
    ...(input.log ? { log: input.log } : {}),
  });
}
