import { test } from '@japa/runner';
import {
  impersonationState,
  refreshAccessToken,
  rememberAccessToken,
  rememberRefreshToken,
  startImpersonation,
  stopImpersonation,
} from '../src/host/impersonation_session.js';
import { ACCOUNT_SESSION_KEY } from '../src/host/middleware/account_auth.js';
import { isSudoActive, markSudo } from '../src/host/sudo_mode.js';

/**
 * ctx falso com uma sessão in-memory (get/put/forget/regenerate). `regenerate`
 * imita o Adonis: rotaciona o id (contamos as chamadas) e MANTÉM os dados.
 */
function makeCtx(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  let regenerated = 0;
  const ctx = {
    session: {
      get: (k: string) => store[k],
      put: (k: string, v: unknown) => {
        store[k] = v;
      },
      forget: (k: string) => {
        delete store[k];
      },
      regenerate: async () => {
        regenerated++;
      },
    },
  } as any;
  return { ctx, store, regenerated: () => regenerated };
}

/** fetch mock que responde 200 (exchange OK) e registra as chamadas. */
function fetchOk(calls: Array<{ url: string; body: string }>): typeof fetch {
  return (async (url: any, init: any) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'target-at', id_token: 'jwt' }),
    };
  }) as any;
}

/** fetch mock que responde erro (exchange REJEITADO pelo IdP, ex.: não-admin). */
function fetchErr(status = 400): typeof fetch {
  return (async () => ({
    ok: false,
    status,
    json: async () => ({ error: 'invalid_grant' }),
  })) as any;
}

function baseParams(overrides: Partial<Parameters<typeof startImpersonation>[1]> = {}) {
  return {
    targetId: 'target-1',
    issuer: 'http://idp.local',
    clientId: 'app1',
    ...overrides,
  };
}

test.group('impersonation_session — happy path', () => {
  test('start troca a sessão pro alvo, guarda o impersonator e regenera', async ({ assert }) => {
    const { ctx, store, regenerated } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    rememberAccessToken(ctx, 'admin-access-token');

    const calls: Array<{ url: string; body: string }> = [];
    await startImpersonation(ctx, baseParams({ fetchImpl: fetchOk(calls) }));

    assert.equal(store[ACCOUNT_SESSION_KEY], 'target-1');
    assert.equal(store.impersonator_user_id, 'admin-1');
    assert.equal(regenerated(), 1, 'deve regenerar a sessão (anti-fixation)');

    // O exchange foi roteado pelo token endpoint com os params RFC 8693 corretos.
    assert.lengthOf(calls, 1);
    assert.equal(calls[0].url, 'http://idp.local/token');
    const sent = new URLSearchParams(calls[0].body);
    assert.equal(sent.get('grant_type'), 'urn:ietf:params:oauth:grant-type:token-exchange');
    assert.equal(sent.get('subject_token'), 'admin-access-token');
    assert.equal(sent.get('subject_token_type'), 'urn:ietf:params:oauth:token-type:access_token');
    assert.equal(sent.get('requested_subject'), 'target-1');
    assert.equal(sent.get('client_id'), 'app1');
  });

  test('start honra tokenEndpoint, scope e clientSecret quando fornecidos', async ({ assert }) => {
    const { ctx } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    rememberAccessToken(ctx, 'admin-access-token');

    const calls: Array<{ url: string; body: string }> = [];
    await startImpersonation(
      ctx,
      baseParams({
        fetchImpl: fetchOk(calls),
        tokenEndpoint: 'http://idp.local/oauth/token',
        scope: 'openid profile',
        clientSecret: 'shhh',
      }),
    );

    assert.equal(calls[0].url, 'http://idp.local/oauth/token');
    const sent = new URLSearchParams(calls[0].body);
    assert.equal(sent.get('scope'), 'openid profile');
    assert.equal(sent.get('client_secret'), 'shhh');
  });

  test('stop restaura o admin, limpa as keys e regenera', async ({ assert }) => {
    const { ctx, store, regenerated } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    rememberAccessToken(ctx, 'admin-access-token');
    await startImpersonation(ctx, baseParams({ fetchImpl: fetchOk([]) }));

    await stopImpersonation(ctx);

    assert.equal(store[ACCOUNT_SESSION_KEY], 'admin-1', 'account volta a ser o admin');
    assert.isUndefined(store.impersonator_user_id);
    assert.equal(store.admin_access_token, 'admin-access-token', 'token do admin preservado');
    assert.equal(regenerated(), 2, 'regenera no start e no stop');
  });
});

test.group('impersonation_session — invariante 1: exchange falho não troca a sessão', () => {
  test('exchange rejeitado (não-admin) LANÇA e não altera a sessão', async ({ assert }) => {
    const { ctx, store, regenerated } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    rememberAccessToken(ctx, 'admin-access-token');

    await assert.rejects(() => startImpersonation(ctx, baseParams({ fetchImpl: fetchErr(400) })));

    assert.equal(store[ACCOUNT_SESSION_KEY], 'admin-1', 'account_user_id intacto');
    assert.isUndefined(store.impersonator_user_id, 'nenhum impersonator gravado');
    assert.equal(regenerated(), 0, 'sessão não regenerada');
    assert.isFalse(impersonationState(ctx).active);
  });
});

test.group('impersonation_session — refresh token renova access expirado', () => {
  /** fetch mock: 1º exchange falha (400 = token expirado), refresh responde, 2º exchange ok. */
  function fetchRefreshThenOk(calls: Array<{ url: string; body: string }>): typeof fetch {
    let exchangeAttempt = 0;
    return (async (url: any, init: any) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      const body = new URLSearchParams(String(init?.body ?? ''));
      const isExchange =
        body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:token-exchange';
      if (isExchange && exchangeAttempt++ === 0) {
        return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) } as any;
      }
      if (body.get('grant_type') === 'refresh_token') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'fresh-admin-at', refresh_token: 'rotated-rt' }),
        } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'target-at', id_token: 'jwt' }),
      } as any;
    }) as any;
  }

  test('start com access expirado renova via refresh e personifica', async ({ assert }) => {
    const { ctx, store, regenerated } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    rememberAccessToken(ctx, 'admin-access-token');
    rememberRefreshToken(ctx, 'admin-refresh-token');

    const calls: Array<{ url: string; body: string }> = [];
    await startImpersonation(ctx, baseParams({ fetchImpl: fetchRefreshThenOk(calls) }));

    assert.equal(store[ACCOUNT_SESSION_KEY], 'target-1', 'personificou o alvo');
    assert.equal(store.impersonator_user_id, 'admin-1');
    assert.equal(regenerated(), 1, 'regenerou no start');

    // Ordem: exchange (falha 400) → refresh → exchange (ok).
    assert.lengthOf(calls, 3);
    const grants = calls.map((c) => new URLSearchParams(c.body).get('grant_type'));
    assert.equal(grants[0], 'urn:ietf:params:oauth:grant-type:token-exchange');
    assert.equal(grants[1], 'refresh_token');
    assert.equal(grants[2], 'urn:ietf:params:oauth:grant-type:token-exchange');
    assert.equal(new URLSearchParams(calls[1].body).get('refresh_token'), 'admin-refresh-token');

    // O token renovado foi regravado na sessão (subject_token do 2º exchange).
    assert.equal(new URLSearchParams(calls[2].body).get('subject_token'), 'fresh-admin-at');
    assert.equal(store.admin_access_token, 'fresh-admin-at');
    assert.equal(store.admin_refresh_token, 'rotated-rt', 'refresh rotacionado regravado');
  });

  test('start sem refresh token propaga o erro de exchange expirado', async ({ assert }) => {
    const { ctx } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    rememberAccessToken(ctx, 'admin-access-token');
    // sem rememberRefreshToken

    await assert.rejects(
      () => startImpersonation(ctx, baseParams({ fetchImpl: fetchErr(400) })),
      /Token exchange failed: 400/,
    );
  });

  test('refreshAccessToken renova e rotaciona o refresh token', async ({ assert }) => {
    const { ctx, store } = makeCtx({});
    rememberRefreshToken(ctx, 'rt-1');
    const calls: Array<{ url: string; body: string }> = [];

    const result = await refreshAccessToken(ctx, {
      issuer: 'http://idp.local',
      clientId: 'app1',
      fetchImpl: fetchRefreshThenOk(calls),
    });

    assert.equal(result?.accessToken, 'fresh-admin-at');
    assert.equal(result?.refreshToken, 'rotated-rt');
    const sent = new URLSearchParams(calls[0].body);
    assert.equal(sent.get('grant_type'), 'refresh_token');
    assert.equal(sent.get('refresh_token'), 'rt-1');
  });
});

test.group('impersonation_session — invariante 2: impersonation aninhada é recusada', () => {
  test('start com uma impersonation já ativa LANÇA e não altera estado', async ({ assert }) => {
    const { ctx, store, regenerated } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    rememberAccessToken(ctx, 'admin-access-token');
    await startImpersonation(ctx, baseParams({ targetId: 'target-1', fetchImpl: fetchOk([]) }));

    const regenBefore = regenerated();
    const calls: Array<{ url: string; body: string }> = [];
    await assert.rejects(() =>
      startImpersonation(ctx, baseParams({ targetId: 'target-2', fetchImpl: fetchOk(calls) })),
    );

    assert.equal(store[ACCOUNT_SESSION_KEY], 'target-1', 'ainda personificando o primeiro alvo');
    assert.equal(store.impersonator_user_id, 'admin-1');
    assert.equal(regenerated(), regenBefore, 'sessão não regenerada de novo');
    assert.lengthOf(calls, 0, 'exchange nem foi chamado');
  });

  test('start sem access token do admin LANÇA e não troca nada', async ({ assert }) => {
    const { ctx, store, regenerated } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    // sem rememberAccessToken

    const calls: Array<{ url: string; body: string }> = [];
    await assert.rejects(() => startImpersonation(ctx, baseParams({ fetchImpl: fetchOk(calls) })));

    assert.equal(store[ACCOUNT_SESSION_KEY], 'admin-1');
    assert.isUndefined(store.impersonator_user_id);
    assert.equal(regenerated(), 0);
    assert.lengthOf(calls, 0, 'não deve tentar o exchange sem subject_token');
  });

  test('start sem admin logado (sem account_user_id) LANÇA e não troca nada', async ({
    assert,
  }) => {
    const { ctx, store, regenerated } = makeCtx({}); // sem account_user_id
    rememberAccessToken(ctx, 'admin-access-token');

    const calls: Array<{ url: string; body: string }> = [];
    await assert.rejects(() => startImpersonation(ctx, baseParams({ fetchImpl: fetchOk(calls) })));

    assert.isUndefined(store[ACCOUNT_SESSION_KEY]);
    assert.isUndefined(store.impersonator_user_id);
    assert.equal(regenerated(), 0);
    assert.lengthOf(calls, 0, 'não deve tentar o exchange sem admin logado');
  });
});

test.group('impersonation_session — invariante 3: stop limpa a impersonation', () => {
  test('stop restaura exatamente o impersonatorId e remove só a key de impersonation', async ({
    assert,
  }) => {
    const { ctx, store } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-9' });
    rememberAccessToken(ctx, 'admin-access-token');
    await startImpersonation(ctx, baseParams({ targetId: 'target-7', fetchImpl: fetchOk([]) }));

    assert.equal(store[ACCOUNT_SESSION_KEY], 'target-7');
    await stopImpersonation(ctx);

    assert.equal(store[ACCOUNT_SESSION_KEY], 'admin-9');
    assert.isUndefined(store.impersonator_user_id);
    // O admin_access_token (do ADMIN) é preservado: permite personificar de
    // novo sem relogar. Ele é do admin — não do alvo — e o logout do app
    // (`ctx.session.clear()`) continua limpando tudo.
    assert.equal(store.admin_access_token, 'admin-access-token');
    // nenhuma outra key de impersonation deve permanecer
    assert.notProperty(store, 'impersonator_user_id');
  });

  test('stop → start de novo funciona (admin_access_token preservado)', async ({ assert }) => {
    const { ctx, store } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-9' });
    rememberAccessToken(ctx, 'admin-access-token');

    // 1ª personificação
    await startImpersonation(ctx, baseParams({ targetId: 'target-7', fetchImpl: fetchOk([]) }));
    assert.equal(store[ACCOUNT_SESSION_KEY], 'target-7');

    // sair
    await stopImpersonation(ctx);
    assert.equal(store[ACCOUNT_SESSION_KEY], 'admin-9');

    // 2ª personificação SEM relogin — o token do admin ainda está na sessão
    await startImpersonation(ctx, baseParams({ targetId: 'target-8', fetchImpl: fetchOk([]) }));
    assert.equal(store[ACCOUNT_SESSION_KEY], 'target-8');
    assert.equal(store.impersonator_user_id, 'admin-9');
  });

  test('stop sem impersonation ativa é no-op (não lança, não regenera)', async ({ assert }) => {
    const { ctx, store, regenerated } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    await stopImpersonation(ctx);
    assert.equal(store[ACCOUNT_SESSION_KEY], 'admin-1');
    assert.equal(regenerated(), 0);
  });
});

test.group('impersonation_session — invariante 4: tokens nunca são logados', () => {
  test('nem o access token nem o corpo do erro aparecem nos logs do console', async ({
    assert,
  }) => {
    const { ctx } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    const SECRET = 'super-secret-access-token-xyz';

    const logged: string[] = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const originals = methods.map((m) => console[m]);
    for (const m of methods) {
      // biome/prettier: substitui temporariamente cada método de log
      (console as any)[m] = (...args: unknown[]) => {
        logged.push(args.map((a) => String(a)).join(' '));
      };
    }
    try {
      rememberAccessToken(ctx, SECRET);
      // caminho de sucesso
      await startImpersonation(ctx, baseParams({ fetchImpl: fetchOk([]) }));
      await stopImpersonation(ctx);

      // caminho de erro (o mais provável de ecoar segredos)
      const { ctx: ctx2 } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
      rememberAccessToken(ctx2, SECRET);
      await assert.rejects(() =>
        startImpersonation(ctx2, baseParams({ fetchImpl: fetchErr(401) })),
      );
    } finally {
      methods.forEach((m, i) => {
        (console as any)[m] = originals[i];
      });
    }

    const all = logged.join('\n');
    assert.notInclude(all, SECRET, 'o access token nunca deve ser logado');
  });
});

test.group('impersonation_session — invariante 5: impersonationState reflete o estado', () => {
  test('inativo antes do start; ativo com target/impersonator depois; inativo após stop', async ({
    assert,
  }) => {
    const { ctx } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    rememberAccessToken(ctx, 'admin-access-token');

    const before = impersonationState(ctx);
    assert.deepEqual(before, { active: false });

    await startImpersonation(ctx, baseParams({ targetId: 'target-1', fetchImpl: fetchOk([]) }));
    const during = impersonationState(ctx);
    assert.isTrue(during.active);
    assert.equal(during.targetId, 'target-1');
    assert.equal(during.impersonatorId, 'admin-1');
    // Registro da impersonation: id único + instante do start (o mock
    // `fetchOk` não devolve `act`/`expires_in`, então ficam ausentes).
    assert.match(during.impersonationId ?? '', /^[0-9a-f-]{36}$/);
    assert.isNumber(during.startedAt);
    assert.isUndefined(during.expiresAt);
    assert.isUndefined(during.actSub);
    assert.isUndefined(during.exchangeExpiresIn);

    await stopImpersonation(ctx);
    const after = impersonationState(ctx);
    assert.deepEqual(after, { active: false });
  });
});

test.group(
  'impersonation_session — invariante 6: a marca de sudo não atravessa a troca de conta',
  () => {
    test('start NÃO carrega o sudo do admin para a conta personificada', async ({ assert }) => {
      const { ctx, store } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
      rememberAccessToken(ctx, 'admin-access-token');

      // O admin confirmou o sudo sobre a PRÓPRIA conta, agora mesmo.
      markSudo(ctx);
      assert.isTrue(isSudoActive(ctx, 15), 'pré-condição: o admin tem sudo sobre a própria conta');

      await startImpersonation(ctx, baseParams({ targetId: 'target-1', fetchImpl: fetchOk([]) }));

      // ESCALAÇÃO DE PRIVILÉGIO: entrar personificando com a graça já aberta daria
      // ao admin exportar/excluir dados, mexer em MFA e emitir PATs da conta alheia
      // sem nunca ter confirmado identidade COMO ela.
      assert.equal(store[ACCOUNT_SESSION_KEY], 'target-1');
      assert.isFalse(
        isSudoActive(ctx, 15),
        'o sudo do admin não pode valer sobre a conta personificada',
      );
    });

    test('stop NÃO devolve para o admin o sudo obtido enquanto personificava', async ({
      assert,
    }) => {
      const { ctx, store } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
      rememberAccessToken(ctx, 'admin-access-token');

      await startImpersonation(ctx, baseParams({ targetId: 'target-1', fetchImpl: fetchOk([]) }));

      // Sudo confirmado ENQUANTO personificava: vale para a conta personificada.
      markSudo(ctx);
      assert.isTrue(isSudoActive(ctx, 15), 'pré-condição: sudo ativo sobre a conta personificada');

      await stopImpersonation(ctx);

      assert.equal(store[ACCOUNT_SESSION_KEY], 'admin-1');
      assert.isFalse(
        isSudoActive(ctx, 15),
        'o sudo obtido personificando não pode valer sobre o admin',
      );
    });

    test('stop preserva o sudo que o admin já tinha sobre a própria conta', async ({ assert }) => {
      const { ctx } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
      rememberAccessToken(ctx, 'admin-access-token');

      // Confirmação legítima do admin, sobre a conta do admin, antes de personificar.
      markSudo(ctx);

      await startImpersonation(ctx, baseParams({ targetId: 'target-1', fetchImpl: fetchOk([]) }));
      await stopImpersonation(ctx);

      // Intencional: é a confirmação dele, sobre a conta dele, dentro da janela
      // dele. Limpar aqui (abordagem "forget nas transições") custaria uma
      // reconfirmação sem ganho de segurança.
      assert.isTrue(isSudoActive(ctx, 15));
    });
  },
);

test.group('impersonation_session — registro (id, tempos, prova do exchange)', () => {
  /** fetch mock com `expires_in` + `act` na resposta do exchange. */
  function fetchOkFull(): typeof fetch {
    return (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'target-at', expires_in: 3600, act: { sub: 'admin-1' } }),
    })) as any;
  }

  /** fetch mock 200 com corpo fora de JSON (parse tolerante). */
  function fetchOkNoJson(): typeof fetch {
    return (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token');
      },
    })) as any;
  }

  function auditSink(events: Array<any>) {
    return {
      record: async (e: any) => {
        events.push(e);
      },
    };
  }

  test('start devolve o estado criado e aproveita act/expires_in do exchange', async ({
    assert,
  }) => {
    const { ctx, store } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    rememberAccessToken(ctx, 'admin-access-token');

    const created = await startImpersonation(ctx, baseParams({ fetchImpl: fetchOkFull() }));

    assert.isTrue(created.active);
    assert.match(created.impersonationId ?? '', /^[0-9a-f-]{36}$/, 'id único por start');
    assert.isNumber(created.startedAt);
    assert.equal(created.actSub, 'admin-1', 'ator provado pelo IdP');
    assert.equal(created.exchangeExpiresIn, 3600);
    assert.isUndefined(created.expiresAt, 'sem maxAge não há expiração');

    // Mesmo registro gravado na sessão (contrato que `impersonationState` lê).
    assert.equal(store.impersonation_id, created.impersonationId);
    assert.equal(store.impersonation_started_at, created.startedAt);
    assert.equal(store.impersonation_act_sub, 'admin-1');
    assert.equal(store.impersonation_exchange_expires_in, 3600);
    assert.isUndefined(store.impersonation_expires_at);
    assert.deepEqual(impersonationState(ctx), created);
  });

  test('cada start gera um id diferente', async ({ assert }) => {
    const { ctx } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    rememberAccessToken(ctx, 'admin-access-token');

    const first = await startImpersonation(ctx, baseParams({ fetchImpl: fetchOk([]) }));
    await stopImpersonation(ctx);
    const second = await startImpersonation(ctx, baseParams({ fetchImpl: fetchOk([]) }));

    assert.notEqual(first.impersonationId, second.impersonationId);
  });

  test('exchange 200 sem JSON válido ainda personifica (metadados ausentes)', async ({
    assert,
  }) => {
    const { ctx, store } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    rememberAccessToken(ctx, 'admin-access-token');

    const created = await startImpersonation(ctx, baseParams({ fetchImpl: fetchOkNoJson() }));

    assert.equal(store[ACCOUNT_SESSION_KEY], 'target-1');
    assert.isTrue(created.active);
    assert.isUndefined(created.actSub);
    assert.isUndefined(created.exchangeExpiresIn);
  });

  test('maxAge grava expiresAt e o estado segue ativo dentro do prazo', async ({ assert }) => {
    const { ctx, store } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    rememberAccessToken(ctx, 'admin-access-token');

    const before = Date.now();
    const created = await startImpersonation(
      ctx,
      baseParams({ fetchImpl: fetchOk([]), maxAge: 3600 }),
    );

    assert.isNumber(created.expiresAt);
    assert.approximately(created.expiresAt!, before + 3600 * 1000, 5000);
    assert.equal(store.impersonation_expires_at, created.expiresAt);
    assert.isTrue(impersonationState(ctx).active);
  });

  test('maxAge não-positivo LANÇA sem tocar a sessão', async ({ assert }) => {
    const { ctx, store, regenerated } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    rememberAccessToken(ctx, 'admin-access-token');

    await assert.rejects(() =>
      startImpersonation(ctx, baseParams({ fetchImpl: fetchOk([]), maxAge: 0 })),
    );

    assert.equal(store[ACCOUNT_SESSION_KEY], 'admin-1');
    assert.isUndefined(store.impersonator_user_id);
    assert.equal(regenerated(), 0);
  });

  test('expiração é preguiçosa: prazo vencido lê active:false mas o stop restaura', async ({
    assert,
  }) => {
    const { ctx, store } = makeCtx({
      [ACCOUNT_SESSION_KEY]: 'target-1',
      impersonator_user_id: 'admin-1',
      impersonation_id: 'imp-expired-1',
      impersonation_started_at: Date.now() - 7200 * 1000,
      impersonation_expires_at: Date.now() - 3600 * 1000,
    });

    const state = impersonationState(ctx);
    assert.isFalse(state.active, 'prazo vencido não é mais ativo');
    assert.equal(state.impersonationId, 'imp-expired-1', 'ids seguem legíveis');

    // Expirar NÃO libera novo start sozinho (encerrar continua explícito).
    rememberAccessToken(ctx, 'admin-access-token');
    await assert.rejects(() => startImpersonation(ctx, baseParams({ fetchImpl: fetchOk([]) })));

    const events: Array<any> = [];
    const stopped = await stopImpersonation(ctx, { audit: auditSink(events) });
    assert.equal(store[ACCOUNT_SESSION_KEY], 'admin-1', 'stop expirado restaura o admin');
    assert.equal(stopped?.impersonationId, 'imp-expired-1');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'impersonation.stopped');
    assert.isTrue(events[0].metadata.expired, 'audit marca que já estava expirada');
  });

  test('stop audita impersonation.stopped com o id e limpa TODAS as keys', async ({ assert }) => {
    const { ctx, store } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    rememberAccessToken(ctx, 'admin-access-token');
    const created = await startImpersonation(ctx, baseParams({ fetchImpl: fetchOkFull() }));

    const events: Array<any> = [];
    const stopped = await stopImpersonation(ctx, { audit: auditSink(events), ip: '10.0.0.1' });

    assert.equal(stopped?.impersonationId, created.impersonationId);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'impersonation.stopped');
    assert.equal(events[0].actorId, 'admin-1');
    assert.equal(events[0].accountId, 'target-1');
    assert.equal(events[0].ip, '10.0.0.1');
    assert.equal(events[0].metadata.impersonationId, created.impersonationId);
    assert.isFalse(events[0].metadata.expired);

    for (const key of [
      'impersonator_user_id',
      'impersonation_id',
      'impersonation_started_at',
      'impersonation_expires_at',
      'impersonation_act_sub',
      'impersonation_exchange_expires_in',
    ]) {
      assert.notProperty(store, key, `${key} deve sumir no stop`);
    }
  });

  test('stop sem impersonation ativa é no-op: devolve null e não audita', async ({ assert }) => {
    const { ctx, regenerated } = makeCtx({ [ACCOUNT_SESSION_KEY]: 'admin-1' });
    const events: Array<any> = [];

    const stopped = await stopImpersonation(ctx, { audit: auditSink(events) });

    assert.isNull(stopped);
    assert.lengthOf(events, 0);
    assert.equal(regenerated(), 0);
  });
});
