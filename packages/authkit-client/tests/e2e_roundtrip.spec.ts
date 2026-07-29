import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import {
  OidcService,
  type ResolvedServerConfig,
  adapters,
  defineConfig as defineServer,
} from '@adonis-agora/authkit-server';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { buildAuthorizeUrl, generatePkce } from '../src/oidc_login.js';
import { resolvers } from '../src/resolvers/factory.js';

const PORT = 9821;
const ISSUER = `http://localhost:${PORT}`;
const CLIENT_ID = 'app1';
const CLIENT_SECRET = 's';
const REDIRECT_URI = `${ISSUER}/cb`;

/**
 * Round-trip COMPLETO: server account claims() -> ID token (JWT assinado pelo JWKS do
 * server) -> client JwtResolver -> Identity com globalRoles=['ADMIN'] e email.
 *
 * Prova end-to-end que conformIdTokenClaims:false faz email/profile/roles chegarem no
 * ID token (no fluxo Authorization Code, onde também é emitido um Access Token).
 */
test.group('client ↔ server round-trip (ID token)', (group) => {
  let server: Server;
  let service: OidcService;

  group.setup(async () => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve<ResolvedServerConfig>(
      fakeApp,
      defineServer({
        issuer: ISSUER,
        adapter: adapters.redis({ connection: 'main' }),
        jwks: { source: 'managed', algorithm: 'RS256' },
        clients: [
          {
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            redirectUris: [REDIRECT_URI],
            grants: ['authorization_code', 'refresh_token'],
          },
        ],
        // accountStore é o contrato primário de identidade do server kit: o provider
        // resolve as claims via accountStore.findById(sub). Aqui basta um store mínimo
        // que devolve a conta admin para qualquer sub (o interaction flow é dirigido
        // in-memory abaixo, então só findById é exercitado).
        // Client first-party: roles/org_* só são emitidas a clients first-party (gate
        // de least-privilege). Sem branding/firstParty, o gate dropa roles do token.
        branding: {
          company: 'Test',
          clients: {},
          default: { appName: 'Test', accent: '#000000', accentSoft: '#111111', tagline: 'test' },
          firstParty: [CLIENT_ID],
        },
        accountStore: {
          findById: async (id) => ({
            id,
            email: 'admin@example.com',
            name: 'Admin User',
            avatarUrl: 'https://example.com/a.png',
            globalRoles: ['ADMIN'],
          }),
          verifyCredentials: async () => null,
          findByEmail: async () => null,
          create: async () => {
            throw new Error('not used');
          },
          // `AdminCapability` (parte de `CoreAccountStore`) exige as duas — o
          // fake ficou para trás quando o contrato cresceu. Nenhuma delas é
          // alcançada pelo round-trip OIDC, então estouram em vez de fingir.
          listAccounts: async () => {
            throw new Error('not used');
          },
          setGlobalRoles: async () => {
            throw new Error('not used');
          },
          issuePasswordResetToken: async () => null,
          consumePasswordResetToken: async () => false,
          issueEmailVerificationToken: async () => null,
          consumeEmailVerificationToken: async () => false,
        },
      }),
    );
    service = new OidcService(cfg!, 'a'.repeat(32));

    // Handler: rotas OIDC normais vão pro service.callback; a tela de interaction
    // (login + consent) é completada in-memory via a API de interaction do provider.
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', ISSUER);
      const match = url.pathname.match(/^\/auth\/interaction\/([^/]+)$/);
      if (match) {
        await completeInteraction(service, req, res);
        return;
      }
      service.callback(req, res);
    });
    await new Promise<void>((r) => server.listen(PORT, r));
    return async () => new Promise<void>((r) => server.close(() => r()));
  });

  test('ID token validado pelo client carrega globalRoles e email', async ({ assert }) => {
    const { verifier, challenge } = await generatePkce();
    const state = `st-${Math.random().toString(36).slice(2)}`;

    const authorizeUrl = buildAuthorizeUrl({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scopes: ['openid', 'profile', 'email', 'offline_access', 'roles'], // scopes PADRÃO do client (roles incluído desde a 0.8.0)
      state,
      codeChallenge: challenge,
    });

    // 1) Segue a cadeia de redirects (authorize -> interaction -> authorize -> /cb?code=...)
    //    com um cookie jar manual (o provider seta cookie de interaction/sessão).
    const code = await driveAuthorizeFlow(authorizeUrl);
    assert.isString(code);

    // 2) Troca o code por tokens no token endpoint
    const tokenRes = await fetch(`${ISSUER}/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }).toString(),
    });
    const tokens = (await tokenRes.json()) as any;
    assert.equal(tokenRes.status, 200, JSON.stringify(tokens));
    assert.isString(tokens.id_token, 'deve emitir um id_token');
    assert.isString(tokens.access_token, 'deve emitir um access_token (fluxo code)');

    // 3) Valida o ID TOKEN através do JwtResolver do client (assinatura via JWKS do server)
    // `Response.json()` é `Promise<unknown>` nos tipos do Node; o cast declara o
    // subset do discovery document que este teste usa.
    const disco = (await (await fetch(`${ISSUER}/.well-known/openid-configuration`)).json()) as {
      jwks_uri: string;
    };
    assert.isString(disco.jwks_uri);
    const factory = resolvers.jwt({ jwksUri: disco.jwks_uri });
    const resolver = await factory.resolver({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      sessionKey: 'authkit',
      globalRolesClaim: 'roles',
    });

    const identity = await (resolver as any).resolveToken(tokens.id_token);
    assert.isNotNull(identity, 'ID token deve ser válido e resolver para uma Identity');
    assert.deepEqual(identity.globalRoles, ['ADMIN']);
    assert.equal(identity.email, 'admin@example.com');
    assert.equal(identity.profile.name, 'Admin User');
  });
});

/** Completa login + consent in-memory para a interaction corrente. */
async function completeInteraction(
  service: OidcService,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const provider = service.provider as any;
  const details = await provider.interactionDetails(req, res);
  const { prompt, params, jti } = details;
  const accountId = 'user-1';

  if (prompt.name === 'login') {
    await provider.interactionFinished(
      req,
      res,
      { login: { accountId } },
      { mergeWithLastSubmission: false },
    );
    return;
  }

  // prompt.name === 'consent' (ou outro): concede os escopos/claims solicitados.
  let grant = details.grantId ? await provider.Grant.find(details.grantId) : undefined;
  if (!grant) {
    grant = new provider.Grant({ accountId, clientId: params.client_id as string });
  }
  if (prompt.details.missingOIDCScope) {
    grant.addOIDCScope((prompt.details.missingOIDCScope as string[]).join(' '));
  }
  if (prompt.details.missingOIDCClaims) {
    grant.addOIDCClaims(prompt.details.missingOIDCClaims as string[]);
  }
  const grantId = await grant.save();

  await provider.interactionFinished(
    req,
    res,
    { consent: { grantId } },
    { mergeWithLastSubmission: true },
  );
  void jti;
}

/**
 * Segue a cadeia de redirects do authorize até capturar o `code` no redirect_uri.
 * Mantém um cookie jar manual (fetch com redirect:'manual', encaminhando set-cookie).
 */
async function driveAuthorizeFlow(authorizeUrl: string): Promise<string | null> {
  const jar = new Map<string, string>();
  let nextUrl: string | null = authorizeUrl;
  let method = 'GET' as const;

  for (let hop = 0; hop < 12 && nextUrl; hop++) {
    const res: Response = await fetch(nextUrl, {
      method,
      redirect: 'manual',
      headers: cookieHeader(jar),
    });
    storeCookies(jar, res);

    // O redirect_uri (/cb) carrega o code — capturamos sem segui-lo.
    const location = res.headers.get('location');
    if (location) {
      const abs = new URL(location, ISSUER);
      if (abs.pathname === '/cb') {
        return abs.searchParams.get('code');
      }
      nextUrl = abs.toString();
      method = 'GET';
      continue;
    }

    // Sem redirect: provavelmente o body da interaction GET; mas o nosso handler de
    // interaction responde com 303 (interactionFinished), então não deve cair aqui.
    // Se cair, encerra.
    return null;
  }
  return null;
}

function cookieHeader(jar: Map<string, string>): Record<string, string> {
  if (jar.size === 0) return {};
  const cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  return { cookie };
}

function storeCookies(jar: Map<string, string>, res: Response) {
  // Node fetch expõe getSetCookie() para múltiplos Set-Cookie.
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
    // cookies de expiração (value vazio / expires no passado) removem do jar
    if (value === '' || /expires=Thu, 01 Jan 1970/i.test(sc)) {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
}
