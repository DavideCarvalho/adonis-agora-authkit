import { test } from '@japa/runner';
import { OpaqueResolver } from '../src/resolvers/opaque_resolver.js';

function ctxWithSession(accessToken?: string) {
  return {
    session: { get: () => (accessToken ? { accessToken } : undefined) },
  } as any;
}

function ctxWithBearer(token?: string) {
  return {
    request: {
      header: (n: string) =>
        n.toLowerCase() === 'authorization' && token ? `Bearer ${token}` : undefined,
    },
  } as any;
}

const base = {
  introspectionUrl: async () => 'http://idp/token/introspection',
  clientId: 'app1',
  clientSecret: 's',
  sessionKey: 'authkit',
  globalRolesClaim: 'roles',
};

test.group('OpaqueResolver', () => {
  test('sem access token na sessão → null (não introspecta)', async ({ assert }) => {
    let called = false;
    const r = new OpaqueResolver({
      ...base,
      tokenSource: 'session',
      fetchImpl: async () => {
        called = true;
        return { ok: true, json: async () => ({ active: true }) } as any;
      },
    });
    assert.isNull(await r.resolve(ctxWithSession()));
    assert.isFalse(called);
  });

  test('access token inativo (revogado) → null', async ({ assert }) => {
    const r = new OpaqueResolver({
      ...base,
      tokenSource: 'session',
      fetchImpl: async () => ({ ok: true, json: async () => ({ active: false }) }) as any,
    });
    assert.isNull(await r.resolve(ctxWithSession('at_x')));
  });

  test('access token ativo → Identity + Basic auth com client creds', async ({ assert }) => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = '';
    const r = new OpaqueResolver({
      ...base,
      tokenSource: 'session',
      fetchImpl: async (_url, init) => {
        capturedHeaders = init.headers ?? {};
        capturedBody = init.body ?? '';
        return {
          ok: true,
          json: async () => ({
            active: true,
            sub: 'u1',
            email: 'a@b.com',
            name: 'A',
            picture: 'http://img/u1.png',
            sid: 'sess-1',
            roles: ['ADMIN'],
            exp: 0,
          }),
        } as any;
      },
    });
    const id = await r.resolve(ctxWithSession('at_x'));
    assert.isNotNull(id);
    assert.equal(id!.userId, 'u1');
    assert.equal(id!.email, 'a@b.com');
    assert.deepEqual(id!.globalRoles, ['ADMIN']);
    // Alinhamento com o jwt resolver: picture→avatarUrl, sid→sessionId.
    assert.equal(id!.profile?.avatarUrl, 'http://img/u1.png');
    assert.equal(id!.sessionId, 'sess-1');
    const expectedBasic = `Basic ${Buffer.from('app1:s').toString('base64')}`;
    assert.equal(capturedHeaders.authorization, expectedBasic);
    assert.include(capturedBody, 'token_type_hint=access_token');
  });

  test('tokenSource bearer → introspecta o token do header', async ({ assert }) => {
    let capturedBody = '';
    const r = new OpaqueResolver({
      ...base,
      tokenSource: 'bearer',
      fetchImpl: async (_url, init) => {
        capturedBody = init.body ?? '';
        return { ok: true, json: async () => ({ active: true, sub: 'u2' }) } as any;
      },
    });
    const id = await r.resolve(ctxWithBearer('opaque-123'));
    assert.equal(id!.userId, 'u2');
    assert.include(capturedBody, 'token=opaque-123');
  });

  test('cacheTtlMs>0 → não introspecta de novo dentro da janela', async ({ assert }) => {
    let calls = 0;
    const r = new OpaqueResolver({
      ...base,
      tokenSource: 'session',
      cacheTtlMs: 60_000,
      fetchImpl: async () => {
        calls++;
        return { ok: true, json: async () => ({ active: true, sub: 'u1' }) } as any;
      },
    });
    const ctx = ctxWithSession('at_cache');
    await r.resolve(ctx);
    await r.resolve(ctx);
    assert.equal(calls, 1);
  });

  test('cacheTtlMs>0 → o cache não serve um token além do exp dele', async ({ assert }) => {
    let calls = 0;
    const r = new OpaqueResolver({
      ...base,
      tokenSource: 'session',
      cacheTtlMs: 60_000,
      fetchImpl: async () => {
        calls++;
        const exp = Math.floor(Date.now() / 1000);
        return { ok: true, json: async () => ({ active: true, sub: 'u1', exp }) } as any;
      },
    });
    const ctx = ctxWithSession('at_expiring');
    await r.resolve(ctx);
    await r.resolve(ctx);
    assert.equal(calls, 2);
  });

  test('cacheTtlMs>0 → o cache tem teto de entradas (o mais antigo sai)', async ({ assert }) => {
    const introspected: string[] = [];
    const r = new OpaqueResolver({
      ...base,
      tokenSource: 'session',
      cacheTtlMs: 60_000,
      fetchImpl: async (_url: string, init: any) => {
        introspected.push(new URLSearchParams(init.body).get('token')!);
        return { ok: true, json: async () => ({ active: true, sub: 'u1' }) } as any;
      },
    });
    for (let i = 0; i <= 10_000; i++) await r.resolve(ctxWithSession(`at_${i}`));
    introspected.length = 0;

    await r.resolve(ctxWithSession('at_10000'));
    await r.resolve(ctxWithSession('at_1'));
    assert.deepEqual(introspected, []);
    await r.resolve(ctxWithSession('at_0'));
    assert.deepEqual(introspected, ['at_0']);
  });
});
