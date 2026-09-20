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
 * "login" vermelho; tirar a ponte legada tranca de novo a conta já mutilada.
 */

import { test } from '@japa/runner';
import type { AccountStore, AuthAccount } from '../../src/accounts/account_store.js';
import { resolveLogin, resolvePasswordless } from '../../src/define_config.js';
import InteractionController from '../../src/host/controllers/interaction_controller.js';
import {
  legacyNormalizeEmailIdentifier,
  normalizeEmailIdentifier,
  resolveEmailIdentifier,
} from '../../src/host/email_identifier.js';
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

function buildService(store: AccountStore, login?: { legacyEmailFallback?: boolean }) {
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
    login: resolveLogin(login),
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
async function loginWith(
  store: AccountStore,
  typed: string,
  login?: { legacyEmailFallback?: boolean },
) {
  const { service, rendered } = buildService(store, login);
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

test.group('legacyNormalizeEmailIdentifier (réplica do validator.js)', () => {
  test('reproduz os defaults que mutilavam o endereço', ({ assert }) => {
    assert.equal(
      legacyNormalizeEmailIdentifier('Davi.Carvalho96@Gmail.com'),
      'davicarvalho96@gmail.com',
    );
    assert.equal(
      legacyNormalizeEmailIdentifier('davi.carvalho96+lastro@gmail.com'),
      'davicarvalho96@gmail.com',
    );
    assert.equal(legacyNormalizeEmailIdentifier('davi@googlemail.com'), 'davi@gmail.com');
    assert.equal(legacyNormalizeEmailIdentifier('davi+x@outlook.com'), 'davi@outlook.com');
    assert.equal(legacyNormalizeEmailIdentifier('davi+x@icloud.com'), 'davi@icloud.com');
    assert.equal(legacyNormalizeEmailIdentifier('davi-loja@yahoo.com'), 'davi@yahoo.com');
    assert.equal(legacyNormalizeEmailIdentifier('Davi@yandex.com'), 'davi@yandex.ru');
    // Domínio comum: só lowercase (nada de ponto/tag removidos).
    assert.equal(legacyNormalizeEmailIdentifier('davi.c+x@acme.com'), 'davi.c+x@acme.com');
    // Pontos consecutivos NÃO eram removidos pelo validator.js.
    assert.equal(legacyNormalizeEmailIdentifier('davi..c@gmail.com'), 'davi..c@gmail.com');
  });

  test('recusa entradas sem local part utilizável', ({ assert }) => {
    assert.isNull(legacyNormalizeEmailIdentifier('+x@gmail.com'));
    assert.isNull(legacyNormalizeEmailIdentifier('nao-e-email'));
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

// ─── 4) Ponte: contas gravadas com o endereço mutilado ──────────────────────

test.group('ponte legada', () => {
  test('conta legada mutilada ainda entra digitando o endereço certo', async ({ assert }) => {
    // Nasceu no cadastro antigo: o ponto foi removido na gravação.
    const store = storeWith(['davicarvalho96@gmail.com']);
    const { props, session } = await loginWith(store, 'davi.carvalho96@gmail.com');
    assert.isNotNull(props.account, 'a ponte deveria reencontrar a conta mutilada');
    // A TELA continua mostrando o que a pessoa digitou (não vaza o endereço gravado).
    assert.equal(props.email, 'davi.carvalho96@gmail.com');
    // A BUSCA usa o endereço gravado.
    assert.equal(session.authkit_login_email_lookup, 'davicarvalho96@gmail.com');
  });

  test('conta gravada com maiúsculas (import/convite/social) ainda entra', async ({ assert }) => {
    const store = storeWith(['Davi@Acme.com']);
    const { props } = await loginWith(store, 'Davi@Acme.com');
    assert.isNotNull(props.account);
  });

  test('empate (duas contas no mesmo balde legado) é RECUSADO', async ({ assert }) => {
    // `Davi.C@Gmail.com` (gravada crua por um fluxo sem normalização) e
    // `davic@gmail.com` (gravada mutilada pelo cadastro legado) são duas contas
    // distintas: a lib não adivinha qual é a pessoa.
    const store = storeWith(['Davi.C@Gmail.com', 'davic@gmail.com']);
    const { props, session } = await loginWith(store, 'Davi.C@Gmail.com');
    assert.isNull(props.account, 'empate não pode escolher uma conta');
    // Mesma tela de sempre — nada sinaliza que houve empate.
    assert.equal(props.step, 'password');
    assert.equal(props.email, 'davi.c@gmail.com');
    assert.isUndefined(session.authkit_login_email_lookup);
  });

  test('`login.legacyEmailFallback: false` desliga a ponte', async ({ assert }) => {
    const store = storeWith(['davicarvalho96@gmail.com']);
    const { props } = await loginWith(store, 'davi.carvalho96@gmail.com', {
      legacyEmailFallback: false,
    });
    assert.isNull(props.account);
  });
});

// ─── 5) resolveEmailIdentifier (unidade) ────────────────────────────────────

test.group('resolveEmailIdentifier', () => {
  test('caminho direto faz UMA busca só', async ({ assert }) => {
    const calls: string[] = [];
    const store = {
      findByEmail: async (email: string) => {
        calls.push(email);
        return email === 'davi@acme.com' ? ({ id: 'a', email } as AuthAccount) : null;
      },
    };
    const out = await resolveEmailIdentifier(store, 'davi@acme.com');
    assert.deepEqual(calls, ['davi@acme.com']);
    assert.equal(out.lookupEmail, 'davi@acme.com');
    assert.isFalse(out.viaLegacyFallback);
  });

  test('e-mail desconhecido SEM forma alternativa também faz UMA busca só', async ({ assert }) => {
    const calls: string[] = [];
    const store = {
      findByEmail: async (email: string) => {
        calls.push(email);
        return null;
      },
    };
    await resolveEmailIdentifier(store, 'ninguem@acme.com');
    assert.deepEqual(calls, ['ninguem@acme.com']);
  });

  test('entrada vazia não toca no store', async ({ assert }) => {
    let called = false;
    const store = {
      findByEmail: async () => {
        called = true;
        return null;
      },
    };
    const out = await resolveEmailIdentifier(store, '   ');
    assert.isFalse(called);
    assert.equal(out.email, '');
    assert.isNull(out.account);
  });
});
