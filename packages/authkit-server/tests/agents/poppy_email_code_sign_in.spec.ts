import { test } from '@japa/runner';
import { maskEmail, poppyEmailCodeSignIn } from '../../src/agents/poppy/email_code_sign_in.js';

const CLIENT_ID = 'https://agent.example/agent.json';

/** Ctx falso: `authkit.server` com contas em memória e o hook de e-mail capturando. */
function setup(
  opts: {
    accounts?: Record<string, { id: string; disabled?: boolean; kind?: string }>;
    hook?: boolean;
  } = {},
) {
  const accounts = opts.accounts ?? { 'jane@example.com': { id: 'acct-1' } };
  const mails: any[] = [];
  const service = {
    config: {
      accountStore: {
        findByEmail: async (email: string) => {
          const a = accounts[email];
          return a ? { id: a.id, email, kind: a.kind } : null;
        },
        findById: async () => null,
        isDisabled: async (id: string) =>
          Object.values(accounts).some((a) => a.id === id && a.disabled),
        disableAccount: async () => {},
      },
      mail: opts.hook === false ? {} : { onPoppySignInCode: async (data: any) => mails.push(data) },
    },
  };
  const logs: any[] = [];
  const ctx = {
    containerResolver: {
      make: async (k: string) => {
        if (k === 'authkit.server') return service;
        throw new Error(`no binding for ${k}`);
      },
    },
    logger: { error: (...a: any[]) => logs.push(a), info: (...a: any[]) => logs.push(a) },
  } as any;
  const verify = (cfg: ReturnType<typeof poppyEmailCodeSignIn>, email: string) =>
    cfg.verify({
      credentials: { email },
      scopes: ['poppy:read'],
      clientId: CLIENT_ID,
      userId: 'usr_1',
      sessionId: 'ses_1',
      ctx,
    });
  const flush = () => new Promise((r) => setImmediate(r));
  return { verify, mails, logs, flush };
}

test.group('poppyEmailCodeSignIn', () => {
  test('conta ativa: código de 6 dígitos, e-mail com o código e o nome do agente', async ({
    assert,
  }) => {
    const cfg = poppyEmailCodeSignIn({ codeTtl: 300 });
    assert.deepEqual(cfg.fields, [{ name: 'email', label: 'Email address', secret: false }]);
    assert.equal(cfg.codeTtl, 300);

    const { verify, mails, flush } = setup();
    const res: any = await verify(cfg, '  Jane@Example.com ');
    assert.equal(res.status, 'code_required');
    assert.equal(res.accountId, 'acct-1');
    assert.equal(res.sentTo, 'Email to j***@example.com');
    assert.match(res.code, /^\d{6}$/);

    await flush();
    assert.deepEqual(mails, [
      {
        email: 'jane@example.com',
        code: res.code,
        agentName: 'agent.example',
        expiresInMinutes: 5,
      },
    ]);
  });

  test('sem conta, desativada ou recusada por eligible: mesma resposta, sem código nem e-mail', async ({
    assert,
  }) => {
    const cfg = poppyEmailCodeSignIn({ eligible: (a: any) => a.kind !== 'pro' });
    const { verify, mails, flush } = setup({
      accounts: {
        'off@example.com': { id: 'acct-2', disabled: true },
        'pro@example.com': { id: 'acct-3', kind: 'pro' },
      },
    });
    for (const email of ['nobody@example.com', 'off@example.com', 'pro@example.com']) {
      const res: any = await verify(cfg, email);
      assert.deepEqual(Object.keys(res).sort(), ['accountId', 'sentTo', 'status']);
      assert.equal(res.status, 'code_required');
      assert.isNull(res.accountId);
      assert.equal(res.sentTo, `Email to ${maskEmail(email)}`);
    }
    await flush();
    assert.lengthOf(mails, 0);
  });

  test('e-mail malformado → failed', async ({ assert }) => {
    const { verify } = setup();
    for (const email of ['', 'jane', 'jane@', '@example.com', 'a b@example.com']) {
      assert.deepEqual(await verify(poppyEmailCodeSignIn(), email), { status: 'failed' });
    }
  });

  test('limite por e-mail: acima dele a resposta é a de conta inexistente, sem e-mail', async ({
    assert,
  }) => {
    const cfg = poppyEmailCodeSignIn({ maxPerHour: 2 });
    const { verify, mails, flush } = setup();
    assert.equal(((await verify(cfg, 'jane@example.com')) as any).accountId, 'acct-1');
    assert.equal(((await verify(cfg, 'jane@example.com')) as any).accountId, 'acct-1');
    const third: any = await verify(cfg, 'jane@example.com');
    assert.isNull(third.accountId);
    assert.notProperty(third, 'code');
    // O limite conta também para e-mails sem conta.
    await verify(cfg, 'nobody@example.com');
    await verify(cfg, 'nobody@example.com');
    assert.notProperty(await verify(cfg, 'nobody@example.com'), 'code');
    await flush();
    assert.lengthOf(mails, 2);
  });

  test('sem hook nem @adonisjs/mail: o código sai no log (dev)', async ({ assert }) => {
    const { verify, logs, flush } = setup({ hook: false });
    const res: any = await verify(poppyEmailCodeSignIn(), 'jane@example.com');
    for (let i = 0; i < 5 && logs.length === 0; i++) await flush();
    await new Promise((r) => setTimeout(r, 50));
    const entry = logs.find((l) => l[0]?.code === res.code);
    assert.isOk(entry, JSON.stringify(logs));
  });

  test('scopes, label e sentTo configuráveis', async ({ assert }) => {
    const cfg = poppyEmailCodeSignIn({
      scopes: ['saude:leitura'],
      label: 'E-mail',
      sentTo: (m) => `E-mail para ${m}`,
      maxCodeAttempts: 3,
    });
    assert.deepEqual(cfg.scopes, ['saude:leitura']);
    assert.equal(cfg.fields[0].label, 'E-mail');
    assert.equal(cfg.maxCodeAttempts, 3);
    const { verify } = setup();
    assert.equal(
      ((await verify(cfg, 'jane@example.com')) as any).sentTo,
      'E-mail para j***@example.com',
    );
  });
});

test.group('poppyEmailCodeSignIn — fluxo Mediated completo', () => {
  test('o código do e-mail entra na conta; o nome do agente vem da metadata', async ({
    assert,
  }) => {
    const { setupPoppy, dpopKey, apiRequest, POPPY_ISSUER, ACCOUNT_ID } = await import(
      './poppy_helpers.js'
    );
    const env = await setupPoppy({ signIn: { mediated: poppyEmailCodeSignIn() } });
    const mails: any[] = [];
    const config: any = env.service.config;
    config.accountStore.findByEmail = async (email: string) =>
      email === 'jane@example.com' ? { id: ACCOUNT_ID, email } : null;
    config.mail = { onPoppySignInCode: async (data: any) => mails.push(data) };
    const ctx = {
      containerResolver: {
        make: async (k: string) => {
          if (k === 'authkit.server') return env.service;
          if (k === 'lucid.db') return env.db;
          throw new Error(`no binding for ${k}`);
        },
      },
      logger: { error() {}, info() {} },
    } as any;

    const dkey = await dpopKey();
    const s = await env.startSession(dkey);
    const auth = async (url: string) => {
      const r = await env.poppy.verifyAccess(
        await apiRequest(dkey, s.access_token, { method: 'POST', url }),
      );
      if (!r.ok) throw new Error(r.error);
      return r;
    };
    const doc = env.poppy.discoveryDocument('shop.example') as any;
    assert.deepEqual(doc.auth.mediated.fields, [
      { name: 'email', label: 'Email address', secret: false },
    ]);

    const a = await auth(`${POPPY_ISSUER}/sign-in`);
    const started = (await env.poppy.mediatedStart(
      a.principal,
      a.jkt,
      { scope: 'poppy:read', credentials: { email: 'jane@example.com' } },
      ctx,
    )) as any;
    assert.equal(started.status, 'code_required');
    assert.equal(started.code.sent_to, 'Email to j***@example.com');
    assert.notProperty(started, 'code_value');

    for (let i = 0; i < 20 && mails.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.lengthOf(mails, 1);
    assert.equal(mails[0].agentName, 'Example Agent');

    const url = `${POPPY_ISSUER}/sign-in/${started.sign_in_id}`;
    const b = await auth(url);
    const done = (await env.poppy.mediatedCode(b.principal, b.jkt, started.sign_in_id, {
      code: mails[0].code,
    })) as any;
    assert.equal(done.status, 'complete');
    assert.isTrue(done.signed_in);
    assert.lengthOf(await env.poppy.listGrants(ACCOUNT_ID), 1);
    await env.close();
  });
});
