import { type JWTPayload, jwtVerify } from 'jose';
import { DEFAULT_ALGS, getJwks } from './jwks.js';

/**
 * Verificação LOCAL de um JWT Access Token (RFC 9068) emitido pelo AuthKit server
 * com `accessTokens: { format: 'jwt' }`. Valida a assinatura contra o JWKS remoto
 * (cacheado) do IdP — SEM round-trip de introspecção — e impõe as regras do perfil
 * RFC 9068: header `typ: at+jwt`, `iss`/`aud` esperados e claims obrigatórias.
 *
 * Barato e stateless: o `createRemoteJWKSet` busca o jwks_uri uma vez e cacheia as
 * chaves (rotação é tolerada — o jose recarrega ao ver um `kid` novo). Útil para um
 * resource server que recebe o AT no header Authorization e quer validar sem chamar
 * o /introspect a cada request.
 */
export interface VerifyJwtAccessTokenOptions {
  /** Issuer esperado (a claim `iss`). */
  issuer: string;
  /** jwks_uri do IdP (do discovery). */
  jwksUri: string;
  /** Audience esperada (a claim `aud`) — a URI/identificador desta API. */
  audience: string | string[];
  /** Algoritmos de assinatura aceitos (defesa contra alg-confusion). Default: asimétricos. */
  algorithms?: string[];
  /** Aceita JWS com qualquer `typ` (desliga a checagem RFC 9068 `at+jwt`). Default: false. */
  allowAnyTyp?: boolean;
}

/** Claims de um JWT AT RFC 9068 validado. */
export interface JwtAccessTokenClaims extends JWTPayload {
  client_id?: string;
  scope?: string;
}

/**
 * Verifica um JWT AT (RFC 9068). Lança (via jose) se a assinatura/claims forem
 * inválidas ou se o `typ` não for `at+jwt` (a menos que `allowAnyTyp`). Retorna as
 * claims validadas no caminho feliz.
 */
export async function verifyJwtAccessToken(
  token: string,
  options: VerifyJwtAccessTokenOptions,
): Promise<JwtAccessTokenClaims> {
  const jwks = getJwks(options.jwksUri);
  const { payload } = await jwtVerify(token, jwks, {
    issuer: options.issuer,
    audience: options.audience,
    algorithms: options.algorithms ?? DEFAULT_ALGS,
    // RFC 9068 §2.1: o header DEVE ser `typ: "at+jwt"`. jose valida quando passamos `typ`.
    ...(options.allowAnyTyp ? {} : { typ: 'at+jwt' }),
  });
  return payload as JwtAccessTokenClaims;
}
