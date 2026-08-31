import { test } from '@japa/runner';
import {
  getAccountLoginUrl,
  resetAccountLoginUrl,
  setAccountLoginUrl,
} from '../../src/host/account_login_url.js';
import { consoleLoginUrl } from '../../src/host/console_session.js';
import AccountAuthMiddleware, {
  ACCOUNT_SESSION_KEY,
} from '../../src/host/middleware/account_auth.js';

test.group('accountLoginUrl (destino configurável do redirect de login)', (group) => {
  // Singleton de processo — isola cada caso.
  group.each.teardown(() => resetAccountLoginUrl());

  test('default é /account/login', ({ assert }) => {
    assert.equal(getAccountLoginUrl(), '/account/login');
  });

  test('setAccountLoginUrl troca o destino; vazio/whitespace cai no default', ({ assert }) => {
    setAccountLoginUrl('/login');
    assert.equal(getAccountLoginUrl(), '/login');
    setAccountLoginUrl('   ');
    assert.equal(getAccountLoginUrl(), '/account/login');
  });

  test('consoleLoginUrl respeita o destino configurado (com e sem return_to)', ({ assert }) => {
    setAccountLoginUrl('/login');
    assert.equal(consoleLoginUrl(), '/login');
    assert.equal(consoleLoginUrl('/telescope'), '/login?return_to=%2Ftelescope');
  });

  test('consoleLoginUrl usa & quando o destino já tem query', ({ assert }) => {
    setAccountLoginUrl('/login?tenant=acme');
    assert.equal(consoleLoginUrl('/x'), '/login?tenant=acme&return_to=%2Fx');
  });

  test('AccountAuthMiddleware redireciona para o destino configurado quando sem sessão', async ({
    assert,
  }) => {
    setAccountLoginUrl('/login');
    const redirects: string[] = [];
    const ctx = {
      session: { get: (_k: string) => undefined },
      response: { redirect: (u: string) => redirects.push(u) },
    } as any;
    let nextCalled = false;
    await new AccountAuthMiddleware().handle(ctx, async () => {
      nextCalled = true;
    });
    assert.deepEqual(redirects, ['/login']);
    assert.isFalse(nextCalled);
  });

  test('AccountAuthMiddleware chama next quando há sessão', async ({ assert }) => {
    const ctx = {
      session: { get: (k: string) => (k === ACCOUNT_SESSION_KEY ? 'acc-1' : undefined) },
      response: { redirect: () => assert.fail('não deveria redirecionar') },
    } as any;
    let nextCalled = false;
    await new AccountAuthMiddleware().handle(ctx, async () => {
      nextCalled = true;
    });
    assert.isTrue(nextCalled);
  });
});
