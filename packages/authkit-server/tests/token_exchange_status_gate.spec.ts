/**
 * Plan 003 — Step 4: o alvo de um token-exchange (impersonation) desabilitado
 * deve ser recusado. Testado ISOLADAMENTE contra `registerTokenExchange`
 * (capturando o handler registrado num `provider` fake mínimo), em vez de
 * através do harness completo de `tests/token_exchange.spec.ts`
 * (OidcService/oidc_service.ts).
 *
 * HISTÓRICO — o plano 003 deixou `oidc_service.ts` (o ÚNICO call site real de
 * `registerTokenExchange`) fora do seu escopo de arquivos, então o
 * `accountStore` adicionado a `TokenExchangeDeps` NÃO estava fiado em produção
 * e o gate era INERTE no servidor de verdade. O plano 010 fechou esse gap
 * (`accountStore: config.accountStore` em `oidc_service.ts`) e adicionou o
 * grupo de WIRING no fim deste arquivo, que sobe o `OidcService` real. Os três
 * casos abaixo continuam provando só a LÓGICA de `token_exchange.ts`; é o
 * grupo de wiring que prova que ela roda em produção.
 */

import { type Server, createServer } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { adapters, defineConfig } from '../src/define_config.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { registerTokenExchange } from '../src/provider/token_exchange.js';
import { fakeAccountStore as baseAccountStore } from './bootstrap.js';

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

/**
 * Plan 010 — o teste de WIRING (não de comportamento).
 *
 * Os três casos acima constroem o objeto `TokenExchangeDeps` na mão e passam
 * `accountStore` eles mesmos, então passam com ou sem o wiring de produção —
 * foi exatamente assim que o gap sobreviveu ao plano 003. Este grupo sobe o
 * `OidcService` REAL (o único call site de produção de `registerTokenExchange`,
 * em `src/provider/oidc_service.ts`) e bate no endpoint `/token` de verdade.
 * Se `oidc_service.ts` parar de repassar `config.accountStore`, o gate volta a
 * degradar para "allowed" e ESTE teste falha — nenhum dos outros falha.
 */
const WIRING_PORT = 9793;
const WIRING_ISSUER = `http://localhost:${WIRING_PORT}`;

test.group('token-exchange — o gate de status está WIRED no OidcService', (group) => {
  let server: Server;
  let service: OidcService;

  group.setup(async () => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      defineConfig({
        issuer: WIRING_ISSUER,
        adapter: adapters.redis({ connection: 'main' }),
        jwks: { source: 'managed', algorithm: 'RS256' },
        clients: [
          {
            clientId: 'app1',
            clientSecret: 's',
            redirectUris: [`${WIRING_ISSUER}/cb`],
            grants: ['authorization_code', 'refresh_token', TOKEN_EXCHANGE],
          },
        ],
        accountStore: baseAccountStore({
          findById: async (sub: string) => {
            if (sub === 'admin-1')
              return { id: sub, email: 'admin@x.com', globalRoles: ['ADMIN'], name: 'Admin' };
            if (sub === 'disabled-1')
              return { id: sub, email: 'd@x.com', globalRoles: ['USER'], name: 'Disabled' };
            if (sub === 'healthy-1')
              return { id: sub, email: 'h@x.com', globalRoles: ['USER'], name: 'Healthy' };
            return null;
          },
          // AccountStatusCapability: a probe é `typeof store.disableAccount === 'function'`.
          disableAccount: async () => {},
          enableAccount: async () => {},
          isDisabled: async (id: string) => id === 'disabled-1',
        } as any),
      }),
    );
    service = new OidcService(cfg as any, 'a'.repeat(32));
    server = createServer(service.callback);
    await new Promise<void>((r) => server.listen(WIRING_PORT, r));
    return async () => new Promise<void>((r) => server.close(() => r()));
  });

  async function mintSubjectToken(accountId: string): Promise<string> {
    const provider = (service as any).provider;
    const client = await provider.Client.find('app1');
    const at = new provider.AccessToken({ accountId, client, scope: 'openid profile email' });
    return at.save();
  }

  function exchangeFor(subjectToken: string, requestedSubject: string) {
    return fetch(`${WIRING_ISSUER}/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from('app1:s').toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE,
        subject_token: subjectToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        requested_subject: requestedSubject,
        scope: 'openid profile email',
      }).toString(),
    });
  }

  test('impersonar uma conta DESABILITADA pelo servidor real → invalid_grant', async ({
    assert,
  }) => {
    const subjectToken = await mintSubjectToken('admin-1');
    const res = await exchangeFor(subjectToken, 'disabled-1');
    const json: any = await res.json();
    assert.equal(
      res.status,
      400,
      `esperava invalid_grant; o servidor real mintou tokens para uma conta desabilitada — oidc_service.ts provavelmente não está passando accountStore. Body: ${JSON.stringify(json)}`,
    );
    assert.equal(json.error, 'invalid_grant');
    assert.isUndefined(json.access_token);
    assert.isUndefined(json.id_token);
  });

  test('impersonar uma conta saudável pelo servidor real continua funcionando', async ({
    assert,
  }) => {
    const subjectToken = await mintSubjectToken('admin-1');
    const res = await exchangeFor(subjectToken, 'healthy-1');
    const json: any = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.isString(json.access_token);
    assert.isString(json.id_token);
  });
});
