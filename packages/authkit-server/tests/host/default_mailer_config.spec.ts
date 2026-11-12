import { Container } from '@adonisjs/core/container';
import { test } from '@japa/runner';
import type { ResolvedServerConfig } from '../../src/define_config.js';
import {
  __resetMailConfigWarningForTests,
  __setMailLoaderForTests,
  sendAuthkitCodeEmail,
  sendEmailChangeConfirmationEmail,
  sendEmailVerificationEmail,
  sendMagicLinkEmail,
  sendNewDeviceLoginEmail,
  sendNewLoginEmail,
  sendOrgInvitationEmail,
  sendOtpUnlockEmail,
  sendPasswordResetEmail,
  sendSudoLinkEmail,
} from '../../src/host/default_mailer.js';
import { resolveMessages } from '../../src/host/i18n.js';
import { notifyLoginSuccess } from '../../src/host/login_notify.js';

/**
 * Regressão: em produção (Entre Textos, `i18n.locale: 'pt-BR'`, `branding.company`)
 * o alerta de novo login saiu em INGLÊS com o cabeçalho "AuthKit". O mailer default lia
 * o config por `ctx.containerResolver.app.config.get('authkit')` — mas o
 * `ContainerResolver` real do `@adonisjs/fold` não tem `.app`, e o try/catch engolia o
 * resto. Estes testes usam um ctx com o resolver REAL do fold, como o de uma request.
 */

/** Config resolvido de um host pt-BR com só `company` + `clients` no branding. */
function hostCfg(extra: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig {
  return {
    issuer: 'https://auth.entretextos.test',
    locale: 'pt-BR',
    messages: resolveMessages({ locale: 'pt-BR' }),
    // Sem `default`: o host declarou só `company` + `clients`.
    branding: { company: 'educ(a)ção', clients: {}, firstParty: [] },
    mail: { from: 'Segurança <no-reply-auth@entretextos.test>' },
    notifications: { newLoginEmail: true, newDeviceEmail: true },
    ...extra,
  } as unknown as ResolvedServerConfig;
}

function captureMail(sent: any[]) {
  __setMailLoaderForTests(() =>
    Promise.resolve({
      send: async (cb: any) => {
        const message: any = {
          from(v: any) {
            this._from = v;
            return this;
          },
          to(v: any) {
            this._to = v;
            return this;
          },
          subject(v: any) {
            this._subject = v;
            return this;
          },
          html(v: any) {
            this._html = v;
            return this;
          },
          text(v: any) {
            this._text = v;
            return this;
          },
        };
        cb(message);
        sent.push(message);
      },
    }),
  );
}

function captureLogger() {
  const calls: { level: string; args: unknown[] }[] = [];
  const log =
    (level: string) =>
    (...args: unknown[]) =>
      calls.push({ level, args });
  return { calls, info: log('info'), warn: log('warn'), error: log('error') };
}

/** ctx como o de uma request real: `containerResolver` é o resolver do fold (sem `.app`). */
function requestCtx(container = new Container<any>(), logger = captureLogger()) {
  return {
    logger,
    containerResolver: container.createResolver(),
    request: {
      header: () => null,
      encryptedCookie: () => undefined,
    },
  } as any;
}

function assertPtBrBranded(assert: any, message: any, subject: string) {
  assert.equal(message._subject, subject);
  assert.include(message._html, 'lang="pt-BR"');
  assert.include(message._html, 'educ(a)ção');
  assert.notInclude(message._html, 'AuthKit');
  assert.equal(message._from, 'Segurança <no-reply-auth@entretextos.test>');
}

async function flush(predicate: () => boolean, ticks = 50) {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
}

test.group('default mailer — config do host (i18n + branding)', (group) => {
  group.each.setup(() => __resetMailConfigWarningForTests());
  group.each.teardown(() => __setMailLoaderForTests(undefined));

  test('alerta de novo login (fire-and-forget pós-login) sai em pt-BR com a marca do host', async ({
    assert,
  }) => {
    const sent: any[] = [];
    captureMail(sent);
    const audit = {
      record: async () => {},
      list: async () => ({ data: [{ ip: '200.1.2.3' }], total: 1 }),
    };
    const cfg = hostCfg({
      audit: audit as any,
      notifications: { newLoginEmail: true, newDeviceEmail: false } as any,
    });

    await notifyLoginSuccess(requestCtx(), cfg, {
      accountId: 'acc-1',
      email: 'aluno@x.com',
      ip: '200.1.2.3',
    });
    await flush(() => sent.length > 0);

    assert.lengthOf(sent, 1);
    assertPtBrBranded(assert, sent[0], 'Novo login na sua conta');
  });

  test('todo send*Email usa o cfg do chamador mesmo com um resolver sem `.app`', async ({
    assert,
  }) => {
    const sent: any[] = [];
    captureMail(sent);
    const cfg = hostCfg();
    const ctx = requestCtx();

    await sendNewLoginEmail(ctx, cfg, { email: 'a@x.com', ip: '1.1.1.1', when: 'agora' });
    await sendNewDeviceLoginEmail(ctx, cfg, { email: 'a@x.com', when: 'agora' });
    await sendPasswordResetEmail(ctx, { email: 'a@x.com', resetUrl: 'https://r' }, cfg);
    await sendEmailVerificationEmail(ctx, { email: 'a@x.com', verifyUrl: 'https://v' }, cfg);
    await sendEmailChangeConfirmationEmail(ctx, { email: 'a@x.com', confirmUrl: 'https://c' }, cfg);
    await sendMagicLinkEmail(ctx, { email: 'a@x.com', magicUrl: 'https://m' }, cfg);
    await sendOtpUnlockEmail(ctx, { email: 'a@x.com', unlockUrl: 'https://u' }, cfg);
    await sendSudoLinkEmail(ctx, { email: 'a@x.com', sudoUrl: 'https://s' }, cfg);
    await sendOrgInvitationEmail(
      ctx,
      {
        email: 'a@x.com',
        invitationId: 'i',
        orgName: 'Acme',
        orgSlug: 'acme',
        role: 'admin',
        acceptUrl: 'https://a',
        token: 't',
      },
      cfg,
    );

    assert.deepEqual(
      sent.map((m) => m._subject),
      [
        'Novo login na sua conta',
        'Novo login na sua conta',
        'Redefinição de senha',
        resolveMessages({ locale: 'pt-BR' })['mail.verify.subject'],
        resolveMessages({ locale: 'pt-BR' })['mail.email_change.subject'],
        resolveMessages({ locale: 'pt-BR' })['mail.magic_link.subject'],
        resolveMessages({ locale: 'pt-BR' })['mail.otp_unlock.subject'],
        resolveMessages({ locale: 'pt-BR' })['mail.sudo_link.subject'],
        resolveMessages({ locale: 'pt-BR' })['mail.org_invitation.subject'].replace(
          '{org}',
          'Acme',
        ),
      ],
    );
    for (const message of sent) assertPtBrBranded(assert, message, message._subject);
  });

  test('sem cfg do chamador: resolve pelo binding `authkit.server` do container da request', async ({
    assert,
  }) => {
    const sent: any[] = [];
    captureMail(sent);
    const container = new Container<any>();
    container.singleton('authkit.server' as any, async () => ({ config: hostCfg() }));

    await sendPasswordResetEmail(requestCtx(container), {
      email: 'a@x.com',
      resetUrl: 'https://r',
    });

    assert.lengthOf(sent, 1);
    assertPtBrBranded(assert, sent[0], 'Redefinição de senha');
  });

  test('sem cfg do chamador: ctx do SDK embedded (`containerResolver: { app }`) resolve pelo app.container', async ({
    assert,
  }) => {
    const sent: any[] = [];
    captureMail(sent);
    const container = new Container<any>();
    container.singleton('authkit.server' as any, async () => ({ config: hostCfg() }));
    // `config.get('authkit')` num app real devolve o ConfigProvider preguiçoso do
    // `defineConfig` — não tem `i18n`/`branding`.
    const app = { container, config: { get: () => ({ type: 'provider', resolver: () => {} }) } };

    await sendAuthkitCodeEmail({ logger: captureLogger(), containerResolver: { app } } as any, {
      email: 'a@x.com',
      code: '123456',
      messages: 'mail.magic_link',
    });

    assert.lengthOf(sent, 1);
    assert.include(sent[0]._html, 'lang="pt-BR"');
    assert.include(sent[0]._html, 'educ(a)ção');
  });

  test('branding: `default.appName` tem prioridade sobre `company`', async ({ assert }) => {
    const sent: any[] = [];
    captureMail(sent);
    const cfg = hostCfg({
      branding: {
        company: 'educ(a)ção',
        clients: {},
        firstParty: [],
        default: { appName: 'Entre Textos', accent: '#123456', accentSoft: '#fff', tagline: '' },
      },
    });

    await sendPasswordResetEmail(requestCtx(), { email: 'a@x.com', resetUrl: 'https://r' }, cfg);

    assert.include(sent[0]._html, 'Entre Textos');
    assert.include(sent[0]._html, '#123456');
  });

  test('config irresolvível: cai em en/AuthKit mas avisa (uma vez só)', async ({ assert }) => {
    const sent: any[] = [];
    captureMail(sent);
    const logger = captureLogger();
    const ctx = requestCtx(new Container<any>(), logger);

    await sendPasswordResetEmail(ctx, { email: 'a@x.com', resetUrl: 'https://r' });
    await sendPasswordResetEmail(ctx, { email: 'a@x.com', resetUrl: 'https://r' });

    assert.lengthOf(sent, 2);
    assert.equal(sent[0]._subject, 'Reset your password');
    const warns = logger.calls.filter((c) => c.level === 'warn');
    assert.lengthOf(warns, 1);
    assert.match(String(warns[0].args.at(-1)), /config do authkit não resolvido/);
  });
});
