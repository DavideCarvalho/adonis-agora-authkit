/**
 * `client` nos hooks `mail.on*`: o app (client OIDC) do fluxo em curso chega ao host,
 * para um IdP multi-app mandar e-mails com a marca de cada app. Sem client
 * (fora de uma interaction), o payload não leva `client`.
 */

import { test } from '@japa/runner';
import type { ResolvedServerConfig } from '../../src/define_config.js';
import { resolveLogin, resolvePasswordless } from '../../src/define_config.js';
import AuthInteractionController from '../../src/host/controllers/interaction_controller.js';
import { __setMailLoaderForTests, sendMagicLinkEmail } from '../../src/host/default_mailer.js';
import { resolveMessages } from '../../src/host/i18n.js';
import { notifyLoginSuccess } from '../../src/host/login_notify.js';

const SESSION_KEY = 'authkit_login_email';

const BRANDING = {
  company: 'educ(a)ção',
  default: { appName: 'Agora Hub', accent: '#111111', accentSoft: '#eeeeee', tagline: '' },
  clients: {
    'entre-textos': {
      appName: 'Entre Textos',
      accent: '#aa0000',
      accentSoft: '#ffeeee',
      tagline: '',
    },
  },
  firstParty: [],
};

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

function interactionService(params: Record<string, unknown>, registered: Record<string, any>) {
  const calls: any[] = [];
  const account = { id: 'acc-1', email: 'aluno@example.com' };
  const config: any = {
    issuer: 'https://hub.test',
    render: async (_ctx: any, view: string, props: any) => ({ view, props }),
    messages: {},
    branding: BRANDING,
    passwordless: resolvePasswordless({ magicLink: true }),
    login: resolveLogin({ otp: { enabled: false } }),
    social: undefined,
    authMethods: undefined,
    accountStore: {
      issueMagicLinkToken: async (_email: string) => ({ token: 'magic-tok', account }),
    },
    audit: { record: async () => {} },
    mail: { onMagicLink: async (data: any) => calls.push(data) },
  };
  const service = {
    config,
    interactions: { details: async () => ({ uid: 'test-uid', params }) },
    provider: { Client: { find: async (id: string) => registered[id] } },
  };
  return { service, calls };
}

function interactionCtx(service: any) {
  const session: Record<string, unknown> = { [SESSION_KEY]: 'aluno@example.com' };
  return {
    containerResolver: {
      make: async (key: string) => {
        if (key === 'authkit.server') return service;
        if (key === 'lucid.db') return noTableDb();
        throw new Error(`unknown: ${key}`);
      },
    },
    request: {
      csrfToken: 'csrf',
      param: () => 'test-uid',
      only: () => ({}),
      input: (_k: string, def?: any) => def,
      qs: () => ({}),
      ip: () => '1.2.3.4',
      header: () => undefined,
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
    response: { redirect: () => undefined },
  } as any;
}

test.group('mail hooks — client da interaction', () => {
  test('magic link numa interaction passa clientId + appName do branding', async ({ assert }) => {
    const { service, calls } = interactionService({ client_id: 'entre-textos' }, {});
    await new AuthInteractionController().magicLinkRequest(interactionCtx(service));

    assert.lengthOf(calls, 1);
    assert.deepEqual(calls[0].client, { clientId: 'entre-textos', appName: 'Entre Textos' });
  });

  test('sem branding do client: appName vem do client_name registrado', async ({ assert }) => {
    const { service, calls } = interactionService(
      { client_id: 'eduliberta' },
      { eduliberta: { clientName: 'EduLiberta' } },
    );
    await new AuthInteractionController().magicLinkRequest(interactionCtx(service));

    assert.deepEqual(calls[0].client, { clientId: 'eduliberta', appName: 'EduLiberta' });
  });

  test('client sem branding nem client_name: só clientId', async ({ assert }) => {
    const { service, calls } = interactionService({ client_id: 'anon' }, {});
    await new AuthInteractionController().magicLinkRequest(interactionCtx(service));

    assert.deepEqual(calls[0].client, { clientId: 'anon' });
  });

  test('sem client na interaction: o payload não leva `client`', async ({ assert }) => {
    const { service, calls } = interactionService({}, {});
    await new AuthInteractionController().magicLinkRequest(interactionCtx(service));

    assert.lengthOf(calls, 1);
    assert.notProperty(calls[0], 'client');
  });

  test('onNewLogin recebe o client do login concluído', async ({ assert }) => {
    const calls: any[] = [];
    const cfg = {
      issuer: 'https://hub.test',
      branding: BRANDING,
      notifications: { newLoginEmail: true, newDeviceEmail: false },
      audit: {
        record: async () => {},
        list: async () => ({ data: [{ ip: '1.2.3.4' }] }),
      },
      mail: { onNewLogin: async (data: any) => calls.push(data) },
    } as unknown as ResolvedServerConfig;
    const ctx = {
      logger: { info() {}, error() {} },
      request: { header: () => null, encryptedCookie: () => undefined },
    } as any;

    await notifyLoginSuccess(ctx, cfg, {
      accountId: 'acc-1',
      email: 'aluno@example.com',
      ip: '1.2.3.4',
      clientId: 'entre-textos',
    });
    for (let i = 0; i < 50 && calls.length === 0; i++) {
      await new Promise((r) => setImmediate(r));
    }

    assert.deepEqual(calls[0]?.client, { clientId: 'entre-textos', appName: 'Entre Textos' });
  });
});

function captureMail(sent: any[]) {
  __setMailLoaderForTests(() =>
    Promise.resolve({
      send: async (cb: any) => {
        const message: any = {};
        for (const key of ['from', 'to', 'subject', 'html', 'text']) {
          message[key] = (v: any) => {
            message[`_${key}`] = v;
            return message;
          };
        }
        cb(message);
        sent.push(message);
      },
    }),
  );
}

function mailerCfg(): ResolvedServerConfig {
  return {
    issuer: 'https://hub.test',
    locale: 'pt-BR',
    messages: resolveMessages({ locale: 'pt-BR' }),
    branding: BRANDING,
    mail: {},
  } as unknown as ResolvedServerConfig;
}

test.group('default mailer — marca por client', (group) => {
  group.each.teardown(() => __setMailLoaderForTests(undefined));

  test('client com branding: usa a marca do client', async ({ assert }) => {
    const sent: any[] = [];
    captureMail(sent);
    const ctx = { logger: { info() {}, error() {}, warn() {} } } as any;

    await sendMagicLinkEmail(
      ctx,
      { email: 'a@x.com', magicUrl: 'https://m', clientId: 'entre-textos' },
      mailerCfg(),
    );

    assert.include(sent[0]._html, 'Entre Textos');
    assert.include(sent[0]._html, '#aa0000');
    assert.notInclude(sent[0]._html, 'Agora Hub');
  });

  test('client sem branding ou sem client: cai na marca default', async ({ assert }) => {
    const sent: any[] = [];
    captureMail(sent);
    const ctx = { logger: { info() {}, error() {}, warn() {} } } as any;

    await sendMagicLinkEmail(
      ctx,
      { email: 'a@x.com', magicUrl: 'https://m', clientId: 'unknown' },
      mailerCfg(),
    );
    await sendMagicLinkEmail(ctx, { email: 'a@x.com', magicUrl: 'https://m' }, mailerCfg());

    for (const message of sent) {
      assert.include(message._html, 'Agora Hub');
      assert.include(message._html, '#111111');
      assert.notInclude(message._html, 'Entre Textos');
    }
  });
});
