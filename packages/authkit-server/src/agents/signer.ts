import {
  CompactSign,
  createLocalJWKSet,
  importJWK,
  type JWTPayload,
  type JWTVerifyGetKey,
  SignJWT,
} from 'jose';

/** O PACT só admite estes algoritmos nos tokens de delegação e recibos (§5.4). */
const DELEGATION_ALGS = ['ES256', 'RS256'] as const;
type DelegationAlg = (typeof DELEGATION_ALGS)[number];

/** Fonte das chaves — o `OidcService` (troca de objeto numa rotação). */
export interface SigningKeySource {
  readonly signingJwks: { keys: Record<string, any>[] };
  readonly publicJwks: { keys: Record<string, any>[] };
}

export interface AgentSigner {
  /** Assina um JWT (token de delegação). */
  signJwt(payload: JWTPayload, options: { issuedAt: Date; expiresIn: number }): Promise<string>;
  /** JWS compacto de um objeto JSON arbitrário (recibo, PACT §5.6). */
  signJson(value: unknown): Promise<string>;
  /** Chaves públicas para verificar o que este signer assinou. */
  keySet(): JWTVerifyGetKey;
  /** Algoritmos que este signer pode ter usado (para o `jwtVerify`). */
  readonly algorithms: string[];
}

function algOf(jwk: Record<string, any>): DelegationAlg | null {
  if (DELEGATION_ALGS.includes(jwk.alg)) return jwk.alg;
  if (jwk.alg) return null;
  // JWKS inline sem `alg`: infere pelo tipo da chave.
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') return 'ES256';
  if (jwk.kty === 'RSA') return 'RS256';
  return null;
}

/** Lança quando o JWKS não tem nenhuma chave que possa assinar tokens de delegação. */
export function assertDelegationSigningKey(jwks: { keys: Record<string, any>[] }): void {
  if (!jwks.keys.some((k) => algOf(k) !== null)) {
    throw new Error(
      'authkit: personalAgents.delegation exige uma chave ES256 ou RS256 no keystore (PACT §5.4). Configure `jwks.algorithm` como RS256 ou ES256.',
    );
  }
}

/**
 * Signer sobre o keystore do IdP: a primeira chave ES256/RS256 do JWKS assina
 * (a primeira é a corrente após uma rotação); o JWKS público inteiro verifica,
 * então tokens assinados antes de uma rotação continuam válidos no período de
 * graça. Lê a fonte a cada chamada — rotação ao vivo não exige restart.
 */
export function keystoreSigner(source: SigningKeySource): AgentSigner {
  const imported = new Map<string, Promise<CryptoKey | Uint8Array>>();
  let localSet: { jwks: object; set: JWTVerifyGetKey } | null = null;

  const current = async () => {
    const jwk = source.signingJwks.keys.find((k) => algOf(k) !== null);
    if (!jwk) {
      throw new Error(
        'authkit: personal agents exigem uma chave ES256 ou RS256 no keystore (PACT §5.4). Configure `jwks.algorithm` como RS256 ou ES256.',
      );
    }
    const alg = algOf(jwk)!;
    const cacheKey = `${jwk.kid ?? ''}:${alg}`;
    let key = imported.get(cacheKey);
    if (!key) {
      key = importJWK(jwk, alg) as Promise<CryptoKey | Uint8Array>;
      imported.set(cacheKey, key);
    }
    return { key: await key, alg, kid: jwk.kid as string | undefined };
  };

  return {
    algorithms: [...DELEGATION_ALGS],

    async signJwt(payload, { issuedAt, expiresIn }) {
      const { key, alg, kid } = await current();
      const iat = Math.floor(issuedAt.getTime() / 1000);
      return new SignJWT(payload)
        .setProtectedHeader({ alg, typ: 'JWT', ...(kid ? { kid } : {}) })
        .setIssuedAt(iat)
        .setExpirationTime(iat + expiresIn)
        .sign(key);
    },

    async signJson(value) {
      const { key, alg, kid } = await current();
      return new CompactSign(new TextEncoder().encode(JSON.stringify(value)))
        .setProtectedHeader({ alg, ...(kid ? { kid } : {}) })
        .sign(key);
    },

    keySet() {
      const jwks = source.publicJwks;
      if (!localSet || localSet.jwks !== jwks) {
        localSet = { jwks, set: createLocalJWKSet(jwks as any) };
      }
      return localSet.set;
    },
  };
}
