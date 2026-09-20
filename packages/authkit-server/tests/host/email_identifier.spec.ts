/**
 * Identidade por e-mail: UMA normalização só, conservadora, nos dois lados.
 *
 * O BUG que estes testes travam: o cadastro validava o e-mail com
 * `.normalizeEmail()` do VineJS (defaults do validator.js), que para o gmail
 * REMOVE pontos e sub-endereço — `davi.carvalho96@gmail.com` era gravado como
 * `davicarvalho96@gmail.com` — enquanto o passo de identificador do login NÃO
 * normalizava nada e buscava por igualdade exata. Quem tinha ponto (ou `+tag`,
 * ou digitou uma maiúscula) ficava trancado do lado de fora, e, por o login ser
 * à prova de enumeração, sem nenhuma mensagem de erro.
 *
 * PROVA DE MUTAÇÃO: devolver `.normalizeEmail()` aos validators deixa o grupo
 * "cadastro" vermelho; tirar a normalização do `identifier()` deixa o grupo
 * "login" vermelho.
 *
 * As contas GRAVADAS antes desta regra (mutiladas ou com maiúsculas) continuam
 * inalcançáveis pelo login — é o que o grupo "contas gravadas em outra grafia"
 * trava. Quem as reencontra é a migração `authkit:users:normalize-emails`
 * (testada em `tests/commands/normalize_emails.spec.ts`), não uma ponte no
 * caminho do login.
 */

import { test } from '@japa/runner';
import type {
  AccountStore,
  AuthAccount,
  CreateAccountInput,
} from '../../src/accounts/account_store.js';
import { importUsers } from '../../src/commands/import_users.js';
import { resolveLogin, resolvePasswordless } from '../../src/define_config.js';
import { AdminUsersService } from '../../src/host/admin_api/admin_users_service.js';
import InteractionController from '../../src/host/controllers/interaction_controller.js';
import AuthSocialController from '../../src/host/controllers/social_controller.js';
import { normalizeEmailIdentifier } from '../../src/host/email_identifier.js';
import {
  changeEmailValidator,
  forgotPasswordValidator,
  passwordlessSignupValidator,
  signupValidator,
} from '../../src/host/validators.js';

// ─── helpers ────────────────────────────────────────────────────────────────

/** Store em memória com um conjunto fixo de contas (busca por igualdade EXATA). */
function storeWith(emails: string[]): AccountStore {
  const accounts: AuthAccount[] = emails.map((email, i) => ({
    id: `acc-${i + 1}`,
    email,
    name: `User ${i + 1}`,
    globalRoles: ['USER'],
  }));
  const store: any = {
    findByEmail: async (email: string) => accounts.find((a) => a.email === email) ?? null,
    findById: async (id: string) => accounts.find((a) => a.id === id) ?? null,
    verifyCredentials: async () => null,
    create: async () => {
      throw new Error('not used');
    },
    issueMagicLinkToken: async () => null,
  };
  return store as AccountStore;
}

/** DB sem tabela `auth_settings` → RuntimeSettings degrada para os defaults do config. */
function noTableDb() {
  return {
    from() {
      return (this as any).table();
    },
    table() {
      throw new Error('no table');
    },
  };
}

function buildService(store: AccountStore) {
  const rendered: Array<{ view: string; props: Record<string, any> }> = [];
  const config = {
    render: async (_ctx: any, view: string, props: Record<string, any>) => {
      rendered.push({ view, props });
      return { view, props };
    },
    messages: {},
    branding: {
      default: { appName: 'Acme', logoUrl: null },
      clients: {},
      firstParty: [],
      company: undefined,
    },
    botProtection: undefined,
    passwordless: resolvePasswordless({ magicLink: true, passkeyFirst: false }),
    login: resolveLogin(),
    registration: { enabled: true },
    social: undefined,
    authMethods: undefined,
    accountStore: store,
  };
  const interactions = {
    details: async () => ({
      uid: 'test-uid',
      params: { client_id: 'web' },
      prompt: { name: 'login' },
    }),
  };
  return { service: { config, interactions }, rendered };
}

/** ctx fake com sessão REAL (o passo de identificador grava nela) e form input. */
function fakeCtx(service: any, db: any, form: Record<string, unknown> = {}) {
  const session: Record<string, unknown> = {};
  const redirects: string[] = [];
  const ctx = {
    containerResolver: {
      make: async (key: string) => {
        if (key === 'authkit.server') return service;
        if (key === 'lucid.db') return db;
        throw new Error(`unknown: ${key}`);
      },
    },
    request: {
      csrfToken: 'csrf',
      param: (_k: string) => 'test-uid',
      only: (keys: string[]) =>
        Object.fromEntries(keys.map((k) => [k, form[k]])) as Record<string, any>,
      input: (k: string, def?: any) => form[k] ?? def,
      qs: () => ({}),
      ip: () => '1.2.3.4',
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
    response: {
      redirect: (url: string) => {
        redirects.push(url);
      },
    },
  } as any;
  return { ctx, session, redirects };
}

/** Roda o passo 1 (identifier) com `typed` e devolve o render do passo 2. */
async function loginWith(store: AccountStore, typed: string) {
  const { service, rendered } = buildService(store);
  const controller = new InteractionController();
  const db = noTableDb();

  const step1 = fakeCtx(service, db, { email: typed });
  await controller.identifier(step1.ctx);

  // Passo 2 reusa a MESMA sessão (o navegador manda o cookie de volta).
  const step2 = fakeCtx(service, db);
  for (const [k, v] of Object.entries(step1.session)) step2.ctx.session.put(k, v);
  await controller.show(step2.ctx);

  return { props: rendered[rendered.length - 1]?.props ?? {}, session: step1.session };
}

// ─── 1) A normalização ──────────────────────────────────────────────────────

test.group('normalizeEmailIdentifier', () => {
  test('faz trim + lowercase e MAIS NADA', ({ assert }) => {
    assert.equal(
      normalizeEmailIdentifier('  Davi.Carvalho96@Gmail.com  '),
      'davi.carvalho96@gmail.com',
    );
    assert.equal(normalizeEmailIdentifier('davi+lastro@gmail.com'), 'davi+lastro@gmail.com');
    assert.equal(normalizeEmailIdentifier(undefined), '');
  });

  test('entrada não-string vira string vazia (o passo 1 não pode virar 500)', ({ assert }) => {
    // `request.only(['email'])` não valida o tipo: `email[]=x` chega como array.
    assert.equal(normalizeEmailIdentifier(['a@b.com'] as unknown), '');
    assert.equal(normalizeEmailIdentifier({ a: 1 } as unknown), '');
    assert.equal(normalizeEmailIdentifier(null), '');
  });

  test('NÃO remove ponto nem sub-endereço (a identidade é o que a pessoa digitou)', ({
    assert,
  }) => {
    assert.equal(
      normalizeEmailIdentifier('davi.carvalho96@gmail.com'),
      'davi.carvalho96@gmail.com',
    );
    assert.equal(
      normalizeEmailIdentifier('davi.carvalho96+lastro@gmail.com'),
      'davi.carvalho96+lastro@gmail.com',
    );
  });
});

// ─── 2) Cadastro: o endereço gravado é o digitado ───────────────────────────

test.group('cadastro grava o endereço que a pessoa digitou', () => {
  test('signup preserva ponto e sub-endereço do gmail', async ({ assert }) => {
    const comPonto = await signupValidator.validate({
      email: '  Davi.Carvalho96@Gmail.com ',
      fullName: 'Davi',
      password: 'senha-super-segura',
    });
    assert.equal(comPonto.email, 'davi.carvalho96@gmail.com');

    const comTag = await signupValidator.validate({
      email: 'davi.carvalho96+lastro@gmail.com',
      fullName: 'Davi',
      password: 'senha-super-segura',
    });
    assert.equal(comTag.email, 'davi.carvalho96+lastro@gmail.com');
  });

  test('cadastro passwordless preserva o endereço', async ({ assert }) => {
    const out = await passwordlessSignupValidator.validate({
      email: 'Davi.Carvalho96+Lastro@Gmail.com',
      fullName: 'Davi',
    });
    assert.equal(out.email, 'davi.carvalho96+lastro@gmail.com');
  });

  test('esqueci a senha e troca de e-mail usam a MESMA normalização', async ({ assert }) => {
    const forgot = await forgotPasswordValidator.validate({ email: ' Davi.C@Gmail.com ' });
    assert.equal(forgot.email, 'davi.c@gmail.com');

    const change = await changeEmailValidator.validate({ newEmail: 'Davi.C+Novo@Gmail.com' });
    assert.equal(change.newEmail, 'davi.c+novo@gmail.com');
  });
});

// ─── 3) Login: o passo de identificador normaliza ───────────────────────────

test.group('login — passo de identificador', () => {
  test('acha a conta com maiúsculas e espaços em volta', async ({ assert }) => {
    const { props } = await loginWith(storeWith(['davi@acme.com']), '  Davi@Acme.com  ');
    assert.equal(props.step, 'password');
    assert.isNotNull(props.account, 'a conta deveria ter sido encontrada');
    assert.equal(props.email, 'davi@acme.com');
  });

  test('conta com ponto/sub-endereço entra pelo endereço real', async ({ assert }) => {
    const store = storeWith(['davi.carvalho96+lastro@gmail.com']);
    const { props } = await loginWith(store, 'Davi.Carvalho96+Lastro@Gmail.com');
    assert.isNotNull(props.account);
  });
});

// ─── 4) Contas gravadas em outra grafia: pedem MIGRAÇÃO ─────────────────────

test.group('contas gravadas em outra grafia', () => {
  test('a conta mutilada pelo cadastro antigo NÃO é alcançada pelo login', async ({ assert }) => {
    // Nasceu no cadastro antigo: o ponto foi removido na gravação. O login busca
    // UMA forma só — a normalizada —, então esta conta só volta a existir depois
    // do `authkit:users:normalize-emails`. Buscar grafias derivadas aqui custaria
    // uma query a mais por e-mail desconhecido, que é o caminho de ataque.
    const store = storeWith(['davicarvalho96@gmail.com']);
    const { props } = await loginWith(store, 'davi.carvalho96@gmail.com');
    assert.isNull(props.account);
    // Anti-enumeração intacta: a tela é a MESMA do caminho feliz e mostra o que
    // a pessoa digitou — nada distingue "não achei" de "achei".
    assert.equal(props.step, 'password');
    assert.equal(props.email, 'davi.carvalho96@gmail.com');
  });

  test('a conta gravada com maiúsculas também não é alcançada', async ({ assert }) => {
    const store = storeWith(['Davi@Acme.com']);
    const { props } = await loginWith(store, 'Davi@Acme.com');
    assert.isNull(props.account);
    assert.equal(props.email, 'davi@acme.com');
  });

  test('o passo 1 NÃO consulta o store (nem uma query para diferenciar)', async ({ assert }) => {
    const calls: string[] = [];
    const store = {
      findByEmail: async (email: string) => {
        calls.push(email);
        return null;
      },
    } as unknown as AccountStore;
    const { service } = buildService(store);
    const step1 = fakeCtx(service, noTableDb(), { email: '  Davi@Acme.com ' });

    await new InteractionController().identifier(step1.ctx);

    assert.deepEqual(calls, [], 'o passo de identificador não pode tocar no store');
    assert.equal(step1.session.authkit_login_email, 'davi@acme.com');
    assert.deepEqual(step1.redirects, ['/auth/interaction/test-uid']);
  });

  test('a sessão guarda UMA chave só (o digitado normalizado)', async ({ assert }) => {
    const { session } = await loginWith(storeWith(['davi@acme.com']), 'Davi@Acme.com');
    assert.deepEqual(Object.keys(session), ['authkit_login_email']);
    assert.equal(session.authkit_login_email, 'davi@acme.com');
  });
});

test.group('login — passo de identificador, entrada hostil', () => {
  test('`email` não-string não quebra o passo 1 (segue o redirect incondicional)', async ({
    assert,
  }) => {
    const { service } = buildService(storeWith(['davi@acme.com']));
    const step1 = fakeCtx(service, noTableDb(), { email: ['davi@acme.com'] });

    await new InteractionController().identifier(step1.ctx);

    assert.deepEqual(step1.redirects, ['/auth/interaction/test-uid']);
    assert.equal(step1.session.authkit_login_email, '');
  });
});

// ─── 5) Cadastro social ─────────────────────────────────────────────────────

/** ctx fake do callback social: provider devolve `email` e um id estável. */
function fakeSocialCtx(service: any, providerEmail: string) {
  const session: Record<string, unknown> = { authkit_social_uid: 'test-uid' };
  const redirects: string[] = [];
  return {
    containerResolver: {
      make: async (key: string) => {
        if (key === 'authkit.server') return service;
        throw new Error(`unknown: ${key}`);
      },
    },
    request: { param: (_k: string) => 'google' },
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
        user: async () => ({ id: 'provider-uid-1', email: providerEmail, name: 'Davi' }),
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

test.group('cadastro social', () => {
  test('liga a identidade à conta existente em vez de criar uma SEGUNDA', async ({ assert }) => {
    // O provider devolve o endereço com maiúsculas; a conta está gravada na
    // forma normalizada. Sem a normalização aqui, cada "Continuar com o Google"
    // criaria uma conta nova.
    const legacy: AuthAccount = { id: 'acc-1', email: 'davi.carvalho96@gmail.com' };
    const created: CreateAccountInput[] = [];
    const linked: Array<{ accountId: string }> = [];
    const store: any = {
      findById: async () => legacy,
      findByEmail: async (email: string) => (email === legacy.email ? legacy : null),
      findByProviderIdentity: async () => null,
      linkProviderIdentity: async (input: { accountId: string }) => {
        linked.push(input);
      },
      create: async (input: CreateAccountInput) => {
        created.push(input);
        return { id: 'acc-2', email: input.email };
      },
    };
    const completeLoginCalls: any[] = [];
    const service = {
      config: { accountStore: store },
      interactions: {
        completeLogin: async (...args: any[]) => {
          completeLoginCalls.push(args);
        },
      },
    };

    await new AuthSocialController().callback(fakeSocialCtx(service, 'Davi.Carvalho96@Gmail.com'));

    assert.lengthOf(created, 0, 'não pode criar uma segunda conta para a mesma pessoa');
    assert.deepEqual(
      linked.map((l) => l.accountId),
      ['acc-1'],
    );
    assert.equal(completeLoginCalls[0][1], 'acc-1');
  });

  test('conta gravada em outra grafia ganha uma SEGUNDA conta (pede migração)', async ({
    assert,
  }) => {
    // A consequência documentada de não haver ponte: a conta mutilada pelo
    // cadastro antigo é invisível aqui, e o social cria outra. Rodar
    // `authkit:users:normalize-emails` ANTES é o que evita isto.
    const mangled: AuthAccount = { id: 'acc-1', email: 'davicarvalho96@gmail.com' };
    const created: CreateAccountInput[] = [];
    const store: any = {
      findById: async () => null,
      findByEmail: async (email: string) => (email === mangled.email ? mangled : null),
      findByProviderIdentity: async () => null,
      linkProviderIdentity: async () => {},
      create: async (input: CreateAccountInput) => {
        created.push(input);
        return { id: 'acc-2', email: input.email };
      },
    };
    const service = {
      config: { accountStore: store },
      interactions: { completeLogin: async () => {} },
    };

    await new AuthSocialController().callback(fakeSocialCtx(service, 'Davi.Carvalho96@Gmail.com'));

    assert.deepEqual(
      created.map((c) => c.email),
      ['davi.carvalho96@gmail.com'],
    );
  });

  test('conta nova nasce com o e-mail do provider normalizado', async ({ assert }) => {
    const created: CreateAccountInput[] = [];
    const store: any = {
      findById: async () => null,
      findByEmail: async () => null,
      findByProviderIdentity: async () => null,
      linkProviderIdentity: async () => {},
      create: async (input: CreateAccountInput) => {
        created.push(input);
        return { id: 'acc-1', email: input.email };
      },
    };
    const service = {
      config: { accountStore: store },
      interactions: { completeLogin: async () => {} },
    };

    await new AuthSocialController().callback(fakeSocialCtx(service, ' Davi.C@Gmail.COM '));

    assert.equal(created[0].email, 'davi.c@gmail.com');
  });
});

// ─── 6) Criação por admin ───────────────────────────────────────────────────

test.group('criação de usuário por admin', () => {
  test('recusa como `email_taken` quando a forma normalizada já existe', async ({ assert }) => {
    const legacy: AuthAccount = { id: 'acc-1', email: 'davi.carvalho96@gmail.com' };
    const created: CreateAccountInput[] = [];
    const store: any = {
      findByEmail: async (email: string) => (email === legacy.email ? legacy : null),
      create: async (input: CreateAccountInput) => {
        created.push(input);
        return { id: 'acc-2', email: input.email };
      },
    };
    const service = new AdminUsersService({ accountStore: store, login: resolveLogin() } as any);

    const result = await service.create(
      null as any,
      { email: 'Davi.Carvalho96@Gmail.com', password: 'senha-super-segura' },
      { actorId: 'admin-1', ip: null, source: 'admin-api' } as any,
    );

    assert.deepEqual(result, { ok: false, reason: 'email_taken' });
    assert.lengthOf(created, 0);
  });
});

// ─── 7) Import de usuários ──────────────────────────────────────────────────

test.group('import de usuários', () => {
  test('pula como duplicado a conta já gravada na forma normalizada', async ({ assert }) => {
    const existing: AuthAccount = { id: 'acc-1', email: 'davi.carvalho96@gmail.com' };
    const imported: Array<{ email: string }> = [];
    const store: any = {
      findByEmail: async (email: string) => (email === existing.email ? existing : null),
      importAccount: async (input: { email: string }) => {
        imported.push(input);
        return { id: 'acc-2', email: input.email };
      },
    };

    const report = await importUsers(store, [
      { line: 1, record: { email: '  Davi.Carvalho96@Gmail.com ', password_hash: 'x' } },
    ]);

    assert.lengthOf(imported, 0);
    assert.equal(report.skippedDuplicate, 1);
    assert.equal(report.created, 0);
  });

  test('grava o e-mail normalizado (senão o login não acha a conta)', async ({ assert }) => {
    const imported: Array<{ email: string }> = [];
    const store: any = {
      findByEmail: async () => null,
      importAccount: async (input: { email: string }) => {
        imported.push(input);
        return { id: 'acc-1', email: input.email };
      },
    };

    const report = await importUsers(store, [
      { line: 1, record: { email: '  Davi.Carvalho96@Gmail.com  ', password_hash: 'x' } },
    ]);

    assert.equal(report.created, 1);
    assert.equal(imported[0].email, 'davi.carvalho96@gmail.com');
  });
});
