/**
 * O login social chamava `completeLogin` direto depois do provider. Senha, link
 * mágico e código por e-mail passam pelo `secondFactorGate`; "Continuar com
 * Google" não passava, então quem cadastrou TOTP ou passkey entrava sem ele
 * por essa porta.
 *
 * Agora o callback, quando a conta deve o fator (`social.secondFactor`), grava
 * o login pendente e manda o browser para `/auth/interaction/:uid/social/continue`,
 * onde roda o mesmo gate dos outros fluxos.
 *
 * O segundo defeito coberto: o callback ligava a identidade do provider a uma
 * conta existente só pelo e-mail, mesmo quando o provider dizia que o e-mail NÃO
 * era verificado — e criava contas com `emailVerified: true` nesse caso.
 */

import { test } from '@japa/runner';
import { deriveLockedSettingKeys } from '../../src/host/config_locks.js';
import InteractionController from '../../src/host/controllers/interaction_controller.js';
import AuthSocialController from '../../src/host/controllers/social_controller.js';
import {
  resolveEffectiveSocialSecondFactor,
  SETTING_KEYS,
} from '../../src/host/runtime_toggles.js';
import { SOCIAL_PENDING_KEY } from '../../src/host/social_pending.js';

const PROVIDER = 'google';
const ACCOUNT_ID = 'acc-1';
const EMAIL = 'user@example.com';
const UID = 'test-uid';
const CONTINUE_URL = `/auth/interaction/${UID}/social/continue`;
const MFA_PENDING_KEY = 'authkit_mfa_pending';

type StoreOpts = {
  totp?: boolean;
  roles?: string[];
  /** Sem identidade ligada: o callback cai no caminho por e-mail. */
  linked?: boolean;
  /** Existe conta com o e-mail do provider. */
  existsByEmail?: boolean;
};

function makeStore(opts: StoreOpts = {}) {
  const account = {
    id: ACCOUNT_ID,
    email: EMAIL,
    name: 'Test User',
    globalRoles: opts.roles ?? ['USER'],
  };
  const calls = { linked: [] as any[], created: [] as any[] };
  const store: any = {
    findById: async (id: string) => (id === account.id ? account : null),
    findByProviderIdentity: async () => (opts.linked === false ? null : account),
    findByEmail: async (email: string) =>
      opts.existsByEmail && email === account.email ? account : null,
    linkProviderIdentity: async (input: any) => {
      calls.linked.push(input);
    },
    create: async (input: any) => {
      calls.created.push(input);
      return { ...account, id: 'acc-new' };
    },
    listPasskeys: async () => [],
  };
  if (opts.totp !== undefined) {
    store.getMfaState = async () => ({ enabled: opts.totp, enabledAt: 1, totp: opts.totp });
  }
  return { store, calls };
}

function buildService(store: any, social: Record<string, unknown> = {}) {
  const rendered: Array<{ view: string; props: Record<string, any> }> = [];
  const completeLoginCalls: any[] = [];
  const config: any = {
    accountStore: store,
    social: { providers: [PROVIDER], ...social },
    render: async (_ctx: any, view: string, props: Record<string, any>) => {
      rendered.push({ view, props });
      return { view, props };
    },
    messages: {},
    branding: { default: { appName: 'Acme', logoUrl: null }, clients: {}, firstParty: [] },
    audit: { record: async () => {} },
    trustedDevices: { enabled: false, days: 30 },
  };
  const interactions = {
    details: async () => ({ uid: UID, params: { client_id: 'web' }, prompt: { name: 'login' } }),
    completeLogin: async (...args: any[]) => {
      completeLoginCalls.push(args);
    },
  };
  return { service: { config, interactions }, rendered, completeLoginCalls };
}

function fakeCtx(
  service: any,
  session: Record<string, unknown>,
  profile: Record<string, unknown> = { id: 'provider-uid-1', email: EMAIL, name: 'Test User' },
) {
  const redirects: string[] = [];
  return {
    containerResolver: {
      make: async (key: string) => {
        if (key === 'authkit.server') return service;
        // `service.db`: tabela `auth_settings` fake (setting do console). Sem ela,
        // o callback degrada para settings no-op, como num host sem a migração.
        if (key === 'lucid.db' && service.db) return service.db;
        throw new Error(`unknown: ${key}`);
      },
    },
    request: {
      csrfToken: 'csrf',
      param: (k: string) => (k === 'uid' ? UID : PROVIDER),
      input: (_k: string, def?: any) => def,
      ip: () => '1.2.3.4',
      encryptedCookie: () => undefined,
    },
    session: {
      get: (k: string) => session[k],
      put: (k: string, v: unknown) => {
        session[k] = v;
      },
      forget: (k: string) => {
        delete session[k];
      },
    },
    ally: {
      use: () => ({
        accessDenied: () => false,
        stateMisMatch: () => false,
        hasError: () => false,
        user: async () => profile,
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

const callback = (ctx: any) => new AuthSocialController().callback(ctx);

test.group('login social — 2º fator no callback', () => {
  test('conta com TOTP: não completa o login, manda para o desafio', async ({ assert }) => {
    const { store } = makeStore({ totp: true });
    const { service, completeLoginCalls } = buildService(store);
    const session: Record<string, unknown> = { authkit_social_uid: UID };
    const ctx = fakeCtx(service, session);

    await callback(ctx);

    assert.lengthOf(completeLoginCalls, 0);
    assert.deepEqual(ctx.__redirects, [CONTINUE_URL]);
    assert.include(session[SOCIAL_PENDING_KEY] as object, {
      accountId: ACCOUNT_ID,
      uid: UID,
      required: false,
    });
  });

  test('conta sem fator: completa o login direto, como antes', async ({ assert }) => {
    const { store } = makeStore({ totp: false });
    const { service, completeLoginCalls } = buildService(store);
    const ctx = fakeCtx(service, { authkit_social_uid: UID });

    await callback(ctx);

    assert.lengthOf(completeLoginCalls, 1);
    assert.equal(completeLoginCalls[0][1], ACCOUNT_ID);
  });

  test("política 'never': confia só no provider mesmo com TOTP", async ({ assert }) => {
    const { store } = makeStore({ totp: true });
    const { service, completeLoginCalls } = buildService(store, { secondFactor: 'never' });
    const ctx = fakeCtx(service, { authkit_social_uid: UID });

    await callback(ctx);

    assert.lengthOf(completeLoginCalls, 1);
  });

  test('política por conta: papéis vêm do resolveTokenRoles (authz), não do globalRoles', async ({
    assert,
  }) => {
    // A conta guarda só USER; o papel administrativo vive na autoridade do host.
    const { store } = makeStore({ totp: false, roles: ['USER'] });
    const seen: string[][] = [];
    const { service, completeLoginCalls } = buildService(store, {
      secondFactor: (account: { roles: string[] }) => {
        seen.push(account.roles);
        return account.roles.includes('COORDINATOR') ? 'required' : 'enrolled';
      },
    });
    service.config.resolveTokenRoles = async () => ['RESEARCHER', 'COORDINATOR'];
    const session: Record<string, unknown> = { authkit_social_uid: UID };
    const ctx = fakeCtx(service, session);

    await callback(ctx);

    assert.deepEqual(seen, [['RESEARCHER', 'COORDINATOR']]);
    assert.lengthOf(completeLoginCalls, 0);
    assert.deepEqual(ctx.__redirects, [CONTINUE_URL]);
    assert.isTrue((session[SOCIAL_PENDING_KEY] as { required: boolean }).required);
  });

  test('sem resolveTokenRoles: cai no globalRoles da conta', async ({ assert }) => {
    const { store } = makeStore({ totp: false, roles: ['ADMIN'] });
    const seen: string[][] = [];
    const { service } = buildService(store, {
      secondFactor: (account: { roles: string[] }) => {
        seen.push(account.roles);
        return 'enrolled';
      },
    });

    await callback(fakeCtx(service, { authkit_social_uid: UID }));

    assert.deepEqual(seen, [['ADMIN']]);
  });
});

test.group('login social — e-mail não verificado pelo provider', () => {
  const unverified = {
    id: 'provider-uid-1',
    email: EMAIL,
    name: 'Test User',
    emailVerificationState: 'unverified',
  };

  test('não liga a identidade a uma conta existente pelo e-mail', async ({ assert }) => {
    const { store, calls } = makeStore({ linked: false, existsByEmail: true });
    const { service, completeLoginCalls } = buildService(store);
    const ctx = fakeCtx(service, { authkit_social_uid: UID }, unverified);

    await callback(ctx);

    assert.lengthOf(calls.linked, 0);
    assert.lengthOf(completeLoginCalls, 0);
    assert.deepEqual(ctx.__redirects, [`/auth/interaction/${UID}`]);
  });

  test('não cria conta nova com e-mail não verificado', async ({ assert }) => {
    const { store, calls } = makeStore({ linked: false, existsByEmail: false });
    const { service, completeLoginCalls } = buildService(store);
    const ctx = fakeCtx(service, { authkit_social_uid: UID }, unverified);

    await callback(ctx);

    assert.lengthOf(calls.created, 0);
    assert.lengthOf(completeLoginCalls, 0);
  });

  test('e-mail verificado: liga a identidade e entra', async ({ assert }) => {
    const { store, calls } = makeStore({ linked: false, existsByEmail: true });
    const { service, completeLoginCalls } = buildService(store);
    const ctx = fakeCtx(
      service,
      { authkit_social_uid: UID },
      { ...unverified, emailVerificationState: 'verified' },
    );

    await callback(ctx);

    assert.lengthOf(calls.linked, 1);
    assert.lengthOf(completeLoginCalls, 1);
  });

  test('conta nova só nasce verificada se o provider confirmou o e-mail', async ({ assert }) => {
    const { store, calls } = makeStore({ linked: false, existsByEmail: false });
    const { service } = buildService(store);

    await callback(
      fakeCtx(
        service,
        { authkit_social_uid: UID },
        { ...unverified, emailVerificationState: 'unsupported' },
      ),
    );
    await callback(
      fakeCtx(
        service,
        { authkit_social_uid: UID },
        { ...unverified, emailVerificationState: 'verified' },
      ),
    );

    assert.deepEqual(
      calls.created.map((c) => c.emailVerified),
      [false, true],
    );
  });
});

test.group('login social — continuação do 2º fator', () => {
  const pending = (over: Record<string, unknown> = {}) => ({
    [SOCIAL_PENDING_KEY]: {
      accountId: ACCOUNT_ID,
      uid: UID,
      required: false,
      at: Date.now(),
      ...over,
    },
  });

  test('conta com TOTP: renderiza o desafio e deixa o accountId pendente', async ({ assert }) => {
    const { store } = makeStore({ totp: true });
    const { service, rendered, completeLoginCalls } = buildService(store);
    const session: Record<string, unknown> = pending();

    await new InteractionController().socialContinue(fakeCtx(service, session));

    assert.lengthOf(completeLoginCalls, 0);
    assert.equal(rendered[0]?.view, 'mfa-challenge');
    assert.equal(session[MFA_PENDING_KEY], ACCOUNT_ID);
    assert.isUndefined(session[SOCIAL_PENDING_KEY], 'o passo pendente vale uma vez só');
  });

  test("exigido sem fator cadastrado: mostra 'configure o MFA', não entra", async ({ assert }) => {
    const { store } = makeStore({ totp: false });
    const { service, rendered, completeLoginCalls } = buildService(store);

    await new InteractionController().socialContinue(fakeCtx(service, pending({ required: true })));

    assert.lengthOf(completeLoginCalls, 0);
    assert.isTrue(rendered[0]?.props.noEnrollment);
  });

  test('sem login pendente (ou de outra interaction / vencido): volta ao login', async ({
    assert,
  }) => {
    const { store } = makeStore({ totp: true });
    const { service, completeLoginCalls } = buildService(store);

    for (const session of [{}, pending({ uid: 'other' }), pending({ at: 0 })]) {
      const ctx = fakeCtx(service, session);
      await new InteractionController().socialContinue(ctx);
      assert.deepEqual(ctx.__redirects, [`/auth/interaction/${UID}`]);
    }
    assert.lengthOf(completeLoginCalls, 0);
  });
});

/** `lucid.db` mínimo servindo `auth_settings` (mesmo padrão de account_status_gate_social). */
function settingsDb(rows: Record<string, unknown>) {
  const store = new Map(Object.entries(rows).map(([k, v]) => [k, JSON.stringify(v)]));
  function chain(filters: Array<{ col: string; val: string | null }>) {
    return {
      where: (col: string, val: string) => chain([...filters, { col, val }]),
      whereNull: (col: string) => chain([...filters, { col, val: null }]),
      async first() {
        const key = filters.find((f) => f.col === 'key')?.val;
        const value = key ? store.get(key) : undefined;
        return value === undefined ? null : { key, value };
      },
    };
  }
  return {
    from(...args: any[]) {
      return (this as any).table(...args);
    },
    table() {
      return {
        select: () => ({ limit: () => Promise.resolve([]) }),
        where: (col: string, val: string) => chain([{ col, val }]),
        whereNull: (col: string) => chain([{ col, val: null }]),
      };
    },
  };
}

test.group('login social — 2º fator pela setting do console', () => {
  const withSetting = (value: unknown) => settingsDb({ social_second_factor: value });

  test("setting 'never': conta com TOTP entra direto", async ({ assert }) => {
    const { store } = makeStore({ totp: true });
    const { service, completeLoginCalls } = buildService(store);
    (service as any).db = withSetting({ policy: 'never' });

    await callback(fakeCtx(service, { authkit_social_uid: UID }));

    assert.lengthOf(completeLoginCalls, 1);
  });

  test('papel em requiredRoles (vindo do authz) exige o fator mesmo sem cadastro', async ({
    assert,
  }) => {
    const { store } = makeStore({ totp: false, roles: ['USER'] });
    const { service, completeLoginCalls } = buildService(store);
    (service as any).db = withSetting({ policy: 'enrolled', requiredRoles: ['COORDINATOR'] });
    service.config.resolveTokenRoles = async () => ['COORDINATOR'];
    const session: Record<string, unknown> = { authkit_social_uid: UID };
    const ctx = fakeCtx(service, session);

    await callback(ctx);

    assert.lengthOf(completeLoginCalls, 0);
    assert.deepEqual(ctx.__redirects, [CONTINUE_URL]);
    assert.isTrue((session[SOCIAL_PENDING_KEY] as { required: boolean }).required);
  });

  test("requiredRoles vale até com policy 'never'; quem não tem o papel entra direto", async ({
    assert,
  }) => {
    const db = withSetting({ policy: 'never', requiredRoles: ['ADMIN'] });
    const admin = makeStore({ totp: false, roles: ['ADMIN'] });
    const user = makeStore({ totp: true, roles: ['USER'] });
    const forAdmin = buildService(admin.store);
    const forUser = buildService(user.store);
    (forAdmin.service as any).db = db;
    (forUser.service as any).db = db;

    await callback(fakeCtx(forAdmin.service, { authkit_social_uid: UID }));
    await callback(fakeCtx(forUser.service, { authkit_social_uid: UID }));

    assert.lengthOf(forAdmin.completeLoginCalls, 0, 'admin vai para o desafio');
    assert.lengthOf(forUser.completeLoginCalls, 1, "'never' vale para os outros");
  });

  test('config declarado manda: setting do console é ignorado', async ({ assert }) => {
    const { store } = makeStore({ totp: true });
    const { service, completeLoginCalls } = buildService(store, { secondFactor: 'enrolled' });
    (service as any).db = withSetting({ policy: 'never' });

    await callback(fakeCtx(service, { authkit_social_uid: UID }));

    assert.lengthOf(completeLoginCalls, 0, "o arquivo diz 'enrolled': TOTP desafia");
  });

  test('declarar social.secondFactor trava a setting; sem ele, não', ({ assert }) => {
    assert.include(
      deriveLockedSettingKeys({ social: { providers: ['google'], secondFactor: 'required' } }),
      SETTING_KEYS.SOCIAL_SECOND_FACTOR,
    );
    assert.include(
      deriveLockedSettingKeys({ social: { providers: ['google'], secondFactor: () => 'never' } }),
      SETTING_KEYS.SOCIAL_SECOND_FACTOR,
    );
    assert.notInclude(
      deriveLockedSettingKeys({ social: { providers: ['google'] } }),
      SETTING_KEYS.SOCIAL_SECOND_FACTOR,
    );
  });

  test('setting ausente ou inválida cai no default enrolled, sem papéis', async ({ assert }) => {
    const fake = (value: unknown) => ({ getSetting: async () => value }) as any;
    const expected = { policy: 'enrolled', requiredRoles: [] };

    assert.deepEqual(await resolveEffectiveSocialSecondFactor(fake(null)), expected);
    assert.deepEqual(await resolveEffectiveSocialSecondFactor(fake('required')), expected);
    assert.deepEqual(
      await resolveEffectiveSocialSecondFactor(fake({ policy: 'sempre', requiredRoles: 'ADMIN' })),
      expected,
    );
    assert.deepEqual(
      await resolveEffectiveSocialSecondFactor(
        fake({ policy: 'required', requiredRoles: [' ADMIN ', 3, ''] }),
      ),
      { policy: 'required', requiredRoles: ['ADMIN'] },
    );
  });
});
