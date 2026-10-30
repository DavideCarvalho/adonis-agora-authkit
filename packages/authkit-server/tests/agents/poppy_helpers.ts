import { createHash, randomBytes } from 'node:crypto';
import { configProvider } from '@adonisjs/core';
import RedisMock from 'ioredis-mock';
import { calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import type { PoppyConfigInput } from '../../src/agents/poppy/config.js';
import type { FetchedJson } from '../../src/agents/poppy/safe_fetch.js';
import { CLIENT_ASSERTION_TYPE, DEVICE_CODE_GRANT } from '../../src/agents/poppy/service.js';
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
    extensions: { operations: { version: '2' } },
    ...overrides,
  };
}

export interface SessionJwtOptions {
  sid?: string;
  sub?: string;
  agentId?: string;
  htm?: string;
  htu?: string;
  aud?: string | string[];
  iss?: string;
  iat?: number;
  jti?: string;
  typ?: string;
  /** Access token coberto por `ath`. */
  accessToken?: string;
  /** Valor literal de `ath`. */
  ath?: string;
  /** Assina direto com a chave do `jwks_uri`, sem delegação. */
  noDelegation?: boolean;
  kid?: string;
  delegation?: { typ?: string; iat?: number; exp?: number; iss?: string; cnf?: unknown };
}

export interface RequestOptions extends SessionJwtOptions {
  method?: string;
  url?: string;
  token?: string;
  dkey?: DpopKey;
  scheme?: string;
}

export const DEFAULT_SID = 'Yx2b7Qd_Kp8mR3vT1nWc4A';

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
  /** O JWT do header `Poppy-Session`, assinado com uma chave delegada nova. */
  sessionJwt(opts?: SessionJwtOptions): Promise<string>;
  /** Uma request com o header da Session e, se dado, o access token (+ prova com `dkey`). */
  request(opts?: RequestOptions): Promise<{
    method: string;
    url: string;
    headers: Record<string, string>;
  }>;
  /** Form de token com a client assertion já preenchida. */
  form(extra: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Device Sign-In completo. */
  signIn(opts?: {
    accountId?: string;
    scope?: string;
    dkey?: DpopKey;
  }): Promise<{ access_token: string; refresh_token: string; token_type: string; scope: string }>;
  close(): Promise<void>;
}

export async function setupPoppy(
  poppy: Partial<PoppyConfigInput> = {},
  extra: { accounts?: Record<string, { email: string }>; mcp?: boolean; issuer?: string } = {},
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
      issuer: extra.issuer ?? ISSUER,
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
          scopes: {
            'orders:read': 'See your orders',
            'orders:write': 'Exchange or return items',
            addresses: 'Manage saved shipping addresses',
          },
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
        aud: opts.aud ?? POPPY_ISSUER,
        iat,
        exp: opts.exp ?? iat + 60,
        jti: opts.jti ?? b64(),
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'k1', ...(opts.typ ? { typ: opts.typ } : {}) })
        .sign(keys.sign);
    },
    async sessionJwt(opts = {}) {
      const iat = opts.iat ?? nowS();
      const claims: Record<string, unknown> = {
        iss: opts.iss ?? CLIENT_ID,
        aud: opts.aud ?? POPPY_ISSUER,
        sid: opts.sid ?? DEFAULT_SID,
        sub: opts.sub ?? 'usr_Q7c1vK',
        htm: opts.htm ?? 'GET',
        htu: opts.htu ?? `${ORDERS_API}/ord_1`,
        iat,
        jti: opts.jti ?? b64(),
      };
      if (opts.agentId) claims.agent_id = opts.agentId;
      if (opts.ath) claims.ath = opts.ath;
      else if (opts.accessToken) {
        claims.ath = createHash('sha256').update(opts.accessToken).digest('base64url');
      }
      const typ = opts.typ ?? 'poppy-session+jwt';
      if (opts.noDelegation) {
        return new SignJWT(claims)
          .setProtectedHeader({ alg: 'ES256', typ, kid: 'k1' })
          .sign(keys.sign);
      }
      const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
      const delegated = await exportJWK(publicKey);
      const dlgIat = opts.delegation?.iat ?? nowS() - 60;
      const delegation = await new SignJWT({
        iss: opts.delegation?.iss ?? CLIENT_ID,
        cnf: opts.delegation?.cnf ?? { jwk: delegated },
        iat: dlgIat,
        exp: opts.delegation?.exp ?? dlgIat + 3600,
        jti: b64(),
      })
        .setProtectedHeader({
          alg: 'ES256',
          typ: opts.delegation?.typ ?? 'pap-delegation+jwt',
          kid: 'k1',
        })
        .sign(keys.sign);
      return new SignJWT(claims)
        .setProtectedHeader({
          alg: 'ES256',
          typ,
          kid: opts.kid ?? (await calculateJwkThumbprint(delegated, 'sha256')),
          pap_dlg: delegation,
        })
        .sign(privateKey);
    },
    async request(opts = {}) {
      const method = opts.method ?? 'GET';
      const url = opts.url ?? `${ORDERS_API}/ord_1`;
      const headers: Record<string, string> = {
        'poppy-session': await env.sessionJwt({
          htm: method,
          htu: url,
          accessToken: opts.token,
          ...opts,
        }),
      };
      if (opts.token) {
        headers.authorization = `${opts.scheme ?? (opts.dkey ? 'DPoP' : 'Bearer')} ${opts.token}`;
        if (opts.dkey) {
          headers.dpop = await dpopProof(opts.dkey, {
            htm: method,
            htu: url,
            accessToken: opts.token,
          });
        }
      }
      return { method, url, headers };
    },
    async form(extraFields) {
      return {
        client_id: CLIENT_ID,
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: await env.clientAssertion(),
        ...extraFields,
      };
    },
    async signIn(opts = {}) {
      const scope = opts.scope ?? 'orders:read orders:write';
      const device = (await env.poppy.deviceAuthorization(await env.form({ scope }))) as any;
      await env.poppy.decideDevice({
        userCode: device.user_code,
        accountId: opts.accountId ?? ACCOUNT_ID,
        allow: true,
        scopes: scope.split(' '),
      });
      const res = await env.poppy.token(
        await env.form({ grant_type: DEVICE_CODE_GRANT, device_code: device.device_code }),
        opts.dkey ? await dpopProof(opts.dkey) : undefined,
      );
      return res as any;
    },
    async close() {
      await db.manager.closeAll();
    },
  };
  return env;
}

export function pkce() {
  const verifier = b64(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
