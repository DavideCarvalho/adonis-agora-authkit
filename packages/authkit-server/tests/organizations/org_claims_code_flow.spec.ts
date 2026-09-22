/**
 * Org claims in the AUTHORIZATION CODE flow — the regression this file pins.
 *
 * `org_id`/`org_slug`/`org_role` used to be read ONLY from the browser's active-org
 * cookie inside `findAccount`. On the Authorization Code flow the id_token is minted at
 * `/oidc/token`, a server-to-server call from the app with NONE of the user's cookies.
 * `readActiveOrgFromKoaCtx` therefore returned null and the three (optional) claims
 * silently vanished — `requireOrg` on the client then rejected every tenant route.
 *
 * The fix persists the org on the Grant during the browser's consent request and reads
 * it back at mint time. These tests drive the REAL authorize -> interaction -> token
 * chain (no internal function poking) so they fail against the old behavior:
 *
 *   1. consent WITH the org cookie -> token WITHOUT any cookie still carries org_*.
 *   2. consent WITHOUT the org cookie -> the claims are ABSENT (no invented org).
 *   3. the user switches org with a remembered consent -> the token follows the switch,
 *      not the stale org captured at first consent.
 *
 * And the second defect (the claim outliving reality): the org on the Grant is a
 * SNAPSHOT from consent, re-emitted by every refresh for up to 30 days. At mint time
 * it is now checked against the store:
 *
 *   4. member removed after consent -> the refreshed id_token has NO org_*.
 *   5. role changed after consent -> org_role is the CURRENT role, never the snapshot's.
 *   6. org deleted / never a member / store without the org capability -> no org_*.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import type { ResolvedServerConfig } from '../../src/define_config.js';
import { adapters, defineConfig } from '../../src/define_config.js';
import { ACTIVE_ORG_COOKIE, encodeActiveOrgCookie } from '../../src/host/active_org_cookie.js';
import { OidcService } from '../../src/provider/oidc_service.js';
import { fakeAccountStore } from '../bootstrap.js';

const CLIENT_ID = 'app1';
const CLIENT_SECRET = 's';
const ACCOUNT_ID = 'u1';
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'roles'];

/**
 * Estado de orgs em memória, MUTÁVEL pelos testes (remover membro, trocar papel,
 * apagar org) — o que o store diz AGORA é o que a emissão precisa refletir.
 */
const orgState = {
  orgs: new Map<string, { id: string; slug: string }>(),
  members: new Map<string, string>(), // `${orgId}:${accountId}` -> role
  reset() {
    this.orgs = new Map([
      ['org-1', { id: 'org-1', slug: 'acme' }],
      ['org-2', { id: 'org-2', slug: 'beta' }],
    ]);
    this.members = new Map([
      [`org-1:${ACCOUNT_ID}`, 'admin'],
      [`org-2:${ACCOUNT_ID}`, 'owner'],
    ]);
  },
};

/** `fakeAccountStore` + o mínimo da OrganizationsCapability que a emissão consulta. */
function storeWithOrgs() {
  const summary = (o: { id: string; slug: string }) => ({
    id: o.id,
    name: o.slug,
    slug: o.slug,
    createdAt: new Date(0).toISOString(),
  });
  return fakeAccountStore({
    createOrg: async () => {
      throw new Error('not used');
    },
    findOrgById: async (orgId: string) => {
      const o = orgState.orgs.get(orgId);
      return o ? summary(o) : null;
    },
    getOrgMembership: async (orgId: string, accountId: string) => {
      if (!orgState.orgs.has(orgId)) return null;
      const role = orgState.members.get(`${orgId}:${accountId}`);
      return role ? { role } : null;
    },
  } as any);
}

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

interface Harness {
  service: OidcService;
  issuer: string;
  server: Server;
}

/** Boots a real HTTP server on an ephemeral port so parallel spec files never collide. */
async function startServer(
  opts: { accountStore?: ReturnType<typeof fakeAccountStore> } = {},
): Promise<Harness> {
  let service!: OidcService;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (/^\/auth\/interaction\/[^/]+$/.test(url.pathname)) {
      handleInteraction(service, req, res).catch((err) => {
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
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
          redirectUris: [`${issuer}/cb`],
          grants: ['authorization_code', 'refresh_token'],
        },
      ],
      // Explicit first-party: org_* are bound to the `roles` scope and this gate.
      firstPartyClients: [CLIENT_ID],
      accountStore: opts.accountStore ?? storeWithOrgs(),
    }),
  );
  service = new OidcService(cfg!, 'a'.repeat(32));
  return { service, issuer, server };
}

/**
 * Mínimo de HttpContext do host que as interaction actions consomem: os Node req/res
 * (para interactionDetails/Finished) e `request.cookie` (é AQUI que o browser manda o
 * cookie de org no consent).
 */
function hostContext(req: IncomingMessage, res: ServerResponse): any {
  return {
    request: {
      request: req,
      cookie: (name: string) => readCookie(req.headers.cookie, name),
    },
    response: { response: res },
  };
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

async function handleInteraction(service: OidcService, req: IncomingMessage, res: ServerResponse) {
  const ctx = hostContext(req, res);
  const details = await service.interactions.details(ctx);
  if (details.prompt.name === 'login') {
    await service.interactions.completeLogin(ctx, ACCOUNT_ID);
    return;
  }
  // consent (e prompts desconhecidos): exercita a MESMA ação de produção.
  await service.interactions.consent(ctx);
}

function authorizeUrl(issuer: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    scope: SCOPES.join(' '),
    redirect_uri: `${issuer}/cb`,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // `offline_access` só vira refresh token com `prompt=consent` (OIDC Core §11).
    prompt: 'consent',
  });
  return `${issuer}/auth?${params.toString()}`;
}

/**
 * Segue a cadeia authorize -> interaction -> authorize -> /cb?code=... mantendo um cookie
 * jar manual. O jar pode ser semeado (org) e é MUTADO (o teste de troca de org o reusa).
 */
async function driveAuthorizeFlow(
  issuer: string,
  authorize: string,
  jar: Map<string, string>,
): Promise<string | null> {
  let nextUrl: string | null = authorize;
  for (let hop = 0; hop < 12 && nextUrl; hop++) {
    const res = await fetch(nextUrl, { redirect: 'manual', headers: cookieHeader(jar) });
    storeCookies(jar, res);
    const location = res.headers.get('location');
    if (!location) return null;
    const abs = new URL(location, issuer);
    if (abs.pathname === '/cb') return abs.searchParams.get('code');
    nextUrl = abs.toString();
  }
  return null;
}

function cookieHeader(jar: Map<string, string>): Record<string, string> {
  if (jar.size === 0) return {};
  return { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') };
}

function storeCookies(jar: Map<string, string>, res: Response) {
  const setCookies: string[] =
    typeof (res.headers as any).getSetCookie === 'function'
      ? (res.headers as any).getSetCookie()
      : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie') as string]
        : [];
  for (const sc of setCookies) {
    const [pair] = sc.split(';');
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === '' || /expires=Thu, 01 Jan 1970/i.test(sc)) jar.delete(name);
    else jar.set(name, value);
  }
}

function seedOrg(
  jar: Map<string, string>,
  org: { orgId: string; orgSlug: string; orgRole: string },
) {
  jar.set(ACTIVE_ORG_COOKIE, encodeURIComponent(encodeActiveOrgCookie(org)));
}

/** Troca o code SEM cookie algum — exatamente como o app faz server-to-server. */
async function exchangeCode(issuer: string, code: string, verifier: string): Promise<any> {
  const res = await fetch(`${issuer}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${issuer}/cb`,
      code_verifier: verifier,
    }).toString(),
  });
  const body = await res.json();
  if (res.status !== 200) throw new Error(`token endpoint ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

/** Refresh server-to-server, sem cookie — como o app faz ao renovar a sessão. */
async function refresh(issuer: string, refreshToken: string): Promise<any> {
  const res = await fetch(`${issuer}/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }).toString(),
  });
  const body = await res.json();
  if (res.status !== 200) throw new Error(`refresh ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

function decodeJwtPayload(jwt: string): Record<string, any> {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
}

const ORG = { orgId: 'org-1', orgSlug: 'acme', orgRole: 'admin' };

test.group('org claims — authorization code flow', (group) => {
  let harness: Harness;

  group.setup(async () => {
    harness = await startServer();
    return async () => new Promise<void>((r) => harness.server.close(() => r()));
  });
  group.each.setup(() => orgState.reset());

  test('consent COM org + token SEM cookie: id_token carrega org_id/org_slug/org_role', async ({
    assert,
  }) => {
    const { verifier, challenge } = pkce();
    const jar = new Map<string, string>();
    seedOrg(jar, ORG);

    const code = await driveAuthorizeFlow(
      harness.issuer,
      authorizeUrl(harness.issuer, challenge, 'st-org'),
      jar,
    );
    assert.isString(code, 'authorize/consent deve emitir um code');

    const tokens = await exchangeCode(harness.issuer, code!, verifier);
    assert.isString(tokens.id_token, 'deve emitir id_token');

    const claims = decodeJwtPayload(tokens.id_token);
    // Sanidade do fluxo: as claims first-party continuam chegando.
    assert.equal(claims.sub, ACCOUNT_ID);
    assert.deepEqual(claims.roles, ['ADMIN']);
    // A REGRESSÃO: sem persistir a org no Grant isto vinha ausente/undefined.
    assert.equal(claims.org_id, ORG.orgId);
    assert.equal(claims.org_slug, ORG.orgSlug);
    assert.equal(claims.org_role, ORG.orgRole);
  });

  test('consent SEM org: o id_token NÃO inventa org_*', async ({ assert }) => {
    const { verifier, challenge } = pkce();
    const jar = new Map<string, string>(); // sem cookie de org

    const code = await driveAuthorizeFlow(
      harness.issuer,
      authorizeUrl(harness.issuer, challenge, 'st-no-org'),
      jar,
    );
    assert.isString(code);

    const tokens = await exchangeCode(harness.issuer, code!, verifier);
    const claims = decodeJwtPayload(tokens.id_token);

    assert.deepEqual(claims.roles, ['ADMIN']);
    assert.isUndefined(claims.org_id);
    assert.isUndefined(claims.org_slug);
    assert.isUndefined(claims.org_role);
  });

  test('troca de org com consent lembrado: o token segue a org NOVA, não a antiga', async ({
    assert,
  }) => {
    // 1) Primeiro consent grava org-1 no Grant.
    const jar = new Map<string, string>();
    seedOrg(jar, ORG);
    const first = pkce();
    const code1 = await driveAuthorizeFlow(
      harness.issuer,
      authorizeUrl(harness.issuer, first.challenge, 'st-switch-1'),
      jar,
    );
    assert.isString(code1);
    const claims1 = decodeJwtPayload(
      (await exchangeCode(harness.issuer, code1!, first.verifier)).id_token,
    );
    assert.equal(claims1.org_id, ORG.orgId);

    // 2) Usuário troca de org no console (cookie muda) e um novo authorize acontece
    //    na MESMA sessão (consent já lembrado).
    seedOrg(jar, { orgId: 'org-2', orgSlug: 'beta', orgRole: 'owner' });
    const second = pkce();
    const code2 = await driveAuthorizeFlow(
      harness.issuer,
      authorizeUrl(harness.issuer, second.challenge, 'st-switch-2'),
      jar,
    );
    assert.isString(code2);
    const claims2 = decodeJwtPayload(
      (await exchangeCode(harness.issuer, code2!, second.verifier)).id_token,
    );

    assert.equal(claims2.org_id, 'org-2');
    assert.equal(claims2.org_slug, 'beta');
    assert.equal(claims2.org_role, 'owner');
  });
});

/** Login + consent com a org no cookie; devolve os tokens do code exchange. */
async function loginWithOrg(
  issuer: string,
  org: { orgId: string; orgSlug: string; orgRole: string },
  state: string,
) {
  const { verifier, challenge } = pkce();
  const jar = new Map<string, string>();
  seedOrg(jar, org);
  const code = await driveAuthorizeFlow(issuer, authorizeUrl(issuer, challenge, state), jar);
  if (!code) throw new Error('authorize/consent não emitiu code');
  return exchangeCode(issuer, code, verifier);
}

test.group('org claims — a emissão confere a membership no store', (group) => {
  let harness: Harness;

  group.setup(async () => {
    harness = await startServer();
    return async () => new Promise<void>((r) => harness.server.close(() => r()));
  });
  group.each.setup(() => orgState.reset());

  test('membro REMOVIDO depois do consent: o refresh sai SEM org_*', async ({ assert }) => {
    const tokens = await loginWithOrg(harness.issuer, ORG, 'st-removed');
    assert.equal(decodeJwtPayload(tokens.id_token).org_id, ORG.orgId);
    assert.isString(tokens.refresh_token, 'o fluxo precisa de refresh token para o cenário');

    // Sanidade: enquanto é membro, o refresh reemite a org.
    const stillMember = await refresh(harness.issuer, tokens.refresh_token);
    assert.equal(decodeJwtPayload(stillMember.id_token).org_id, ORG.orgId);

    // Removido da equipe. O Grant ainda carrega o retrato do consent.
    orgState.members.delete(`${ORG.orgId}:${ACCOUNT_ID}`);

    const after = await refresh(harness.issuer, stillMember.refresh_token);
    const claims = decodeJwtPayload(after.id_token);
    assert.equal(claims.sub, ACCOUNT_ID, 'o token continua saindo — só a org cai');
    assert.deepEqual(claims.roles, ['ADMIN']);
    assert.isUndefined(claims.org_id);
    assert.isUndefined(claims.org_slug);
    assert.isUndefined(claims.org_role);
  });

  test('papel TROCADO depois do consent: org_role é o papel ATUAL, nunca o do retrato', async ({
    assert,
  }) => {
    const tokens = await loginWithOrg(harness.issuer, ORG, 'st-demoted');
    assert.equal(decodeJwtPayload(tokens.id_token).org_role, 'admin');

    orgState.members.set(`${ORG.orgId}:${ACCOUNT_ID}`, 'member');

    const after = await refresh(harness.issuer, tokens.refresh_token);
    const claims = decodeJwtPayload(after.id_token);
    assert.equal(claims.org_id, ORG.orgId);
    assert.equal(claims.org_role, 'member');
  });

  test('o cookie mente sobre o papel: o primeiro token já sai com o papel do store', async ({
    assert,
  }) => {
    // Retrato velho no cookie (`owner`), store diz `admin`.
    const tokens = await loginWithOrg(
      harness.issuer,
      { ...ORG, orgRole: 'owner' },
      'st-stale-cookie',
    );
    assert.equal(decodeJwtPayload(tokens.id_token).org_role, 'admin');
  });

  test('org APAGADA depois do consent: o refresh sai SEM org_*', async ({ assert }) => {
    const tokens = await loginWithOrg(harness.issuer, ORG, 'st-deleted');
    orgState.orgs.delete(ORG.orgId);

    const after = await refresh(harness.issuer, tokens.refresh_token);
    const claims = decodeJwtPayload(after.id_token);
    assert.isUndefined(claims.org_id);
    assert.isUndefined(claims.org_role);
  });

  test('org da qual a conta NUNCA foi membro: nem o primeiro token carrega org_*', async ({
    assert,
  }) => {
    orgState.orgs.set('org-x', { id: 'org-x', slug: 'alheia' });
    const tokens = await loginWithOrg(
      harness.issuer,
      { orgId: 'org-x', orgSlug: 'alheia', orgRole: 'owner' },
      'st-foreign',
    );
    const claims = decodeJwtPayload(tokens.id_token);
    assert.isUndefined(claims.org_id);
    assert.isUndefined(claims.org_role);
  });
});

test.group('org claims — store sem a capacidade de Organizations', (group) => {
  let harness: Harness;

  group.setup(async () => {
    harness = await startServer({ accountStore: fakeAccountStore() });
    return async () => new Promise<void>((r) => harness.server.close(() => r()));
  });

  test('sem como conferir a membership, não há claim de org (fail-closed)', async ({ assert }) => {
    const tokens = await loginWithOrg(harness.issuer, ORG, 'st-no-capability');
    const claims = decodeJwtPayload(tokens.id_token);
    assert.equal(claims.sub, ACCOUNT_ID);
    assert.isUndefined(claims.org_id);
    assert.isUndefined(claims.org_role);
  });
});
