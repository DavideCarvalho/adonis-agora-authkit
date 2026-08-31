import { test } from '@japa/runner';
import { ACCOUNT_SESSION_KEY } from '../../src/host/middleware/account_auth.js';
import {
  isSudoActive,
  markSudo,
  requireSudo,
  resolveEffectiveSudoMode,
  SUDO_ACCOUNT_SESSION_KEY,
  SUDO_MODE_DEFAULTS,
  SUDO_SESSION_KEY,
} from '../../src/host/sudo_mode.js';

const ACCOUNT_ID = 'acc-1';

// ---- helpers ----

function fakeSettings(val: unknown) {
  return {
    async getSetting(_key: string) {
      return val;
    },
    async setSetting() {},
    async deleteSetting() {},
    async listSettings() {
      return [];
    },
  };
}

/**
 * Contexto HTTP mínimo para testes de sessão.
 *
 * A sessão já vem com uma conta logada (`accountId`, default `ACCOUNT_ID`)
 * porque a marca de sudo é VINCULADA à conta que a confirmou: `sudoAt` sozinho
 * não concede nada. Use `sudoAccountId` para simular a marca de OUTRA conta.
 */
function fakeCtx(
  opts: {
    sudoAt?: number;
    returnUrl?: string;
    accountId?: string | null;
    sudoAccountId?: string;
  } = {},
) {
  const sessionData: Record<string, unknown> = {};
  const accountId = opts.accountId === undefined ? ACCOUNT_ID : opts.accountId;
  if (accountId !== null) sessionData[ACCOUNT_SESSION_KEY] = accountId;
  if (opts.sudoAt !== undefined) {
    sessionData[SUDO_SESSION_KEY] = opts.sudoAt;
    sessionData[SUDO_ACCOUNT_SESSION_KEY] = opts.sudoAccountId ?? accountId;
  }

  const redirectUrl: string[] = [];
  return {
    session: {
      get: (key: string) => sessionData[key],
      put: (key: string, val: unknown) => {
        sessionData[key] = val;
      },
      forget: (key: string) => {
        delete sessionData[key];
      },
      _data: sessionData,
    },
    request: {
      url: () => opts.returnUrl ?? '/account/security',
      parsedUrl: { search: '' },
    },
    response: {
      _redirectTo: null as string | null,
      redirect: (url: string) => {
        redirectUrl.push(url);
        return { _redirected: url };
      },
      _history: redirectUrl,
    },
  };
}

// ---- tests ----

test.group('isSudoActive', () => {
  test('retorna false quando não há timestamp na sessão', ({ assert }) => {
    const ctx = fakeCtx();
    assert.isFalse(isSudoActive(ctx as any, 15));
  });

  test('retorna true dentro da janela de graça', ({ assert }) => {
    const now = Date.now();
    const ctx = fakeCtx({ sudoAt: now - 5 * 60 * 1000 }); // 5 min atrás
    assert.isTrue(isSudoActive(ctx as any, 15));
  });

  test('retorna false após vencer a janela de graça', ({ assert }) => {
    const now = Date.now();
    const ctx = fakeCtx({ sudoAt: now - 20 * 60 * 1000 }); // 20 min atrás (> 15)
    assert.isFalse(isSudoActive(ctx as any, 15));
  });

  test('graceMinutes=0: sempre requer confirmação', ({ assert }) => {
    const now = Date.now();
    const ctx = fakeCtx({ sudoAt: now - 100 }); // quase agora
    assert.isFalse(isSudoActive(ctx as any, 0));
  });

  // ---- vinculação à conta (escalação de privilégio) ----

  test('sudo confirmado pela conta A NÃO vale para a conta B na mesma sessão', ({ assert }) => {
    // A confirma o sudo e a marca fica válida para A.
    const ctx = fakeCtx({ sudoAt: Date.now() - 1000, accountId: 'conta-a' });
    assert.isTrue(isSudoActive(ctx as any, 15));

    // A sessão troca de conta (logout de A + login de B num navegador
    // compartilhado, ou impersonation): o `regenerate()` MIGRA os dados, então
    // a marca de A sobrevive. Ela NÃO pode valer para B.
    ctx.session._data[ACCOUNT_SESSION_KEY] = 'conta-b';
    assert.isFalse(isSudoActive(ctx as any, 15));
  });

  test('marca sem vinculação é recusada (fail-closed)', ({ assert }) => {
    // Sessão viva de antes do deploy que introduziu a vinculação: só timestamp.
    const ctx = fakeCtx({ sudoAt: Date.now() - 1000 });
    delete ctx.session._data[SUDO_ACCOUNT_SESSION_KEY];
    assert.isFalse(isSudoActive(ctx as any, 15));
  });

  test('marca vinculada não vale sem conta logada', ({ assert }) => {
    const ctx = fakeCtx({ sudoAt: Date.now() - 1000, accountId: null, sudoAccountId: 'conta-a' });
    assert.isFalse(isSudoActive(ctx as any, 15));
  });
});

test.group('markSudo', () => {
  test('persiste o timestamp de confirmação na sessão', ({ assert }) => {
    const ctx = fakeCtx();
    const before = Date.now();
    markSudo(ctx as any);
    const after = Date.now();
    const stored = ctx.session._data[SUDO_SESSION_KEY] as number;
    assert.isNumber(stored);
    assert.isAtLeast(stored, before);
    assert.isAtMost(stored, after);
  });

  test('vincula a marca à conta logada', ({ assert }) => {
    const ctx = fakeCtx({ accountId: 'conta-a' });
    markSudo(ctx as any);
    assert.equal(ctx.session._data[SUDO_ACCOUNT_SESSION_KEY], 'conta-a');
    assert.isTrue(isSudoActive(ctx as any, 15));
  });

  test('sem conta logada, apaga a vinculação anterior (marca órfã, recusada)', ({ assert }) => {
    const ctx = fakeCtx({ accountId: null });
    ctx.session._data[SUDO_ACCOUNT_SESSION_KEY] = 'dono-antigo';

    markSudo(ctx as any);

    assert.isUndefined(ctx.session._data[SUDO_ACCOUNT_SESSION_KEY]);
    assert.isFalse(isSudoActive(ctx as any, 15));
  });
});

test.group('requireSudo', () => {
  test('retorna true quando sudo está ativo (dentro da graça)', async ({ assert }) => {
    const now = Date.now();
    const ctx = fakeCtx({ sudoAt: now - 1000 }); // 1s atrás
    const settings = fakeSettings({ enabled: true, graceMinutes: 15 });
    const result = await requireSudo(ctx as any, settings as any);
    assert.isTrue(result);
  });

  test('redireciona quando sudo NÃO está ativo (fora da graça)', async ({ assert }) => {
    const ctx = fakeCtx({ returnUrl: '/account/security', sudoAt: undefined });
    const settings = fakeSettings({ enabled: true, graceMinutes: 15 });
    const result = await requireSudo(ctx as any, settings as any);
    // Deve retornar o resultado do redirect (não true)
    assert.notStrictEqual(result, true);
    assert.equal(ctx.response._history[0], '/account/confirm?return_to=%2Faccount%2Fsecurity');
  });

  test('return_to é codificado corretamente na URL', async ({ assert }) => {
    const ctx = fakeCtx({ returnUrl: '/account/security/email', sudoAt: undefined });
    const settings = fakeSettings({ enabled: true, graceMinutes: 15 });
    await requireSudo(ctx as any, settings as any);
    const redirect = ctx.response._history[0];
    assert.isTrue(redirect.includes('return_to='));
    assert.isTrue(redirect.includes('%2Faccount%2Fsecurity%2Femail'));
  });

  test('retorna true quando sudo_mode está desligado (enabled=false)', async ({ assert }) => {
    const ctx = fakeCtx(); // sem sudo na sessão
    const settings = fakeSettings({ enabled: false, graceMinutes: 15 });
    const result = await requireSudo(ctx as any, settings as any);
    assert.isTrue(result);
  });

  test('retorna true quando settings é null (fail-safe)', async ({ assert }) => {
    const ctx = fakeCtx();
    const result = await requireSudo(ctx as any, null);
    // Com settings null, usa SUDO_MODE_DEFAULTS (enabled=true, 15 min)
    // Mas sem timestamp → redireciona
    assert.notStrictEqual(result, true);
  });

  test('fail-safe: erro ao resolver settings → usa defaults (enabled=true) → redireciona sem timestamp', async ({
    assert,
  }) => {
    const ctx = fakeCtx(); // sem sudo na sessão
    const errorSettings = {
      async getSetting() {
        throw new Error('db error');
      },
      async setSetting() {},
      async deleteSetting() {},
      async listSettings() {
        return [];
      },
    };
    // resolveEffectiveSudoMode já faz fail-safe e retorna defaults (enabled=true, grace=15)
    // Sem timestamp na sessão → requireSudo redireciona
    const result = await requireSudo(ctx as any, errorSettings as any);
    assert.notStrictEqual(result, true);
    assert.isTrue(ctx.response._history[0].includes('/account/confirm'));
  });

  test('timestamp expirado (fora da graça): redireciona para confirm', async ({ assert }) => {
    const now = Date.now();
    const ctx = fakeCtx({ sudoAt: now - 30 * 60 * 1000, returnUrl: '/account/security' }); // 30 min
    const settings = fakeSettings({ enabled: true, graceMinutes: 15 });
    const result = await requireSudo(ctx as any, settings as any);
    assert.notStrictEqual(result, true);
    assert.isTrue(ctx.response._history[0].includes('/account/confirm'));
  });
});

test.group('resolveEffectiveSudoMode', () => {
  test('defaults quando setting ausente', async ({ assert }) => {
    const s = fakeSettings(null);
    const resolved = await resolveEffectiveSudoMode(s as any);
    assert.deepEqual(resolved, SUDO_MODE_DEFAULTS);
  });

  test('usa valores da setting quando presentes', async ({ assert }) => {
    const s = fakeSettings({ enabled: false, graceMinutes: 30 });
    const resolved = await resolveEffectiveSudoMode(s as any);
    assert.deepEqual(resolved, { enabled: false, graceMinutes: 30 });
  });

  test('graceMinutes=0 é válido (sempre pede confirmação)', async ({ assert }) => {
    const s = fakeSettings({ enabled: true, graceMinutes: 0 });
    const resolved = await resolveEffectiveSudoMode(s as any);
    assert.equal(resolved.graceMinutes, 0);
  });

  test('campos inválidos → usa defaults', async ({ assert }) => {
    const s = fakeSettings({ enabled: 'yes', graceMinutes: -5 });
    const resolved = await resolveEffectiveSudoMode(s as any);
    assert.equal(resolved.enabled, SUDO_MODE_DEFAULTS.enabled);
    assert.equal(resolved.graceMinutes, SUDO_MODE_DEFAULTS.graceMinutes);
  });

  test('fail-safe: erro em getSetting → defaults', async ({ assert }) => {
    const s = {
      async getSetting() {
        throw new Error('db error');
      },
      async setSetting() {},
      async deleteSetting() {},
      async listSettings() {
        return [];
      },
    };
    const resolved = await resolveEffectiveSudoMode(s as any);
    assert.deepEqual(resolved, SUDO_MODE_DEFAULTS);
  });
});
