import { test } from '@japa/runner';
import {
  authorizeByToken,
  type ConsoleAuthorizer,
  normalizeConsoleAuthorizeResult,
  resolveConsoleAuthorize,
} from '../src/console_authorize.js';

/** Minimal ctx: `containerResolver.make` builds the class with an injected dependency. */
function fakeCtx(made: unknown[] = []) {
  const audit = { name: 'audit' };
  return {
    audit,
    ctx: {
      user: 'u1',
      containerResolver: {
        make: async (Cls: any) => {
          made.push(Cls);
          return new Cls(audit);
        },
      },
    } as any,
  };
}

test.group('normalizeConsoleAuthorizeResult', () => {
  test('every result shape', ({ assert }) => {
    assert.deepEqual(normalizeConsoleAuthorizeResult(true), { allowed: true });
    assert.deepEqual(normalizeConsoleAuthorizeResult({ allowed: true }), { allowed: true });
    assert.deepEqual(normalizeConsoleAuthorizeResult(false), { allowed: false, status: 403 });
    assert.deepEqual(normalizeConsoleAuthorizeResult({ allowed: false }), {
      allowed: false,
      status: 403,
    });
    assert.deepEqual(normalizeConsoleAuthorizeResult({ allowed: false, reason: 'forbidden' }), {
      allowed: false,
      status: 403,
    });
    assert.deepEqual(
      normalizeConsoleAuthorizeResult({ allowed: false, reason: 'unauthenticated' }),
      { allowed: false, status: 401 },
    );
    assert.deepEqual(normalizeConsoleAuthorizeResult({ redirectTo: '/login' }), {
      allowed: false,
      status: 401,
      redirectTo: '/login',
    });
    assert.deepEqual(normalizeConsoleAuthorizeResult(undefined), { allowed: false, status: 403 });
    assert.deepEqual(normalizeConsoleAuthorizeResult('yes'), { allowed: false, status: 403 });
  });
});

test.group('resolveConsoleAuthorize', () => {
  test('inline function receives ctx', async ({ assert }) => {
    const { ctx } = fakeCtx();
    const check = resolveConsoleAuthorize(async (c: any) => c.user === 'u1');
    assert.deepEqual(await check(ctx), { allowed: true });
    const deny = resolveConsoleAuthorize(
      () => ({ allowed: false, reason: 'unauthenticated' }) as const,
    );
    assert.deepEqual(await deny(ctx), { allowed: false, status: 401 });
  });

  test('class is built through the container (DI)', async ({ assert }) => {
    class Access implements ConsoleAuthorizer {
      constructor(private audit: { name: string }) {}
      authorize() {
        return this.audit.name === 'audit';
      }
    }
    const made: unknown[] = [];
    const { ctx } = fakeCtx(made);
    const check = resolveConsoleAuthorize(Access);
    assert.deepEqual(await check(ctx), { allowed: true });
    assert.deepEqual(made, [Access]);
  });

  test('lazy import runs once and its class is built through the container', async ({ assert }) => {
    class Access implements ConsoleAuthorizer {
      constructor(private audit: { name: string }) {}
      async authorize() {
        return this.audit ? { redirectTo: '/elsewhere' } : false;
      }
    }
    let imports = 0;
    const made: unknown[] = [];
    const { ctx } = fakeCtx(made);
    const check = resolveConsoleAuthorize(async () => {
      imports++;
      return { default: Access };
    });
    const expected = { allowed: false, status: 401, redirectTo: '/elsewhere' };
    assert.deepEqual(await check(ctx), expected);
    assert.deepEqual(await check(ctx), expected);
    assert.equal(imports, 1);
    assert.deepEqual(made, [Access, Access]);
  });

  test('a thrown error is a denial', async ({ assert }) => {
    const { ctx } = fakeCtx();
    const warnings: unknown[] = [];
    ctx.logger = { warn: (...args: unknown[]) => warnings.push(args) };
    const fn = resolveConsoleAuthorize(() => {
      throw new Error('boom');
    });
    assert.deepEqual(await fn(ctx), { allowed: false, status: 403 });
    class Broken implements ConsoleAuthorizer {
      authorize(): boolean {
        throw new Error('boom');
      }
    }
    assert.deepEqual(await resolveConsoleAuthorize(Broken)(ctx), { allowed: false, status: 403 });
    const lazy = resolveConsoleAuthorize(async () => {
      throw new Error('import failed');
    });
    assert.deepEqual(await lazy(ctx), { allowed: false, status: 403 });
    assert.lengthOf(warnings, 3);
  });
});

test.group('authorizeByToken', () => {
  const withAuth = (value?: string) =>
    ({ request: { header: (n: string) => (n === 'authorization' ? value : undefined) } }) as any;

  test('allows the matching bearer token', ({ assert }) => {
    const authorize = authorizeByToken({ token: 's3cret' });
    assert.deepEqual(authorize(withAuth('Bearer s3cret')), { allowed: true });
    assert.deepEqual(authorize(withAuth('bearer s3cret')), { allowed: true });
  });

  test('anything else is unauthenticated', ({ assert }) => {
    const authorize = authorizeByToken({ token: 's3cret' });
    const denied = { allowed: false, reason: 'unauthenticated' };
    assert.deepEqual(authorize(withAuth('Bearer s3cre')), denied);
    assert.deepEqual(authorize(withAuth('Bearer s3cretX')), denied);
    assert.deepEqual(authorize(withAuth('s3cret')), denied);
    assert.deepEqual(authorize(withAuth('Basic s3cret')), denied);
    assert.deepEqual(authorize(withAuth(undefined)), denied);
  });

  test('an empty or missing token throws at config time', ({ assert }) => {
    assert.throws(() => authorizeByToken({ token: '' }), /token/);
    assert.throws(() => authorizeByToken({ token: undefined }), /token/);
  });

  test('is a ConsoleAuthorize the resolver accepts', async ({ assert }) => {
    const check = resolveConsoleAuthorize(authorizeByToken({ token: 't' }));
    assert.deepEqual(await check(withAuth('Bearer t')), { allowed: true });
    assert.deepEqual(await check(withAuth()), { allowed: false, status: 401 });
  });
});
