import { test } from '@japa/runner';
import AccountAuthMiddleware from '../../src/host/middleware/account_auth.js';
import { adminGuard, wantsJson } from '../../src/host/register_auth_host.js';

/** A request with no console session; `accept` decides what the caller prefers. */
function anonymousCtx(accept: 'json' | 'html', roles: string[] = []) {
  const sent: { status?: number; body?: unknown; redirect?: string } = {};
  const config = {
    admin: { enabled: true, roles: ['ADMIN'] },
    accountSession: { acceptIdpSession: false },
    accountStore: { findById: async () => ({ id: 'u1', email: 'a@b.c', globalRoles: roles }) },
  };
  const ctx: any = {
    containerResolver: { make: async () => ({ config }) },
    session: { get: () => undefined, put() {}, forget() {} },
    request: {
      accepts: (types: string[]) => (accept === 'json' ? 'json' : types[0]),
      url: () => '/admin/api/users',
      header: () => undefined,
    },
    response: {
      status(code: number) {
        sent.status = code;
        return this;
      },
      send(body: unknown) {
        sent.body = body;
        return body;
      },
      redirect(url: string) {
        sent.redirect = url;
      },
    },
  };
  return { ctx, sent };
}

test.group('JSON callers without a session', () => {
  test('wantsJson follows the Accept preference', ({ assert }) => {
    assert.isTrue(wantsJson(anonymousCtx('json').ctx));
    assert.isFalse(wantsJson(anonymousCtx('html').ctx));
  });

  test('admin API: 401 for JSON, the login redirect for a page', async ({ assert }) => {
    const json = anonymousCtx('json');
    await adminGuard(json.ctx, async () => {});
    assert.equal(json.sent.status, 401);
    assert.equal((json.sent.body as any).error.code, 'unauthenticated');
    assert.isUndefined(json.sent.redirect);

    const page = anonymousCtx('html');
    await adminGuard(page.ctx, async () => {});
    assert.isUndefined(page.sent.status);
    assert.match(page.sent.redirect!, /\/account\/login/);
  });

  test('AccountAuthMiddleware: 401 for JSON, the login redirect for a page', async ({ assert }) => {
    const middleware = new AccountAuthMiddleware();
    const json = anonymousCtx('json');
    await middleware.handle(json.ctx, async () => {});
    assert.equal(json.sent.status, 401);

    const page = anonymousCtx('html');
    await middleware.handle(page.ctx, async () => {});
    assert.match(page.sent.redirect!, /\/account\/login/);
  });
});
