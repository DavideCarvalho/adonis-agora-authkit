/**
 * Plan 003 — mesma checagem que `account_status_gate.spec.ts`, mas para o
 * callback do login social (`AuthSocialController#callback`). Este era o
 * caminho MAIS desprotegido de todos: nenhuma auditoria de falha existia
 * aqui antes desta mudança (nem para o caso "sem e-mail").
 */

import { test } from '@japa/runner';
import AuthSocialController from '../../src/host/controllers/social_controller.js';

const PROVIDER = 'google';
const ACCOUNT_ID = 'acc-1';
const EMAIL = 'user@example.com';

function makeStore(opts: { disabled?: boolean } = {}) {
  const account = { id: ACCOUNT_ID, email: EMAIL, name: 'Test User', globalRoles: ['USER'] };
  return {
    findById: async (id: string) => (id === account.id ? account : null),
    findByProviderIdentity: async () => account,
    linkProviderIdentity: async () => {},
    disableAccount: async () => {},
    enableAccount: async () => {},
    isDisabled: async () => opts.disabled === true,
  } as any;
}

function buildService(store: any) {
  const completeLoginCalls: any[] = [];
  const config: any = { accountStore: store };
  const interactions = {
    completeLogin: async (...args: any[]) => {
      completeLoginCalls.push(args);
    },
  };
  return { service: { config, interactions }, completeLoginCalls };
}

function fakeCtx(
  service: any,
  session: Record<string, unknown> = { authkit_social_uid: 'test-uid' },
) {
  const redirects: string[] = [];
  return {
    containerResolver: {
      make: async (key: string) => {
        if (key === 'authkit.server') return service;
        throw new Error(`unknown: ${key}`);
      },
    },
    request: { param: (_k: string) => PROVIDER },
    session: {
      get: (k: string) => session[k],
      forget: (k: string) => {
        delete session[k];
      },
    },
    ally: {
      use: (_name: string) => ({
        accessDenied: () => false,
        stateMisMatch: () => false,
        hasError: () => false,
        user: async () => ({ id: 'provider-uid-1', email: EMAIL, name: 'Test User' }),
      }),
    },
    response: {
      redirect: (url: string) => {
        redirects.push(url);
      },
    },
    __redirects: redirects,
  } as any;
}

test.group('account status gate — social login callback', () => {
  test('conta desabilitada: NÃO completa o login, redireciona de volta ao login', async ({
    assert,
  }) => {
    const store = makeStore({ disabled: true });
    const { service, completeLoginCalls } = buildService(store);
    const ctx = fakeCtx(service);

    await new AuthSocialController().callback(ctx);

    assert.lengthOf(completeLoginCalls, 0);
    assert.deepEqual(ctx.__redirects, ['/auth/interaction/test-uid']);
  });

  test('conta saudável: completa o login normalmente', async ({ assert }) => {
    const store = makeStore({ disabled: false });
    const { service, completeLoginCalls } = buildService(store);
    const ctx = fakeCtx(service);

    await new AuthSocialController().callback(ctx);

    assert.lengthOf(completeLoginCalls, 1);
    assert.equal(completeLoginCalls[0][1], ACCOUNT_ID);
  });

  test('store sem a capacidade de status: degrada para "allowed" (login prossegue)', async ({
    assert,
  }) => {
    const account = { id: ACCOUNT_ID, email: EMAIL, name: 'Test User', globalRoles: ['USER'] };
    const store = {
      findById: async (id: string) => (id === account.id ? account : null),
      findByProviderIdentity: async () => account,
      linkProviderIdentity: async () => {},
    } as any;
    const { service, completeLoginCalls } = buildService(store);
    const ctx = fakeCtx(service);

    await new AuthSocialController().callback(ctx);

    assert.lengthOf(completeLoginCalls, 1);
  });
});
