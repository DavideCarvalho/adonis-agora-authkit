/**
 * Plan 003 — Step 4: o alvo de um token-exchange (impersonation) desabilitado
 * deve ser recusado. Testado ISOLADAMENTE contra `registerTokenExchange`
 * (capturando o handler registrado num `provider` fake mínimo), em vez de
 * através do harness completo de `tests/token_exchange.spec.ts`
 * (OidcService/oidc_service.ts).
 *
 * IMPORTANTE (ver relatório do executor): `oidc_service.ts` — o ÚNICO call
 * site real de `registerTokenExchange` — está FORA do escopo de arquivos
 * deste plano. Isso significa que o parâmetro `accountStore` adicionado a
 * `TokenExchangeDeps` (e checado aqui) NÃO está fiado em produção: o wiring
 * real em `oidc_service.ts:158` precisa de uma linha a mais
 * (`accountStore: config.accountStore`) para ativar esta checagem no servidor
 * de verdade. Este teste prova que a LÓGICA em `token_exchange.ts` está
 * correta; não prova que o gap de produção foi fechado — ele não foi, ainda.
 */

import { test } from '@japa/runner';
import { registerTokenExchange } from '../src/provider/token_exchange.js';

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

function fakeProvider(subjectTokens: Record<string, { clientId: string; accountId: string }>) {
  let handler: ((ctx: any) => Promise<void>) | undefined;
  const provider: any = {
    registerGrantType: (_name: string, h: any) => {
      handler = h;
    },
    AccessToken: {
      find: async (token: string) => {
        const found = subjectTokens[token];
        return found ? { ...found, isExpired: false } : null;
      },
    },
  };
  return {
    provider,
    invoke: (ctx: any) => {
      if (!handler) throw new Error('grant type not registered');
      return handler(ctx);
    },
  };
}

function fakeAccountStore(opts: { disabled: boolean }) {
  return {
    disableAccount: async () => {},
    enableAccount: async () => {},
    isDisabled: async () => opts.disabled,
  } as any;
}

test.group('token-exchange (impersonation) — account status gate', () => {
  test('alvo desabilitado: invalid_grant, id_token NUNCA é mintado', async ({ assert }) => {
    const { provider, invoke } = fakeProvider({
      'subj-tok': { clientId: 'app1', accountId: 'admin-1' },
    });
    let mintCalled = false;
    // `new provider.AccessToken(...)` só é alcançado DEPOIS do gate — se este
    // teste passar sem essa classe funcional, confirma que o gate interrompe
    // ANTES da mintagem.
    class BoomAccessToken {
      constructor() {
        mintCalled = true;
        throw new Error('should not reach minting for a disabled target');
      }
    }
    provider.AccessToken = Object.assign(BoomAccessToken, { find: provider.AccessToken.find });

    registerTokenExchange(provider, {
      findAccount: async (sub: string) => {
        if (sub === 'admin-1') return { id: sub, email: 'admin@x.com', globalRoles: ['ADMIN'] };
        if (sub === 'target-1') return { id: sub, email: 't@x.com', globalRoles: ['USER'] };
        return null;
      },
      globalRolesClaim: 'roles',
      accountStore: fakeAccountStore({ disabled: true }),
    });

    const ctx = {
      oidc: {
        params: {
          subject_token: 'subj-tok',
          subject_token_type: ACCESS_TOKEN_TYPE,
          requested_subject: 'target-1',
        },
        client: { clientId: 'app1' },
      },
      req: { socket: { remoteAddress: '1.2.3.4' } },
    };

    let caught: any;
    try {
      await invoke(ctx);
    } catch (err) {
      caught = err;
    }
    assert.exists(caught, 'esperava que o handler rejeitasse');
    assert.equal(caught.error, 'invalid_grant');
    assert.include(String(caught.error_detail), 'disabled');
    assert.isFalse(mintCalled, 'não deveria ter chegado a mintar um access token');
  });

  test('alvo saudável: prossegue (gate não bloqueia)', async ({ assert }) => {
    const { provider, invoke } = fakeProvider({
      'subj-tok': { clientId: 'app1', accountId: 'admin-1' },
    });
    class FakeAccessToken {
      accountId: string;
      client: any;
      scope: string;
      constructor(opts: any) {
        this.accountId = opts.accountId;
        this.client = opts.client;
        this.scope = opts.scope;
      }
      async save() {
        return 'minted-at';
      }
    }
    provider.AccessToken = Object.assign(FakeAccessToken, { find: provider.AccessToken.find });
    let issued = false;
    provider.IdToken = class {
      scope = '';
      set() {}
      async issue() {
        issued = true;
        return 'fake.jwt.token';
      }
    };

    registerTokenExchange(provider, {
      findAccount: async (sub: string) => {
        if (sub === 'admin-1') return { id: sub, email: 'admin@x.com', globalRoles: ['ADMIN'] };
        if (sub === 'target-1') return { id: sub, email: 't@x.com', globalRoles: ['USER'] };
        return null;
      },
      globalRolesClaim: 'roles',
      accountStore: fakeAccountStore({ disabled: false }),
    });

    const ctx = {
      oidc: {
        params: {
          subject_token: 'subj-tok',
          subject_token_type: ACCESS_TOKEN_TYPE,
          requested_subject: 'target-1',
        },
        client: { clientId: 'app1', scope: '' },
      },
      req: { socket: { remoteAddress: '1.2.3.4' } },
      body: undefined as any,
    };

    await invoke(ctx);
    assert.isTrue(issued);
    assert.equal(ctx.body.access_token, 'minted-at');
  });

  test('sem accountStore nos deps (não wired): degrada para "allowed" (comportamento pré-fix)', async ({
    assert,
  }) => {
    const { provider, invoke } = fakeProvider({
      'subj-tok': { clientId: 'app1', accountId: 'admin-1' },
    });
    class FakeAccessToken {
      constructor(public opts: any) {}
      async save() {
        return 'minted-at';
      }
    }
    provider.AccessToken = Object.assign(FakeAccessToken, { find: provider.AccessToken.find });
    provider.IdToken = class {
      scope = '';
      set() {}
      async issue() {
        return 'fake.jwt.token';
      }
    };

    registerTokenExchange(provider, {
      findAccount: async (sub: string) => {
        if (sub === 'admin-1') return { id: sub, email: 'admin@x.com', globalRoles: ['ADMIN'] };
        if (sub === 'target-1') return { id: sub, email: 't@x.com', globalRoles: ['USER'] };
        return null;
      },
      globalRolesClaim: 'roles',
      // accountStore OMITIDO de propósito — mesma situação de hoje em
      // oidc_service.ts, que ainda não passa este campo (ver nota no topo).
    });

    const ctx = {
      oidc: {
        params: {
          subject_token: 'subj-tok',
          subject_token_type: ACCESS_TOKEN_TYPE,
          requested_subject: 'target-1',
        },
        client: { clientId: 'app1', scope: '' },
      },
      req: { socket: { remoteAddress: '1.2.3.4' } },
      body: undefined as any,
    };

    await invoke(ctx);
    assert.equal(ctx.body.access_token, 'minted-at');
  });
});
