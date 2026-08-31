import type { KeyObject } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';

const ALG = 'RS256';

export interface TestKeyPair {
  privateKey: CryptoKey | KeyObject;
  publicKey: CryptoKey | KeyObject;
  kid: string;
}

/** Gera um par de chaves RS256 extraível com um `kid` estável, para minting de tokens em testes. */
export async function generateTestKeyPair(kid: string = randomUUID()): Promise<TestKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
  return { privateKey, publicKey, kid };
}

export interface MintTestIdTokenOptions {
  /** claim `iss` — deve casar com o `issuer` configurado no resolver. */
  issuer: string;
  /** claim `aud` — deve casar com o `audience`/clientId configurado no resolver. */
  clientId: string;
  /** claims extras / overrides (ex.: `sub`, `email`, `roles`). */
  claims?: Record<string, unknown>;
  /** par de chaves para assinar; um novo é gerado se omitido. */
  key?: TestKeyPair;
  /** validade em segundos (default 3600). */
  expiresInSeconds?: number;
}

export interface MintedToken {
  /** o JWT assinado (RS256) real. */
  token: string;
  /** par de chaves usado (gerado ou fornecido). */
  key: TestKeyPair;
  /** JWKS público (apenas a chave pública) para validação local. */
  jwks: { keys: JWK[] };
}

/**
 * Emite um ID token JWT REAL assinado com RS256 (não um mock). O JWKS público
 * resultante valida o token através do `JwtResolver` quando servido em
 * {@link serveJwks} e apontado por `resolvers.jwt({ jwksUri })`.
 */
export async function mintTestIdToken(options: MintTestIdTokenOptions): Promise<MintedToken> {
  const key = options.key ?? (await generateTestKeyPair());
  const expiresIn = options.expiresInSeconds ?? 3600;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const baseClaims: Record<string, unknown> = {
    sub: 'test-user-id',
    email: 'test@example.com',
    ...options.claims,
  };

  const token = await new SignJWT(baseClaims)
    .setProtectedHeader({ alg: ALG, kid: key.kid })
    .setIssuer(options.issuer)
    .setAudience(options.clientId)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + expiresIn)
    .sign(key.privateKey);

  return { token, key, jwks: await testJwks(key) };
}

/** Exporta o JWKS público (uma chave) de um par de chaves de teste. */
export async function testJwks(key: TestKeyPair): Promise<{ keys: JWK[] }> {
  const jwk = await exportJWK(key.publicKey);
  jwk.use = 'sig';
  jwk.alg = ALG;
  jwk.kid = key.kid;
  return { keys: [jwk] };
}

/** Objeto pronto para alimentar um `createLocalJWKSet` — o JWKS público como `{ keys }`. */
export async function jwksFromKey(key: TestKeyPair): Promise<{ keys: JWK[] }> {
  return testJwks(key);
}

export interface ServedJwks {
  /** URL do endpoint JWKS in-process (passe ao `resolvers.jwt({ jwksUri })`). */
  jwksUri: string;
  /** servidor http subjacente. */
  server: Server;
  /** fecha o servidor (chame no `group.teardown`). */
  close: () => Promise<void>;
}

/**
 * Sobe um servidor http in-process que serve o JWKS público em
 * `GET /.well-known/jwks.json`. O `JwtResolver` usa `createRemoteJWKSet`, então
 * ele só aceita uma URL — este helper fornece essa URL localmente sem rede
 * externa nem IdP.
 */
export async function serveJwks(jwks: { keys: JWK[] }): Promise<ServedJwks> {
  const body = JSON.stringify(jwks);
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/.well-known/jwks.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Falha ao obter a porta do servidor JWKS de teste');
  }
  const jwksUri = `http://127.0.0.1:${address.port}/.well-known/jwks.json`;

  return {
    jwksUri,
    server,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
