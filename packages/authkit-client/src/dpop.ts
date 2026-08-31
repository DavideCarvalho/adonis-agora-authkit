import type { KeyObject } from 'node:crypto';
import { createHash, randomUUID } from 'node:crypto';
import {
  base64url,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from 'jose';

/**
 * Par de chaves DPoP (RFC 9449). `privateKey`/`publicKey` são CryptoKey/KeyObject (aceitos pelo jose),
 * usáveis direto em {@link createDpopProof}. As versões JWK são exportáveis para
 * persistir/restaurar o par entre requests (ex.: sessão do client).
 */
export interface DpopKeyPair {
  privateKey: CryptoKey | KeyObject;
  publicKey: CryptoKey | KeyObject;
  /** JWK pública (vai no header `jwk` da prova). */
  publicJwk: JWK;
  /** JWK privada — guarde com cuidado (só o client a possui). */
  privateJwk: JWK;
}

/**
 * Gera um par de chaves DPoP ES256 (P-256), exportável como JWK. ES256 é o alg
 * recomendado pelo RFC 9449 e o que o oidc-provider do authkit-server aceita.
 */
export async function generateDpopKeyPair(): Promise<DpopKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const [publicJwk, privateJwk] = await Promise.all([exportJWK(publicKey), exportJWK(privateKey)]);
  return { privateKey, publicKey, publicJwk, privateJwk };
}

export interface CreateDpopProofInput {
  /** Par de chaves DPoP (de {@link generateDpopKeyPair}). */
  key: DpopKeyPair;
  /** HTTP method da request alvo (ex.: 'POST'). Vira a claim `htm`. */
  htm: string;
  /** HTTP URI alvo SEM query/fragment (ex.: 'https://auth/token'). Vira `htu`. */
  htu: string;
  /** Nonce do servidor (DPoP-Nonce), quando exigido. */
  nonce?: string;
  /**
   * Access token quando a prova acompanha uma request a um recurso protegido:
   * adiciona a claim `ath` = base64url(sha256(accessToken)) (RFC 9449 §4.2).
   */
  accessToken?: string;
}

/** ath = base64url( SHA-256( ASCII(access_token) ) ). */
function accessTokenHash(accessToken: string): string {
  return base64url.encode(createHash('sha256').update(accessToken, 'ascii').digest());
}

/**
 * Cria uma prova DPoP (JWT) conforme RFC 9449.
 *
 *   - header: `typ: 'dpop+jwt'`, `alg: 'ES256'`, `jwk` = chave PÚBLICA.
 *   - claims: `jti` (único), `htm`, `htu`, `iat`; `ath` quando `accessToken` é dado;
 *     `nonce` quando dado.
 *
 * O resultado vai no header HTTP `DPoP` da request.
 */
export async function createDpopProof(input: CreateDpopProofInput): Promise<string> {
  const { key, htm, htu, nonce, accessToken } = input;

  const payload: Record<string, unknown> = {
    jti: randomUUID(),
    htm: htm.toUpperCase(),
    htu,
  };
  if (accessToken) payload.ath = accessTokenHash(accessToken);
  if (nonce) payload.nonce = nonce;

  return new SignJWT(payload)
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk })
    .setIssuedAt()
    .sign(key.privateKey);
}

/**
 * Calcula o JWK thumbprint (jkt) da chave pública DPoP — o valor que o AS coloca
 * em `cnf.jkt` ao emitir tokens sender-constrained. Útil para o client conferir
 * o binding do token recebido.
 */
export async function dpopJwkThumbprint(key: DpopKeyPair): Promise<string> {
  return calculateJwkThumbprint(key.publicJwk, 'sha256');
}
