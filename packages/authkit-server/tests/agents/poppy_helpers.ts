import { createHash, randomBytes } from 'node:crypto';
import { configProvider } from '@adonisjs/core';
import RedisMock from 'ioredis-mock';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import type { PoppyConfigInput } from '../../src/agents/poppy/config.js';
import type { FetchedJson } from '../../src/agents/poppy/safe_fetch.js';
import { CLIENT_ASSERTION_TYPE, JWT_BEARER_GRANT } from '../../src/agents/poppy/service.js';
import { buildPersonalAgentsRuntime } from '../../src/agents/runtime.js';
import { adapters, defineConfig, type ResolvedServerConfig } from '../../src/define_config.js';
import { OidcService } from '../../src/provider/oidc_service.js';
import { ensureAuthkitSchema } from '../../src/schema/ensure.js';
import { createTestDatabase } from '../bootstrap.js';

export const ISSUER = 'https://shop.example/oidc';
export const POPPY_ISSUER = 'https://shop.example/poppy';
export const TOKEN_URL = `${POPPY_ISSUER}/oauth/token`;
export const CLIENT_ID = 'https://agent.example/agent.json';
export const JWKS_URI = 'https://agent.example/jwks.json';
export const REDIRECT_URI = 'https://agent.example/oauth/callback';
export const MCP_URL = 'https://shop.example/mcp';
export const ORDERS_API = 'https://api.shop.example/orders';
export const ACCOUNT_ID = 'acct-1';
export const OTHER_ACCOUNT_ID = 'acct-2';

export const b64 = (bytes = 16) => randomBytes(bytes).toString('base64url');

export interface AgentKeys {
  sign: CryptoKey;
  jwk: JWK;
}

export async function agentKeys(kid = 'k1'): Promise<AgentKeys> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  return {
    sign: privateKey,
    jwk: { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' },
  };
}

export async function dpopKey() {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwk };
}

export type DpopKey = Awaited<ReturnType<typeof dpopKey>>;

export async function dpopProof(
  key: DpopKey,
  input: {
    htm?: string;
    htu?: string;
    accessToken?: string;
    nonce?: string;
    jti?: string;
    iat?: number;
    typ?: string;
  } = {},
) {
  const payload: Record<string, unknown> = {
    jti: input.jti ?? b64(),
    htm: input.htm ?? 'POST',
    htu: input.htu ?? TOKEN_URL,
    iat: input.iat ?? Math.floor(Date.now() / 1000),
  };
  if (input.accessToken) {
    payload.ath = createHash('sha256').update(input.accessToken).digest('base64url');
  }
  if (input.nonce) payload.nonce = input.nonce;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', typ: input.typ ?? 'dpop+jwt', jwk: key.jwk })
    .sign(key.privateKey);
}

export function clientMetadata(overrides: Record<string, unknown> = {}) {
  return {
    client_id: CLIENT_ID,
    client_name: 'Example Agent',
    logo_uri: 'https://agent.example/logo.png',
    jwks_uri: JWKS_URI,
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: 'private_key_jwt',
    extensions: { operations: { version: '1' } },
    ...overrides,
  };
}

export interface Env {
  service: OidcService;
  db: any;
  runtime: NonNullable<Awaited<ReturnType<typeof buildPersonalAgentsRuntime>>>;
  poppy: NonNullable<NonNullable<Awaited<ReturnType<typeof buildPersonalAgentsRuntime>>>['poppy']>;
  keys: AgentKeys;
  docs: Map<string, unknown>;
  fetched: string[];
  setNow(ms: number | null): void;
  clientAssertion(opts?: {
    aud?: string | string[];
    jti?: string;
    sub?: string;
    iss?: string;
    exp?: number;
    typ?: string;
  }): Promise<string>;
  sessionAssertion(opts?: {
    sub?: string;
    aud?: string | string[];
    jti?: string;
    exp?: number;
    iat?: number;
    typ?: string;
    key?: CryptoKey;
  }): Promise<string>;
  browserAssertion(
    claims: Record<string, unknown>,
    opts?: { typ?: string; exp?: number; iat?: number },
  ): Promise<string>;
  /** Form de token com a client assertion já preenchida. */
  form(extra: Record<string, unknown>, aud?: string): Promise<Record<string, unknown>>;
  /** Começa uma Session deslogada (DPoP). */
  startSession(dkey: DpopKey, sub?: string): Promise<{ access_token: string; session_id: string }>;
  close(): Promise<void>;
}

export async function setupPoppy(
  poppy: Partial<PoppyConfigInput> = {},
  extra: { accounts?: Record<string, { email: string }>; mcp?: boolean } = {},
): Promise<Env> {
  const keys = await agentKeys();
  const docs = new Map<string, unknown>([
    [CLIENT_ID, clientMetadata()],
    [JWKS_URI, { keys: [keys.jwk] }],
  ]);
  const fetched: string[] = [];
  let nowMs: number | null = null;
  const accounts = extra.accounts ?? {
    [ACCOUNT_ID]: { email: 'jane@example.com' },
    [OTHER_ACCOUNT_ID]: { email: 'john@example.com' },
  };
  const fakeApp = {
    container: { make: async () => ({ connection: () => new RedisMock() }) },
  } as any;
  const cfg = await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer: ISSUER,
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed', algorithm: 'ES256' },
      clients: [],
      accountStore: {
        findById: async (id: string) =>
          accounts[id] ? { id, email: accounts[id].email, globalRoles: [] } : null,
      } as any,
      render: (async () => {}) as any,
      trustedDevices: { enabled: false },
      ...(extra.mcp === false ? {} : { mcp: true }),
      personalAgents: {
        poppy: {
          organization: { name: 'Shop', domain: 'shop.example', aliases: ['shop.example.co.uk'] },
          scopes: { addresses: 'Manage saved shipping addresses' },
          apis: [
            {
              type: 'openapi',
              url: 'https://api.shop.example/openapi.json',
              description: 'Orders',
            },
            { type: 'mcp', url: MCP_URL, description: 'Product search' },
          ],
          agent: {
            protocols: [{ type: 'poppy', endpoint: 'https://shop.example/poppy/conversations' }],
          },
          replay: 'memory',
          ...poppy,
        } as PoppyConfigInput,
      },
    }),
  );
  const service = new OidcService(cfg as ResolvedServerConfig, 'a'.repeat(32));
  const db = createTestDatabase();
  await ensureAuthkitSchema(db);
  const runtime = (await buildPersonalAgentsRuntime(service, async () => db, {
    fetchJson: async (url: string): Promise<FetchedJson> => {
      fetched.push(url);
      if (!docs.has(url)) throw new Error('not found');
      return { status: 200, body: docs.get(url), maxAge: null };
    },
    now: () => (nowMs === null ? new Date() : new Date(nowMs)),
  }))!;

  const nowS = () => Math.floor((nowMs ?? Date.now()) / 1000);

  const env: Env = {
    service,
    db,
    runtime,
    poppy: runtime.poppy!,
    keys,
    docs,
    fetched,
    setNow(ms) {
      nowMs = ms;
    },
    async clientAssertion(opts = {}) {
      const iat = nowS();
      return new SignJWT({
        iss: opts.iss ?? CLIENT_ID,
        sub: opts.sub ?? CLIENT_ID,
        aud: opts.aud ?? TOKEN_URL,
        iat,
        exp: opts.exp ?? iat + 60,
        jti: opts.jti ?? b64(),
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1', ...(opts.typ ? { typ: opts.typ } : {}) })
        .sign(keys.sign);
    },
    async sessionAssertion(opts = {}) {
      const iat = opts.iat ?? nowS();
      return new SignJWT({
        iss: CLIENT_ID,
        sub: opts.sub ?? 'usr_Q7c1vK',
        aud: opts.aud ?? TOKEN_URL,
        iat,
        exp: opts.exp ?? iat + 60,
        jti: opts.jti ?? b64(),
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1', ...(opts.typ ? { typ: opts.typ } : {}) })
        .sign(opts.key ?? keys.sign);
    },
    async browserAssertion(claims, opts = {}) {
      const iat = opts.iat ?? nowS();
      return new SignJWT({
        iss: CLIENT_ID,
        sub: 'usr_Q7c1vK',
        aud: `${POPPY_ISSUER}/browser-session`,
        iat,
        exp: opts.exp ?? iat + 60,
        jti: b64(),
        ...claims,
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: opts.typ ?? 'poppy-browser+jwt' })
        .sign(keys.sign);
    },
    async form(extraFields, aud = TOKEN_URL) {
      return {
        client_id: CLIENT_ID,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: await env.clientAssertion({ aud }),
        ...extraFields,
      };
    },
    async startSession(dkey, sub) {
      const res = await env.poppy.token(
        await env.form({
          grant_type: JWT_BEARER_GRANT,
          assertion: await env.sessionAssertion({ sub }),
        }),
        await dpopProof(dkey),
      );
      return { access_token: res.access_token, session_id: res.session_id };
    },
    async close() {
      await db.manager.closeAll();
    },
  };
  return env;
}

/** Request a uma API com o token + prova DPoP. */
export async function apiRequest(
  key: DpopKey | null,
  token: string,
  opts: { method?: string; url?: string; scheme?: string; proof?: string } = {},
) {
  const method = opts.method ?? 'GET';
  const url = opts.url ?? `${ORDERS_API}/ord_1`;
  const headers: Record<string, string> = {
    authorization: `${opts.scheme ?? (key ? 'DPoP' : 'Bearer')} ${token}`,
  };
  if (key)
    headers.dpop =
      opts.proof ?? (await dpopProof(key, { htm: method, htu: url, accessToken: token }));
  return { method, url, headers };
}

export function pkce() {
  const verifier = b64(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
