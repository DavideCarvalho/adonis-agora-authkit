import { test } from '@japa/runner';
import { setBearerAccountId, setBearerImpersonation } from '../src/host/bearer_account.js';
import { getAccountId, realAccountId } from '../src/host/console_session.js';
import {
  impersonationState,
  rememberAccessToken,
  startImpersonation,
} from '../src/host/impersonation_session.js';
import { ACCOUNT_SESSION_KEY } from '../src/host/middleware/account_auth.js';
import { OidcService } from '../src/provider/oidc_service.js';

/**
 * ctx falso com uma sessão in-memory (get/put/forget/regenerate) — mesmo harness
 * de `impersonation_session.spec.ts`, para que a impersonation seja montada pelo
 * `startImpersonation` REAL em vez de keys colocadas na mão.
 */
function makeCtx(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  const ctx = {
    session: {
      get: (k: string) => store[k],
      put: (k: string, v: unknown) => {
        store[k] = v;
      },
      forget: (k: string) => {
        delete store[k];
      },
      regenerate: async () => {},
    },
  } as any;
  return { ctx, store };
}

/** fetch mock que responde 200 (token-exchange OK). */
function fetchOk(): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'target-at', id_token: 'jwt' }),
  })) as any;
}

test.group('console_session — realAccountId', () => {
  test('sem sessão retorna null', ({ assert }) => {
    const { ctx } = makeCtx({});
    assert.isNull(realAccountId(ctx), 'sessão vazia não tem humano por trás do request');

    // Tolerante a um ctx sem `session` (mesma garantia do `getAccountId`).
    const ctxSemSession = {} as any;
    assert.isNull(realAccountId(ctxSemSession));
  });

  test('sem impersonation retorna a conta logada', ({ assert }) => {
    const { ctx } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    assert.equal(realAccountId(ctx), 'admin-1');
    // Sem impersonation os dois helpers coincidem — é só aí que coincidem.
    assert.equal(realAccountId(ctx), getAccountId(ctx));
  });

  test('com impersonation ativa retorna o IMPERSONATOR, nunca o alvo', async ({ assert }) => {
    // Dois ids bem distintos: uma implementação errada não pode acertar por acaso.
    const IMPERSONATOR = 'admin-real-1';
    const TARGET = 'target-victim-9';

    const { ctx } = makeCtx({ [ACCOUNT_SESSION_KEY]: IMPERSONATOR });
    rememberAccessToken(ctx, 'admin-access-token');
    await startImpersonation(ctx, {
      targetId: TARGET,
      issuer: 'http://idp.local',
      clientId: 'app1',
      fetchImpl: fetchOk(),
    });

    // Pré-condição: a impersonation está de fato ativa e `getAccountId` já
    // devolve o ALVO — é exatamente esse valor que não pode vazar para um
    // role check.
    assert.equal(getAccountId(ctx), TARGET, 'pré-condição: getAccountId devolve o alvo');

    assert.equal(realAccountId(ctx), IMPERSONATOR, 'deve devolver o admin real');
    assert.notEqual(
      realAccountId(ctx),
      TARGET,
      'NUNCA o alvo: um role check com o id do alvo entrega ao personificado os privilégios do admin',
    );
  });
});

test.group('console_session — bindBearerAccount (bearer verificado fora do guard)', () => {
  // O método não usa estado do service: chamado direto no prototype, sem montar um provider.
  const bind = (ctx: object, id: string) =>
    OidcService.prototype.bindBearerAccount.call({} as any, ctx, id);

  test('getAccountId e realAccountId veem a conta vinculada', ({ assert }) => {
    const { ctx } = makeCtx({});
    assert.isNull(getAccountId(ctx), 'pré-condição: sem sessão nem bearer');
    bind(ctx, 'acct-mcp-1');
    assert.equal(getAccountId(ctx), 'acct-mcp-1');
    assert.equal(realAccountId(ctx), 'acct-mcp-1');
    assert.deepEqual(impersonationState(ctx), { active: false });
  });

  test('o vínculo é por request (outro ctx não vê a conta)', ({ assert }) => {
    const { ctx } = makeCtx({});
    const { ctx: other } = makeCtx({});
    bind(ctx, 'acct-mcp-1');
    assert.isNull(getAccountId(other));
  });

  test('a sessão do console continua ganhando', ({ assert }) => {
    const { ctx } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'session-acct' });
    bind(ctx, 'acct-mcp-1');
    assert.equal(getAccountId(ctx), 'session-acct');
    assert.equal(realAccountId(ctx), 'session-acct');
  });

  test('esquece uma impersonation bearer anterior: o chamador não está personificando', ({
    assert,
  }) => {
    const { ctx } = makeCtx({});
    setBearerAccountId(ctx, 'target-9');
    setBearerImpersonation(ctx, { actorId: 'admin-1', exp: null, jti: null });
    assert.isTrue(impersonationState(ctx).active, 'pré-condição: impersonation bearer ativa');

    bind(ctx, 'acct-mcp-1');
    assert.isFalse(impersonationState(ctx).active);
    assert.equal(realAccountId(ctx), 'acct-mcp-1');
  });
});
