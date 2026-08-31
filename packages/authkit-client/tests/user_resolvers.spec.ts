import { createServer, type Server } from 'node:http';
import type { Identity } from '@adonis-agora/authkit-core';
import { test } from '@japa/runner';
import { Authenticator } from '../src/authenticator.js';
import { createUserinfoResolver, identityToUser } from '../src/user_resolvers.js';

const identity: Identity = {
  userId: 'u1',
  email: 'a@b.com',
  globalRoles: ['ADMIN'],
  profile: { name: 'Ana', avatarUrl: 'http://img/a.png' },
  issuedAt: 0,
  expiresAt: 0,
  raw: {},
};

test.group('identityToUser', () => {
  test('mapeia claims para um usuário simples', ({ assert }) => {
    assert.deepEqual(identityToUser(identity), {
      id: 'u1',
      email: 'a@b.com',
      name: 'Ana',
      avatarUrl: 'http://img/a.png',
      globalRoles: ['ADMIN'],
    });
  });

  test('lida com perfil ausente', ({ assert }) => {
    const u = identityToUser({ ...identity, profile: undefined });
    assert.equal(u.name, undefined);
    assert.equal(u.avatarUrl, undefined);
    assert.equal(u.id, 'u1');
  });
});

test.group('createUserinfoResolver', (group) => {
  let server: Server;
  let baseUrl: string;

  group.setup(async () => {
    server = createServer((req, res) => {
      const auth = req.headers.authorization;
      if (req.url === '/me' && auth === 'Bearer at-123') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'u1', email: 'a@b.com', department: 'Letras' }));
        return;
      }
      res.writeHead(401);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  group.teardown(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('busca userinfo com o bearer e mescla com a identidade', async ({ assert }) => {
    const resolve = createUserinfoResolver({ issuer: baseUrl });
    const user = (await resolve(identity, { accessToken: 'at-123' })) as Record<string, unknown>;
    assert.equal(user.department, 'Letras');
    assert.equal(user.id, 'u1');
    assert.equal(user.email, 'a@b.com');
    // base de identityToUser preservada
    assert.deepEqual(user.globalRoles, ['ADMIN']);
  });

  test('usa userinfoEndpoint explícito quando fornecido', async ({ assert }) => {
    const resolve = createUserinfoResolver({ userinfoEndpoint: `${baseUrl}/me` });
    const user = (await resolve(identity, { accessToken: 'at-123' })) as Record<string, unknown>;
    assert.equal(user.department, 'Letras');
  });

  test('sem accessToken faz fallback para claims (identityToUser)', async ({ assert }) => {
    const resolve = createUserinfoResolver({ issuer: baseUrl });
    const user = await resolve(identity, {});
    assert.deepEqual(user, identityToUser(identity));
  });

  test('lança em resposta não-ok', async ({ assert }) => {
    const resolve = createUserinfoResolver({ issuer: baseUrl });
    await assert.rejects(() => resolve(identity, { accessToken: 'wrong' }));
  });
});

test.group('Authenticator passa accessToken ao resolveUser', () => {
  test('repassa o token do getAccessToken', async ({ assert }) => {
    let seen: { accessToken?: string } | undefined;
    const auth = new Authenticator({} as any, {
      resolver: { resolve: async () => identity } as any,
      getAccessToken: () => 'at-xyz',
      resolveUser: async (_id, ctx) => {
        seen = ctx;
        return { id: 'u1' };
      },
    });
    await auth.getUser();
    assert.equal(seen?.accessToken, 'at-xyz');
  });

  test('callback de 1 argumento (legado) continua funcionando', async ({ assert }) => {
    const legacy = async (id: Identity) => ({ id: id.userId });
    const auth = new Authenticator({} as any, {
      resolver: { resolve: async () => identity } as any,
      resolveUser: legacy as any,
    });
    assert.deepEqual(await auth.getUser(), { id: 'u1' });
  });
});
