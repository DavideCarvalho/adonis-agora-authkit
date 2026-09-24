/**
 * App nativo (RFC 8252) de ponta a ponta, contra o provider REAL:
 *
 *   1. authorize (PKCE S256) → login → consent → code entregue no redirect de
 *      ESQUEMA PRIVADO (`com.example.app:/oauth`) e no LOOPBACK com porta
 *      efêmera — o consent é PULADO porque o client nativo é first-party
 *      (`branding.firstParty`), pelo MESMO `InteractionController#show` de produção;
 *   2. /token sem autenticação de client (client público) + `code_verifier`;
 *   3. `offline_access` → refresh token; refresh ROTACIONA; reusar o RT antigo
 *      revoga o grant inteiro (detecção de replay);
 *   4. o access token emitido verifica pelo `inProcessAccessTokenVerifier` e pelo
 *      `remoteAccessTokenVerifier` (introspecção RFC 7662 e JWKS RFC 9068);
 *      revogado / refresh token / JWT forjado → recusado.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { generateKeyPair, importJWK, SignJWT } from 'jose';
import type { ResolvedServerConfig } from '../../src/define_config.js';
import { adapters, defineConfig } from '../../src/define_config.js';
import {
  inProcessAccessTokenVerifier,
  remoteAccessTokenVerifier,
} from '../../src/host/access_token_verifier.js';
import InteractionController from '../../src/host/controllers/interaction_controller.js';
import { OidcService } from '../../src/provider/oidc_service.js';
import { fakeAccountStore } from '../bootstrap.js';

const NATIVE_CLIENT = 'mobile';
const SCHEME_REDIRECT = 'com.example.app:/oauth';
const LOOPBACK_REDIRECT = 'http://127.0.0.1/callback';
const RS_CLIENT = 'api-rs';
const RS_SECRET = 'rs-secret';
const ACCOUNT_ID = 'u1';

interface Harness {
  service: OidcService;
  issuer: string;
  server: Server;
  /** Views que o controller RENDERIZOU (uma tela de consent aqui = consent não pulado). */
  rendered: string[];
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** O mínimo de HttpContext que `InteractionController#show` e as actions leem. */
function hostContext(service: OidcService, req: IncomingMessage, res: ServerResponse): any {
  return {
    request: {
      request: req,
      response: res,
      cookie: (name: string) => readCookie(req.headers.cookie, name),
      param: () => undefined,
      qs: () => ({}),
      input: (_k: string, def?: unknown) => def,
      ip: () => '127.0.0.1',
      csrfToken: 'test-csrf',
      encryptedCookie: () => undefined,
    },
    response: { response: res, encryptedCookie: () => {} },
    session: { get: () => undefined, put: () => {}, forget: () => {} },
    containerResolver: { make: async () => service },
  };
}

async function startServer(): Promise<Harness> {
  let service!: OidcService;
  const rendered: string[] = [];
  const controller = new InteractionController();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (/^\/auth\/interaction\/[^/]+$/.test(url.pathname)) {
      (async () => {
        const ctx = hostContext(service, req, res);
        const details = await service.interactions.details(ctx);
        // Login: pula a UI (não é o que está em teste) e conclui com a conta.
        if (details.prompt.name === 'login') {
          await service.interactions.completeLogin(ctx, ACCOUNT_ID);
          return;
        }
        // Consent: o controller de PRODUÇÃO decide (first-party → auto-consent).
        await controller.show(ctx);
        if (!res.writableEnded) res.end();
      })().catch((err) => {
        res.statusCode = 500;
        res.end(String(err?.stack ?? err));
      });
      return;
    }
    service.callback(req, res);
  });
  await new Promise<void>((r) => server.listen(0, r));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const issuer = `http://localhost:${port}`;

  const fakeApp = {
    container: { make: async () => ({ connection: () => new RedisMock() }) },
  } as any;
  const cfg = await configProvider.resolve<ResolvedServerConfig>(
    fakeApp,
    defineConfig({
      issuer,
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed', algorithm: 'RS256' },
      clients: [
        {
          // App nativo: sem secret (público), redirect de esquema privado + loopback.
          clientId: NATIVE_CLIENT,
          applicationType: 'native',
          redirectUris: [SCHEME_REDIRECT, LOOPBACK_REDIRECT],
          grants: ['authorization_code', 'refresh_token'],
        },
        {
          // Resource server remoto: client confidencial que só introspecciona
          // (nenhum grant de emissão de token).
          clientId: RS_CLIENT,
          clientSecret: RS_SECRET,
          redirectUris: [],
          grants: [],
        },
      ],
      branding: {
        company: 'AuthKit Test',
        clients: {},
        default: { appName: 'Test', accent: '#000', accentSoft: '#111', tagline: 'tl' },
        firstParty: [NATIVE_CLIENT],
      },
      render: ((_ctx: any, view: string) => {
        rendered.push(view);
        _ctx.response.response.writeHead(200, { 'x-render-view': view });
        _ctx.response.response.end();
      }) as any,
      accountStore: fakeAccountStore(),
    }),
  );
  service = new OidcService(cfg!, 'a'.repeat(32));
  return { service, issuer, server, rendered };
}

/**
 * Segue authorize → interaction → resume até o redirect do APP (que o browser do
 * sistema entregaria ao app via esquema/loopback). Devolve a URL final.
 */
async function authorize(h: Harness, redirectUri: string, challenge: string): Promise<URL | null> {
  const jar = new Map<string, string>();
  let next: string | null =
    `${h.issuer}/auth?` +
    new URLSearchParams({
      client_id: NATIVE_CLIENT,
      response_type: 'code',
      scope: 'openid profile email offline_access',
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st-native',
      // `offline_access` só vira refresh token com `prompt=consent` (OIDC Core §11).
      prompt: 'consent',
    }).toString();
  for (let hop = 0; hop < 12 && next; hop++) {
    const res = await fetch(next, {
      redirect: 'manual',
      headers: jar.size
        ? { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') }
        : {},
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const eq = pair.indexOf('=');
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /expires=Thu, 01 Jan 1970/i.test(sc)) jar.delete(pair.slice(0, eq));
      else jar.set(pair.slice(0, eq).trim(), value);
    }
    const location = res.headers.get('location');
    if (!location) return null;
    if (!location.startsWith(h.issuer) && !location.startsWith('/')) return new URL(location);
    next = new URL(location, h.issuer).toString();
  }
  return null;
}

async function tokenRequest(issuer: string, body: Record<string, string>) {
  const res = await fetch(`${issuer}/token`, {
    method: 'POST',
    // Client PÚBLICO: nada de Authorization; o client_id vai no corpo.
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: NATIVE_CLIENT, ...body }).toString(),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function codeFlow(h: Harness, redirectUri = SCHEME_REDIRECT) {
  const { verifier, challenge } = pkce();
  const landed = await authorize(h, redirectUri, challenge);
  if (!landed) throw new Error('authorize não chegou ao redirect do app');
  const code = landed.searchParams.get('code');
  if (!code) throw new Error(`sem code: ${landed}`);
  const tokens = await tokenRequest(h.issuer, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri === LOOPBACK_REDIRECT ? landed.origin + landed.pathname : redirectUri,
    code_verifier: verifier,
  });
  return { landed, tokens };
}

test.group('app nativo (RFC 8252) — code + PKCE → token → refresh', (group) => {
  let h: Harness;
  group.setup(async () => {
    h = await startServer();
    return async () => new Promise<void>((r) => h.server.close(() => r()));
  });

  test('redirect de esquema privado recebe o code; consent first-party é pulado', async ({
    assert,
  }) => {
    const { landed, tokens } = await codeFlow(h);
    assert.equal(`${landed.protocol}${landed.pathname}`, SCHEME_REDIRECT);
    assert.equal(landed.searchParams.get('state'), 'st-native');
    assert.notInclude(h.rendered, 'consent', 'client nativo first-party não vê a tela de consent');

    assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
    assert.isString(tokens.body.access_token);
    assert.isString(tokens.body.id_token);
    assert.isString(tokens.body.refresh_token, 'offline_access emite refresh token');
  });

  test('loopback registrado sem porta aceita porta efêmera', async ({ assert }) => {
    const { verifier, challenge } = pkce();
    const landed = await authorize(h, 'http://127.0.0.1:53123/callback', challenge);
    assert.isOk(landed);
    assert.equal(landed!.origin, 'http://127.0.0.1:53123');
    const tokens = await tokenRequest(h.issuer, {
      grant_type: 'authorization_code',
      code: landed!.searchParams.get('code')!,
      redirect_uri: 'http://127.0.0.1:53123/callback',
      code_verifier: verifier,
    });
    assert.equal(tokens.status, 200, JSON.stringify(tokens.body));
  });

  test('redirect fora do registrado é recusado (sem code)', async ({ assert }) => {
    const { challenge } = pkce();
    const landed = await authorize(h, 'com.evil.app:/oauth', challenge);
    assert.isNull(landed?.searchParams.get('code') ?? null);
  });

  test('token sem code_verifier é recusado (PKCE obrigatório)', async ({ assert }) => {
    const { challenge } = pkce();
    const landed = await authorize(h, SCHEME_REDIRECT, challenge);
    const res = await tokenRequest(h.issuer, {
      grant_type: 'authorization_code',
      code: landed!.searchParams.get('code')!,
      redirect_uri: SCHEME_REDIRECT,
    });
    assert.equal(res.status, 400);
  });

  test('refresh rotaciona; reusar o RT antigo revoga o grant', async ({ assert }) => {
    const { tokens } = await codeFlow(h);
    const rt1 = tokens.body.refresh_token as string;

    const r2 = await tokenRequest(h.issuer, { grant_type: 'refresh_token', refresh_token: rt1 });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    const rt2 = r2.body.refresh_token as string;
    assert.isString(rt2);
    assert.notEqual(rt2, rt1, 'client público: todo refresh emite um RT novo');

    // Replay do RT já rotacionado: recusado E o grant inteiro cai (rt2 junto).
    const replay = await tokenRequest(h.issuer, {
      grant_type: 'refresh_token',
      refresh_token: rt1,
    });
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, 'invalid_grant');
    const after = await tokenRequest(h.issuer, { grant_type: 'refresh_token', refresh_token: rt2 });
    assert.equal(after.status, 400);
  });
});

test.group('verificação de access token (in-process e remoto)', (group) => {
  let h: Harness;
  group.setup(async () => {
    h = await startServer();
    return async () => new Promise<void>((r) => h.server.close(() => r()));
  });

  test('in-process: AT opaco do app nativo → sub/client/escopos', async ({ assert }) => {
    const { tokens } = await codeFlow(h);
    const verifier = inProcessAccessTokenVerifier(async () => h.service);
    const verified = await verifier.verify(tokens.body.access_token);
    assert.isOk(verified);
    assert.equal(verified!.format, 'opaque');
    assert.equal(verified!.sub, ACCOUNT_ID);
    assert.equal(verified!.clientId, NATIVE_CLIENT);
    assert.includeMembers(verified!.scopes, ['openid', 'profile', 'email']);
    assert.isAbove(verified!.exp!, Math.floor(Date.now() / 1000));
  });

  test('in-process: revogado, refresh token e lixo → null', async ({ assert }) => {
    const { tokens } = await codeFlow(h);
    const verifier = inProcessAccessTokenVerifier(async () => h.service);

    assert.isNull(await verifier.verify(tokens.body.refresh_token));
    assert.isNull(await verifier.verify('nao-e-um-token'));
    assert.isNull(await verifier.verify(''));

    // RFC 7009: o próprio app (público) revoga o token.
    const revoke = await fetch(`${h.issuer}/token/revocation`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: NATIVE_CLIENT,
        token: tokens.body.access_token,
      }).toString(),
    });
    assert.equal(revoke.status, 200);
    assert.isNull(await verifier.verify(tokens.body.access_token));
  });

  test('in-process: AT expirado → null', async ({ assert }) => {
    const provider: any = h.service.provider;
    const at = new provider.AccessToken({
      accountId: ACCOUNT_ID,
      clientId: NATIVE_CLIENT,
      scope: 'openid',
      gty: 'authorization_code',
      expiresIn: 1,
    });
    const value = await at.save();
    const verifier = inProcessAccessTokenVerifier(async () => h.service);
    assert.isOk(await verifier.verify(value));
    await new Promise((r) => setTimeout(r, 1100));
    assert.isNull(await verifier.verify(value));
  });

  test('in-process: JWT (RFC 9068) assinado pelo issuer; forjado/typ errado → null', async ({
    assert,
  }) => {
    const jwk = h.service.config.jwks.keys[0];
    const key = await importJWK(jwk as any, jwk.alg ?? 'RS256');
    const now = Math.floor(Date.now() / 1000);
    const sign = (typ: string, k: any = key, extra: Record<string, unknown> = {}) =>
      new SignJWT({ client_id: NATIVE_CLIENT, scope: 'openid email', ...extra })
        .setProtectedHeader({ alg: jwk.alg ?? 'RS256', kid: jwk.kid, typ })
        .setIssuer(h.issuer)
        .setSubject(ACCOUNT_ID)
        .setAudience('https://api.example.com')
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .setJti('jti-1')
        .sign(k);

    const verifier = inProcessAccessTokenVerifier(async () => h.service);
    const ok = await verifier.verify(await sign('at+jwt'));
    assert.equal(ok?.format, 'jwt');
    assert.equal(ok?.sub, ACCOUNT_ID);
    assert.deepEqual(ok?.audience, ['https://api.example.com']);

    // `typ` errado (um id_token, por ex.) não é access token.
    assert.isNull(await verifier.verify(await sign('JWT')));
    // Chave estranha ao issuer.
    const { privateKey } = await generateKeyPair('RS256');
    assert.isNull(await verifier.verify(await sign('at+jwt', privateKey)));
    // Sender-constrained (DPoP) apresentado como Bearer puro.
    assert.isNull(await verifier.verify(await sign('at+jwt', key, { cnf: { jkt: 'x' } })));
  });

  test('remoto: introspecção (RFC 7662) aceita AT, recusa RT e AT revogado', async ({ assert }) => {
    const { tokens } = await codeFlow(h);
    const verifier = remoteAccessTokenVerifier({
      issuer: h.issuer,
      introspection: { clientId: RS_CLIENT, clientSecret: RS_SECRET },
    });
    const verified = await verifier.verify(tokens.body.access_token);
    assert.equal(verified?.sub, ACCOUNT_ID);
    assert.equal(verified?.clientId, NATIVE_CLIENT);
    assert.equal(verified?.format, 'opaque');

    assert.isNull(await verifier.verify(tokens.body.refresh_token), 'RT não é access token');

    await fetch(`${h.issuer}/token/revocation`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: NATIVE_CLIENT,
        token: tokens.body.access_token,
      }).toString(),
    });
    assert.isNull(await verifier.verify(tokens.body.access_token));
  });

  test('remoto: credenciais de introspecção erradas → null (sem vazar)', async ({ assert }) => {
    const { tokens } = await codeFlow(h);
    const verifier = remoteAccessTokenVerifier({
      issuer: h.issuer,
      introspection: { clientId: RS_CLIENT, clientSecret: 'errado' },
    });
    assert.isNull(await verifier.verify(tokens.body.access_token));
  });

  test('remoto: JWT verificado pelo jwks_uri da discovery', async ({ assert }) => {
    const jwk = h.service.config.jwks.keys[0];
    const key = await importJWK(jwk as any, jwk.alg ?? 'RS256');
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ client_id: NATIVE_CLIENT, scope: 'openid' })
      .setProtectedHeader({ alg: jwk.alg ?? 'RS256', kid: jwk.kid, typ: 'at+jwt' })
      .setIssuer(h.issuer)
      .setSubject(ACCOUNT_ID)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(key);
    const verifier = remoteAccessTokenVerifier({ issuer: h.issuer });
    const verified = await verifier.verify(token);
    assert.equal(verified?.format, 'jwt');
    assert.equal(verified?.sub, ACCOUNT_ID);

    // Sem `introspection`, token opaco não tem como ser verificado → null.
    assert.isNull(await verifier.verify('opaco-qualquer'));
  });
});
