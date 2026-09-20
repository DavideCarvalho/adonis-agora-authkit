/**
 * Account Self-Service JSON API — SEGUNDO FATOR
 * (`AccountMfaApiController`, rotas `POST /account/api/mfa/*`).
 *
 * O que estes testes protegem, além do caminho feliz: que o espelho JSON tenha
 * os MESMOS gates do console HTML, e que ele nunca navegue o browser —
 *
 *   - sem sessão → 401; store sem MFA/passkeys → 422 `capability_unsupported`;
 *   - `enroll`, `disable`, `recovery-codes` e o `verify` de passkey exigem SUDO
 *     e recusam com `403 sudo_required` (nunca com um redirect para
 *     `/account/confirm`, que numa SPA chega como HTML onde ela espera JSON);
 *   - `confirm` NÃO exige sudo — é o passo seguinte do `enroll`, que já exigiu;
 *   - código TOTP errado → 422 `invalid_code`, sem ligar o MFA e sem trocar o
 *     segredo pendente (o usuário já escaneou o QR);
 *   - a cerimônia de passkey QUEIMA o desafio em qualquer desfecho, e o slot da
 *     sessão é o MESMO do caminho clássico.
 *
 * Estilo do `account_api_orgs_write.spec.ts`: store em memória + fake
 * HttpContext, sem roteador real. `make('lucid.db')` rejeita → a setting
 * `sudo_mode` cai no default (ligado), que é o cenário que interessa testar.
 */

import { test } from '@japa/runner';
import type { AccountStore } from '../../src/accounts/account_store.js';
import AccountMfaApiController from '../../src/host/account_api/account_mfa_api_controller.js';
import { ACCOUNT_SESSION_KEY } from '../../src/host/middleware/account_auth.js';
import { PASSKEY_REG_CHALLENGE_KEY } from '../../src/host/passkey_registration_challenge.js';
import { SUDO_ACCOUNT_SESSION_KEY, SUDO_SESSION_KEY } from '../../src/host/sudo_mode.js';

const USER = 'acc-1';

// ─── Stores em memória ───────────────────────────────────────────────────────

/** Base sem NENHUMA capacidade opcional — o piso do `AccountStore`. */
function baseStore(): AccountStore & Record<string, any> {
  return {
    findById: async (id: string) => (id === USER ? { id: USER, email: 'u@e.com' } : null),
    findByEmail: async () => null,
    verifyCredentials: async () => null,
    create: async () => ({ id: USER, email: 'u@e.com', globalRoles: [] }) as any,
    issuePasswordResetToken: async () => null,
    consumePasswordResetToken: async () => false,
    issueEmailVerificationToken: async () => null,
    consumeEmailVerificationToken: async () => false,
    listAccounts: async () => ({ data: [], total: 0 }),
    setGlobalRoles: async () => {},
  } as any;
}

/**
 * Store com MFA completo. `enrolled`/`enabled` são visíveis no objeto para os
 * testes afirmarem sobre o EFEITO (o MFA ligou? o segredo pendente mudou?), e
 * não só sobre o status HTTP.
 */
function mfaStore(
  opts: { enabled?: boolean; regenerable?: boolean; codeAccepted?: string } = {},
): AccountStore & Record<string, any> {
  const state = {
    enabled: opts.enabled ?? false,
    pendingSecret: null as string | null,
    recoveryCodes: opts.enabled ? ['old-1', 'old-2'] : ([] as string[]),
    enrollCalls: 0,
  };
  const store: any = {
    ...baseStore(),
    _state: state,

    // ── MfaCapability ── (`getMfaState` é o probe de `supportsMfa`)
    getMfaState: async () => ({ enabled: state.enabled, enabledAt: state.enabled ? 1 : null }),
    startTotpEnrollment: async () => {
      state.enrollCalls += 1;
      state.pendingSecret = `SECRET-${state.enrollCalls}`;
      return {
        secret: state.pendingSecret,
        otpauthUri: `otpauth://totp/AuthKit:u@e.com?secret=${state.pendingSecret}`,
      };
    },
    confirmTotpEnrollment: async (_id: string, code: string) => {
      if (code !== (opts.codeAccepted ?? '123456')) return { ok: false as const };
      state.enabled = true;
      state.recoveryCodes = ['new-1', 'new-2'];
      return { ok: true as const, recoveryCodes: state.recoveryCodes };
    },
    verifyTotp: async () => false,
    consumeRecoveryCode: async () => false,
    disableMfa: async () => {
      state.enabled = false;
      state.pendingSecret = null;
      state.recoveryCodes = [];
    },
  };

  if (opts.regenerable !== false) {
    store.countRecoveryCodes = async () => (state.enabled ? state.recoveryCodes.length : null);
    store.regenerateRecoveryCodes = async () => {
      if (!state.enabled) return null;
      state.recoveryCodes = ['regen-1', 'regen-2', 'regen-3'];
      return state.recoveryCodes;
    };
  }
  return store;
}

/** Store com passkeys (a cerimônia de registro). */
function passkeyStore(opts: { verifies?: boolean; options?: boolean } = {}) {
  const store: any = { ...baseStore(), _registered: [] as unknown[] };
  store.listPasskeys = async () => [];
  store.generatePasskeyRegistrationOptions = async () =>
    opts.options === false
      ? null
      : { options: { challenge: 'chal-1', rp: {} }, challenge: 'chal-1' };
  store.verifyPasskeyRegistration = async (_id: string, _body: unknown, challenge: string) => {
    if (opts.verifies === false) return false;
    store._registered.push(challenge);
    return true;
  };
  return store;
}

// ─── Config + fake ctx ───────────────────────────────────────────────────────

function buildCfg(store: AccountStore) {
  const events: any[] = [];
  return {
    accountStore: store,
    issuer: 'https://idp.test',
    messages: {},
    audit: { events, record: async (e: any) => events.push(e) },
    mail: {},
  } as any;
}

function fakeCtx(opts: {
  actorId?: string;
  /** Marca de sudo ATIVA e vinculada à conta (o par timestamp + conta). */
  sudo?: boolean;
  session?: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  cfg: any;
}) {
  let status = 200;
  let body: any;

  const session = new Map<string, unknown>(Object.entries(opts.session ?? {}));
  if (opts.actorId) session.set(ACCOUNT_SESSION_KEY, opts.actorId);
  if (opts.sudo) {
    session.set(SUDO_SESSION_KEY, Date.now());
    session.set(SUDO_ACCOUNT_SESSION_KEY, opts.actorId);
  }

  const setBody = (b: any) => {
    body = b;
    return b;
  };
  const err = (code: number) => (payload?: any) => {
    status = code;
    return setBody(payload);
  };

  const ctx: any = {
    request: {
      input: (k: string, def?: unknown) => opts.inputs?.[k] ?? def,
      param: () => undefined,
      body: () => opts.inputs ?? {},
      header: () => undefined,
      ip: () => '203.0.113.7',
      url: () => '/account/api/mfa/totp/enroll',
      parsedUrl: { search: '' },
      protocol: () => 'https',
      host: () => 'idp.test',
      secure: () => true,
    },
    response: {
      status: (s: number) => {
        status = s;
        return { send: setBody };
      },
      send: setBody,
      forbidden: err(403),
      notFound: err(404),
      unauthorized: err(401),
      badRequest: err(400),
      unprocessableEntity: err(422),
      redirect: () => {
        throw new Error('o caminho JSON NUNCA deve redirecionar');
      },
    },
    session: {
      get: (k: string) => session.get(k),
      put: (k: string, v: unknown) => session.set(k, v),
      forget: (k: string) => session.delete(k),
      flash: () => {},
    },
    logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    containerResolver: {
      make: async (name: string) => {
        if (name === 'lucid.db') throw new Error('no db in test');
        if (name === 'authkit.server') return { config: opts.cfg };
        throw new Error(`unknown binding: ${name}`);
      },
    },
  };

  return {
    ctx,
    captured: { status: () => status, body: () => body, session },
  };
}

// ─── enroll ──────────────────────────────────────────────────────────────────

test.group('AccountMfaApiController — POST /account/api/mfa/totp/enroll', () => {
  test('com sudo → segredo, otpauth URI e QR data-url', async ({ assert }) => {
    const store = mfaStore();
    const { ctx, captured } = fakeCtx({ actorId: USER, sudo: true, cfg: buildCfg(store) });

    const result: any = await new AccountMfaApiController().enrollTotp(ctx);

    assert.equal(captured.status(), 200);
    assert.equal(result.secret, 'SECRET-1');
    assert.match(result.otpauthUri, /^otpauth:\/\/totp\//);
    assert.match(result.qrDataUrl, /^data:image\/png;base64,/);
  });

  test('SEM sudo → 403 sudo_required e nenhum enrolamento começa', async ({ assert }) => {
    const store = mfaStore();
    const { ctx, captured } = fakeCtx({ actorId: USER, cfg: buildCfg(store) });

    await new AccountMfaApiController().enrollTotp(ctx);

    assert.equal(captured.status(), 403);
    assert.equal(captured.body().error.code, 'sudo_required');
    assert.equal(store._state.enrollCalls, 0);
  });

  test('marca de sudo de OUTRA conta não vale (fail-closed) → 403', async ({ assert }) => {
    const store = mfaStore();
    const { ctx, captured } = fakeCtx({
      actorId: USER,
      cfg: buildCfg(store),
      // Timestamp fresco, mas vinculado a outra conta.
      session: { [SUDO_SESSION_KEY]: Date.now(), [SUDO_ACCOUNT_SESSION_KEY]: 'outra-conta' },
    });

    await new AccountMfaApiController().enrollTotp(ctx);

    assert.equal(captured.status(), 403);
    assert.equal(store._state.enrollCalls, 0);
  });

  test('sem sessão → 401', async ({ assert }) => {
    const { ctx, captured } = fakeCtx({ cfg: buildCfg(mfaStore()) });
    await new AccountMfaApiController().enrollTotp(ctx);
    assert.equal(captured.status(), 401);
  });

  test('store sem MFA → 422 capability_unsupported', async ({ assert }) => {
    const { ctx, captured } = fakeCtx({ actorId: USER, sudo: true, cfg: buildCfg(baseStore()) });
    await new AccountMfaApiController().enrollTotp(ctx);
    assert.equal(captured.status(), 422);
    assert.equal(captured.body().error.code, 'capability_unsupported');
  });
});

// ─── confirm ─────────────────────────────────────────────────────────────────

test.group('AccountMfaApiController — POST /account/api/mfa/totp/confirm', () => {
  test('código certo → MFA ligado, recovery codes uma única vez e auditoria', async ({
    assert,
  }) => {
    const store = mfaStore();
    const cfg = buildCfg(store);
    const { ctx, captured } = fakeCtx({
      actorId: USER,
      sudo: true,
      inputs: { code: '123456' },
      cfg,
    });

    const result: any = await new AccountMfaApiController().confirmTotp(ctx);

    assert.equal(captured.status(), 200);
    assert.isTrue(result.enabled);
    assert.deepEqual(result.recoveryCodes, ['new-1', 'new-2']);
    assert.isTrue(store._state.enabled);
    assert.isTrue(cfg.audit.events.some((e: any) => e.type === 'mfa.enabled'));
  });

  test('NÃO exige sudo: é o passo seguinte do enroll, que já exigiu', async ({ assert }) => {
    const store = mfaStore();
    const { ctx, captured } = fakeCtx({
      actorId: USER,
      inputs: { code: '123456' },
      cfg: buildCfg(store),
    });

    await new AccountMfaApiController().confirmTotp(ctx);

    assert.equal(captured.status(), 200);
    assert.isTrue(store._state.enabled);
  });

  test('código errado → 422 invalid_code, MFA não liga', async ({ assert }) => {
    const store = mfaStore();
    const cfg = buildCfg(store);
    const { ctx, captured } = fakeCtx({ actorId: USER, inputs: { code: '000000' }, cfg });

    await new AccountMfaApiController().confirmTotp(ctx);

    assert.equal(captured.status(), 422);
    assert.equal(captured.body().error.code, 'invalid_code');
    assert.isFalse(store._state.enabled);
    assert.isFalse(cfg.audit.events.some((e: any) => e.type === 'mfa.enabled'));
  });

  test('código errado NÃO troca o segredo pendente (o QR já foi escaneado)', async ({ assert }) => {
    const store = mfaStore();
    const cfg = buildCfg(store);
    const enroll = fakeCtx({ actorId: USER, sudo: true, cfg });
    await new AccountMfaApiController().enrollTotp(enroll.ctx);
    const secretDepoisDoEnroll = store._state.pendingSecret;

    const { ctx } = fakeCtx({ actorId: USER, inputs: { code: '999999' }, cfg });
    await new AccountMfaApiController().confirmTotp(ctx);

    assert.equal(store._state.pendingSecret, secretDepoisDoEnroll);
    assert.equal(store._state.enrollCalls, 1);
  });

  test('sem sessão → 401', async ({ assert }) => {
    const { ctx, captured } = fakeCtx({ inputs: { code: '123456' }, cfg: buildCfg(mfaStore()) });
    await new AccountMfaApiController().confirmTotp(ctx);
    assert.equal(captured.status(), 401);
  });
});

// ─── disable ─────────────────────────────────────────────────────────────────

test.group('AccountMfaApiController — POST /account/api/mfa/totp/disable', () => {
  test('com sudo → desliga e audita', async ({ assert }) => {
    const store = mfaStore({ enabled: true });
    const cfg = buildCfg(store);
    const { ctx, captured } = fakeCtx({ actorId: USER, sudo: true, cfg });

    const result: any = await new AccountMfaApiController().disableTotp(ctx);

    assert.equal(captured.status(), 200);
    assert.isFalse(result.enabled);
    assert.isFalse(store._state.enabled);
    assert.isTrue(cfg.audit.events.some((e: any) => e.type === 'mfa.disabled'));
  });

  test('SEM sudo → 403 e o MFA continua ligado', async ({ assert }) => {
    const store = mfaStore({ enabled: true });
    const { ctx, captured } = fakeCtx({ actorId: USER, cfg: buildCfg(store) });

    await new AccountMfaApiController().disableTotp(ctx);

    assert.equal(captured.status(), 403);
    assert.equal(captured.body().error.code, 'sudo_required');
    assert.isTrue(store._state.enabled);
  });
});

// ─── recovery codes ──────────────────────────────────────────────────────────

test.group('AccountMfaApiController — POST /account/api/mfa/recovery-codes', () => {
  test('com sudo e MFA ativo → códigos novos, os antigos deixam de valer', async ({ assert }) => {
    const store = mfaStore({ enabled: true });
    const cfg = buildCfg(store);
    const { ctx, captured } = fakeCtx({ actorId: USER, sudo: true, cfg });

    const result: any = await new AccountMfaApiController().regenerateRecoveryCodes(ctx);

    assert.equal(captured.status(), 200);
    assert.deepEqual(result.recoveryCodes, ['regen-1', 'regen-2', 'regen-3']);
    assert.notInclude(store._state.recoveryCodes, 'old-1');
    assert.isTrue(
      cfg.audit.events.some((e: any) => e.type === 'mfa.recovery_codes_regenerated'),
      'o evento de auditoria é próprio: o fator não mudou, o conjunto de contorno mudou',
    );
  });

  test('SEM sudo → 403 e os códigos antigos continuam valendo', async ({ assert }) => {
    const store = mfaStore({ enabled: true });
    const { ctx, captured } = fakeCtx({ actorId: USER, cfg: buildCfg(store) });

    await new AccountMfaApiController().regenerateRecoveryCodes(ctx);

    assert.equal(captured.status(), 403);
    assert.equal(captured.body().error.code, 'sudo_required');
    assert.deepEqual(store._state.recoveryCodes, ['old-1', 'old-2']);
  });

  test('MFA desligado → 422 mfa_not_enabled (não fabrica credencial de contorno)', async ({
    assert,
  }) => {
    const store = mfaStore({ enabled: false });
    const { ctx, captured } = fakeCtx({ actorId: USER, sudo: true, cfg: buildCfg(store) });

    await new AccountMfaApiController().regenerateRecoveryCodes(ctx);

    assert.equal(captured.status(), 422);
    assert.equal(captured.body().error.code, 'mfa_not_enabled');
  });

  test('store que não implementa a capacidade → 422 capability_unsupported', async ({ assert }) => {
    const store = mfaStore({ enabled: true, regenerable: false });
    const { ctx, captured } = fakeCtx({ actorId: USER, sudo: true, cfg: buildCfg(store) });

    await new AccountMfaApiController().regenerateRecoveryCodes(ctx);

    assert.equal(captured.status(), 422);
    assert.equal(captured.body().error.code, 'capability_unsupported');
  });
});

// ─── passkeys ────────────────────────────────────────────────────────────────

test.group('AccountMfaApiController — cerimônia de passkey em JSON', () => {
  test('options devolve as options e guarda o desafio na sessão', async ({ assert }) => {
    const store = passkeyStore();
    const { ctx, captured } = fakeCtx({ actorId: USER, cfg: buildCfg(store as any) });

    const result: any = await new AccountMfaApiController().passkeyRegisterOptions(ctx);

    assert.equal(captured.status(), 200);
    assert.equal(result.challenge, 'chal-1');
    assert.equal(captured.session.get(PASSKEY_REG_CHALLENGE_KEY), 'chal-1');
  });

  test('store sem passkeys → 422 capability_unsupported', async ({ assert }) => {
    const { ctx, captured } = fakeCtx({ actorId: USER, cfg: buildCfg(baseStore()) });
    await new AccountMfaApiController().passkeyRegisterOptions(ctx);
    assert.equal(captured.status(), 422);
    assert.equal(captured.body().error.code, 'capability_unsupported');
  });

  test('verify com sudo e desafio válido → ok, auditoria e desafio queimado', async ({
    assert,
  }) => {
    const store = passkeyStore();
    const cfg = buildCfg(store as any);
    const { ctx, captured } = fakeCtx({
      actorId: USER,
      sudo: true,
      cfg,
      session: { [PASSKEY_REG_CHALLENGE_KEY]: 'chal-1' },
      inputs: { response: { id: 'cred' } },
    });

    const result: any = await new AccountMfaApiController().passkeyRegisterVerify(ctx);

    assert.deepEqual(result, { ok: true });
    assert.isUndefined(captured.session.get(PASSKEY_REG_CHALLENGE_KEY));
    assert.isTrue(cfg.audit.events.some((e: any) => e.type === 'passkey.registered'));
  });

  test('verify SEM sudo → 403 e o desafio segue intacto (não é consumido)', async ({ assert }) => {
    const store = passkeyStore();
    const { ctx, captured } = fakeCtx({
      actorId: USER,
      cfg: buildCfg(store as any),
      session: { [PASSKEY_REG_CHALLENGE_KEY]: 'chal-1' },
      inputs: { response: { id: 'cred' } },
    });

    await new AccountMfaApiController().passkeyRegisterVerify(ctx);

    assert.equal(captured.status(), 403);
    assert.equal(captured.body().error.code, 'sudo_required');
    assert.lengthOf(store._registered, 0);
  });

  test('verify sem desafio na sessão → 400 challenge_expired', async ({ assert }) => {
    const { ctx, captured } = fakeCtx({
      actorId: USER,
      sudo: true,
      cfg: buildCfg(passkeyStore() as any),
      inputs: { response: { id: 'cred' } },
    });

    await new AccountMfaApiController().passkeyRegisterVerify(ctx);

    assert.equal(captured.status(), 400);
    assert.equal(captured.body().error.code, 'challenge_expired');
  });

  test('attestation recusado → 400 e o desafio é QUEIMADO (sem retry)', async ({ assert }) => {
    const store = passkeyStore({ verifies: false });
    const { ctx, captured } = fakeCtx({
      actorId: USER,
      sudo: true,
      cfg: buildCfg(store as any),
      session: { [PASSKEY_REG_CHALLENGE_KEY]: 'chal-1' },
      inputs: { response: { id: 'cred' } },
    });

    await new AccountMfaApiController().passkeyRegisterVerify(ctx);

    assert.equal(captured.status(), 400);
    assert.equal(captured.body().error.code, 'invalid_response');
    assert.isUndefined(captured.session.get(PASSKEY_REG_CHALLENGE_KEY));
  });

  test('o slot do desafio é o MESMO do caminho clássico (constante compartilhada)', ({
    assert,
  }) => {
    assert.equal(PASSKEY_REG_CHALLENGE_KEY, 'authkit_passkey_reg_challenge');
  });
});
