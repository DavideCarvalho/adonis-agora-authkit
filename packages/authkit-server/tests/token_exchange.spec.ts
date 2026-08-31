import { createServer, type Server } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { adapters, defineConfig } from '../src/define_config.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { fakeAccountStore } from './bootstrap.js';

const PORT = 9790;
const ISSUER = `http://localhost:${PORT}`;
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

function decodeJwtPayload(jwt: string) {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
}

test.group('token-exchange (impersonation)', (group) => {
  let server: Server;
  let service: OidcService;
  const auditEvents: any[] = [];

  group.setup(async () => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      defineConfig({
        issuer: ISSUER,
        adapter: adapters.redis({ connection: 'main' }),
        jwks: { source: 'managed', algorithm: 'RS256' },
        clients: [
          {
            clientId: 'app1',
            clientSecret: 's',
            redirectUris: [`${ISSUER}/cb`],
            grants: ['authorization_code', 'refresh_token', TOKEN_EXCHANGE],
          },
          {
            clientId: 'app2',
            clientSecret: 's2',
            redirectUris: [`${ISSUER}/cb2`],
            grants: ['authorization_code', 'refresh_token', TOKEN_EXCHANGE],
          },
        ],
        audit: {
          record: async (e) => {
            auditEvents.push(e);
          },
        },
        accountStore: fakeAccountStore({
          findById: async (sub) => {
            if (sub === 'admin-1')
              return { id: sub, email: 'admin@x.com', globalRoles: ['ADMIN'], name: 'Admin' };
            if (sub === 'user-1')
              return { id: sub, email: 'u@x.com', globalRoles: ['USER'], name: 'User' };
            if (sub === 'target-1')
              return { id: sub, email: 't@x.com', globalRoles: ['USER'], name: 'Target' };
            return null;
          },
        }),
      }),
    );
    service = new OidcService(cfg as any, 'a'.repeat(32));
    server = createServer(service.callback);
    await new Promise<void>((r) => server.listen(PORT, r));
    return async () => new Promise<void>((r) => server.close(() => r()));
  });

  async function mintSubjectToken(accountId: string, clientId = 'app1'): Promise<string> {
    const provider = (service as any).provider;
    const client = await provider.Client.find(clientId);
    const at = new provider.AccessToken({ accountId, client, scope: 'openid profile email' });
    return at.save();
  }

  function tokenRequest(params: Record<string, string>) {
    return fetch(`${ISSUER}/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from('app1:s').toString('base64')}`,
      },
      body: new URLSearchParams(params).toString(),
    });
  }

  test('admin troca por alvo → id_token com sub=alvo e act={sub:admin}', async ({ assert }) => {
    const subjectToken = await mintSubjectToken('admin-1');
    const res = await tokenRequest({
      grant_type: TOKEN_EXCHANGE,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      requested_subject: 'target-1',
      scope: 'openid profile email',
    });
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.isString(json.access_token);
    assert.isString(json.id_token);
    const payload = decodeJwtPayload(json.id_token);
    assert.equal(payload.sub, 'target-1');
    assert.equal(payload.email, 't@x.com');
    assert.deepEqual(payload.act, { sub: 'admin-1' });

    // Audita o evento de impersonation (actor=admin, account=alvo).
    const imp = auditEvents.find((e) => e.type === 'impersonation');
    assert.exists(imp);
    assert.equal(imp.actorId, 'admin-1');
    assert.equal(imp.accountId, 'target-1');
    assert.equal(imp.clientId, 'app1');
  });

  test('ator não-admin → invalid_grant (negado)', async ({ assert }) => {
    const subjectToken = await mintSubjectToken('user-1');
    const res = await tokenRequest({
      grant_type: TOKEN_EXCHANGE,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      requested_subject: 'target-1',
    });
    assert.equal(res.status, 400);
    const json: any = await res.json();
    assert.equal(json.error, 'invalid_grant');
  });

  test('requested_subject ausente → erro', async ({ assert }) => {
    const subjectToken = await mintSubjectToken('admin-1');
    const res = await tokenRequest({
      grant_type: TOKEN_EXCHANGE,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
    });
    assert.equal(res.status, 400);
    const json: any = await res.json();
    assert.equal(json.error, 'invalid_request');
  });

  test('subject_token inválido → invalid_grant', async ({ assert }) => {
    const res = await tokenRequest({
      grant_type: TOKEN_EXCHANGE,
      subject_token: 'nao-existe',
      subject_token_type: ACCESS_TOKEN_TYPE,
      requested_subject: 'target-1',
    });
    assert.equal(res.status, 400);
    const json: any = await res.json();
    assert.equal(json.error, 'invalid_grant');
  });

  // ── H2: subject_token DEVE ser do mesmo client autenticado ───────────────────
  test('subject_token de OUTRO client (app2) usado por app1 → invalid_grant', async ({
    assert,
  }) => {
    // AT mintado para app2, mas a request autentica como app1 (Basic app1:s).
    const subjectToken = await mintSubjectToken('admin-1', 'app2');
    const res = await tokenRequest({
      grant_type: TOKEN_EXCHANGE,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      requested_subject: 'target-1',
    });
    assert.equal(res.status, 400);
    const json: any = await res.json();
    assert.equal(json.error, 'invalid_grant');
  });

  // ── H2: scope emitido é a INTERSEÇÃO com os scopes permitidos do client ───────
  test('scope pedido é reduzido à interseção com client.scope', async ({ assert }) => {
    const provider = (service as any).provider;
    const client = await provider.Client.find('app1');
    // Constrange os scopes permitidos do client a um subconjunto.
    const original = client.scope;
    client.scope = 'openid email';
    try {
      const subjectToken = await mintSubjectToken('admin-1');
      const res = await tokenRequest({
        grant_type: TOKEN_EXCHANGE,
        subject_token: subjectToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        requested_subject: 'target-1',
        // Pede MAIS do que o client tem permissão.
        scope: 'openid profile email roles',
      });
      const json: any = await res.json();
      assert.equal(res.status, 200, JSON.stringify(json));
      // Só os scopes na interseção (com a allowlist do client) saem; `profile` e
      // `roles` (pedidos mas não permitidos) são descartados.
      assert.equal(json.scope, 'openid email');
      // O id_token reflete os scopes concedidos: `email` presente, `profile`
      // (name/picture) ausente porque o scope `profile` foi descartado.
      const payload = decodeJwtPayload(json.id_token);
      assert.equal(payload.email, 't@x.com');
      assert.isUndefined(payload.name);
    } finally {
      client.scope = original;
    }
  });

  // ── H2: audience/resource não suportado é rejeitado (invalid_target) ──────────
  test('audience não suportada → invalid_target', async ({ assert }) => {
    const subjectToken = await mintSubjectToken('admin-1');
    const res = await tokenRequest({
      grant_type: TOKEN_EXCHANGE,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      requested_subject: 'target-1',
      audience: 'https://evil.example/api',
    });
    assert.equal(res.status, 400);
    const json: any = await res.json();
    assert.equal(json.error, 'invalid_target');
  });
});

// ── H3: roles do ator via resolveTokenRoles + allowlist adminRoles ─────────────
test.group('token-exchange — roles do ator fora do globalRoles (resolveTokenRoles)', (group) => {
  let server: Server;
  let service: OidcService;
  const PORT3 = 9793;
  const ISSUER3 = `http://localhost:${PORT3}`;

  group.setup(async () => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      defineConfig({
        issuer: ISSUER3,
        adapter: adapters.redis({ connection: 'main' }),
        jwks: { source: 'managed', algorithm: 'RS256' },
        clients: [
          {
            clientId: 'app1',
            clientSecret: 's',
            redirectUris: [`${ISSUER3}/cb`],
            grants: ['authorization_code', 'refresh_token', TOKEN_EXCHANGE],
          },
        ],
        // O caso do app: roles vivem num store PRÓPRIO (ex.: @adonis-agora/authz),
        // não no `globalRoles` do authkit. `admin` minúsculo + hook resolve.
        admin: { enabled: false, roles: ['admin'] },
        resolveTokenRoles: async (account: any) =>
          account.id === 'authz-admin-1' ? ['admin'] : (account.globalRoles ?? []),
        accountStore: fakeAccountStore({
          findById: async (sub) => {
            if (sub === 'authz-admin-1')
              return { id: sub, email: 'a@x.com', globalRoles: [], name: 'AuthzAdmin' };
            if (sub === 'target-1')
              return { id: sub, email: 't@x.com', globalRoles: [], name: 'Target' };
            return null;
          },
        }),
      }),
    );
    service = new OidcService(cfg as any, 'a'.repeat(32));
    server = createServer(service.callback);
    await new Promise<void>((r) => server.listen(PORT3, r));
    return async () => new Promise<void>((r) => server.close(() => r()));
  });

  async function mintSubjectToken(accountId: string): Promise<string> {
    const provider = (service as any).provider;
    const client = await provider.Client.find('app1');
    const at = new provider.AccessToken({ accountId, client, scope: 'openid profile email' });
    return at.save();
  }

  function tokenRequest(params: Record<string, string>) {
    return fetch(`${ISSUER3}/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from('app1:s').toString('base64')}`,
      },
      body: new URLSearchParams(params).toString(),
    });
  }

  test('ator admin só no resolveTokenRoles (globalRoles vazio) → permitido', async ({ assert }) => {
    const subjectToken = await mintSubjectToken('authz-admin-1');
    const res = await tokenRequest({
      grant_type: TOKEN_EXCHANGE,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      requested_subject: 'target-1',
    });
    assert.equal(res.status, 200);
    const json: any = await res.json();
    assert.equal(json.issued_token_type, ACCESS_TOKEN_TYPE);
    const payload = decodeJwtPayload(json.id_token);
    assert.equal(payload.sub, 'target-1');
    assert.deepEqual(payload.act, { sub: 'authz-admin-1' });
  });

  test('ator SEM a role da allowlist (admin em outro nome) → negado', async ({ assert }) => {
    // `user-1` tem globalRoles ['USER'] e o hook não a marca admin.
    const subjectToken = await mintSubjectToken('target-1');
    const res = await tokenRequest({
      grant_type: TOKEN_EXCHANGE,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      requested_subject: 'target-1',
    });
    assert.equal(res.status, 400);
    const json: any = await res.json();
    assert.equal(json.error, 'invalid_grant');
  });
});
