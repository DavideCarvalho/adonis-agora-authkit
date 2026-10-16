import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';

/** Test IdP: one RSA key, a local JWKS for it, and an id_token signer. */
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };

export const TEST_JWKS = { keys: [jwk] };
export const testKeys = createLocalJWKSet(TEST_JWKS);

export async function signIdToken(
  claims: JWTPayload & { iss?: string; aud?: string | string[] },
  options: { expiresIn?: string } = {},
): Promise<string> {
  const { iss = 'http://idp', aud = 'app1', ...rest } = claims;
  return new SignJWT({ sub: 'u1', ...rest })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? '5m')
    .sign(privateKey);
}
