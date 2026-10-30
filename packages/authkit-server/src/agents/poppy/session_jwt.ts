/**
 * O header `Poppy-Session` (Draft 0.3, §5.2–§5.3): um JWT que o personal agent assina para uma
 * request, com uma chave delegada. Uma chave do `jwks_uri` assina a delegação
 * (`pap-delegation+jwt`), que vai no header `pap_dlg` do JWT e atesta a chave delegada em `cnf.jwk`.
 *
 * Só as checagens do JWT em si: o `client_id` do token, a Session e o replay ficam no `PoppyService`.
 */
import {
  calculateJwkThumbprint,
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  type JWK,
  type JWTPayload,
  jwtVerify,
} from 'jose';
import type { PoppyClient } from './client_registry.js';
import { accessTokenHash, normalizeHtu } from './dpop.js';

export const SESSION_JWT_TYP = 'poppy-session+jwt';
export const DELEGATION_TYP = 'pap-delegation+jwt';

/** Delegação: `ES256` obrigatório; `PS384` permite a assinatura cega (§5.2, §10.7). */
const DELEGATION_ALGS = ['ES256', 'PS384'];
const DELEGATION_MAX_LIFETIME_S = 24 * 3600;
const CLOCK_SKEW_S = 5;
/** Mesmos caracteres dos Conversation IDs (§8.2). */
const SESSION_ID = /^[A-Za-z0-9_-]{1,256}$/;
/** Tamanho da coluna `user_id`/`agent_id`. */
const MAX_ID_LENGTH = 255;

export class SessionJwtError extends Error {}

export interface VerifiedSessionJwt {
  clientId: string;
  sid: string;
  userId: string;
  agentId: string | null;
  jti: string;
  iat: number;
}

export interface VerifySessionJwtInput {
  /** Valor do(s) header(s) `Poppy-Session`. */
  header: string | string[] | undefined;
  method: string;
  url: string;
  /** Access token da request, ou `null`. */
  accessToken: string | null;
  /** O identificador da empresa: o issuer (§3.2). */
  audience: string;
  /** Janela de aceitação do `iat`, em segundos. */
  maxAge: number;
  /** Resolve o agente pelo `iss` (client metadata + `jwks_uri`). */
  resolveClient: (clientId: unknown) => Promise<PoppyClient>;
  now: Date;
}

const fail = (why: string) => new SessionJwtError(why);

/** Passos 1–4 de "Delegated keys" (§5.2): devolve a chave delegada, já conferida. */
async function verifyDelegation(
  delegation: unknown,
  client: PoppyClient,
  now: Date,
): Promise<{ jwk: JWK; exp: number }> {
  if (typeof delegation !== 'string' || !delegation) throw fail('pap_dlg is required');
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(delegation, client.keys, {
      algorithms: DELEGATION_ALGS,
      typ: DELEGATION_TYP,
      issuer: client.clientId,
      currentDate: now,
      clockTolerance: CLOCK_SKEW_S,
      requiredClaims: ['iat', 'exp', 'jti'],
    }));
  } catch {
    throw fail('delegation verification failed');
  }
  if (payload.exp! - payload.iat! > DELEGATION_MAX_LIFETIME_S) {
    throw fail('delegation lasts more than 24 hours');
  }
  const jwk = (payload.cnf as { jwk?: Record<string, unknown> } | undefined)?.jwk;
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || 'd' in jwk) {
    throw fail('cnf.jwk must be a public P-256 key');
  }
  return { jwk: jwk as JWK, exp: payload.exp! };
}

/** Verifica o JWT (§5.3, passos 1–3). Lança {@link SessionJwtError}. */
export async function verifySessionJwt(input: VerifySessionJwtInput): Promise<VerifiedSessionJwt> {
  const token = input.header;
  if (typeof token !== 'string' || !token) throw fail('exactly one Poppy-Session header required');
  let header: ReturnType<typeof decodeProtectedHeader>;
  let iss: unknown;
  try {
    header = decodeProtectedHeader(token);
    iss = decodeJwt(token).iss;
  } catch {
    throw fail('malformed Session JWT');
  }
  if (header.typ !== SESSION_JWT_TYP) throw fail(`typ must be ${SESSION_JWT_TYP}`);
  if (header.alg !== 'ES256') throw fail('alg must be ES256');

  let client: PoppyClient;
  try {
    client = await input.resolveClient(iss);
  } catch {
    throw fail('the client_id was refused');
  }
  const delegation = await verifyDelegation(header.pap_dlg, client, input.now);
  if (header.kid !== (await calculateJwkThumbprint(delegation.jwk, 'sha256'))) {
    throw fail('kid must be the thumbprint of the delegated key');
  }

  let claims: JWTPayload;
  try {
    const key = await importJWK(delegation.jwk, 'ES256');
    ({ payload: claims } = await jwtVerify(token, key, {
      algorithms: ['ES256'],
      typ: SESSION_JWT_TYP,
      issuer: client.clientId,
      currentDate: input.now,
    }));
  } catch {
    throw fail('Session JWT signature verification failed');
  }

  if (typeof claims.aud !== 'string' || claims.aud !== input.audience) {
    throw fail('aud must be the Company identifier, as a single string');
  }
  if (claims.htm !== input.method.toUpperCase()) throw fail('htm does not match the request');
  const htu = typeof claims.htu === 'string' ? normalizeHtu(claims.htu) : null;
  if (htu === null || htu !== normalizeHtu(input.url)) throw fail('htu does not match the request');
  const nowS = Math.floor(input.now.getTime() / 1000);
  if (typeof claims.iat !== 'number' || Math.abs(nowS - claims.iat) > input.maxAge) {
    throw fail('iat is outside the acceptance window');
  }
  if (claims.iat > delegation.exp) throw fail('signed after the delegation expired');
  if (typeof claims.jti !== 'string' || !claims.jti) throw fail('jti is required');
  if (typeof claims.sid !== 'string' || !SESSION_ID.test(claims.sid)) throw fail('invalid sid');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > MAX_ID_LENGTH) {
    throw fail('sub (the User ID) is required');
  }
  const agentId = claims.agent_id;
  if (
    agentId !== undefined &&
    (typeof agentId !== 'string' || !agentId || agentId.length > MAX_ID_LENGTH)
  ) {
    throw fail('invalid agent_id');
  }
  if (input.accessToken === null) {
    if (claims.ath !== undefined) throw fail('ath must be absent without an access token');
  } else if (claims.ath !== accessTokenHash(input.accessToken)) {
    throw fail('ath does not match the access token');
  }

  return {
    clientId: client.clientId,
    sid: claims.sid,
    userId: claims.sub,
    agentId: (agentId as string | undefined) ?? null,
    jti: claims.jti,
    iat: claims.iat,
  };
}
