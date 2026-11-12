import { test } from '@japa/runner';
import {
  __setMailLoaderForTests,
  sendEmailVerificationEmail,
  sendPasswordResetEmail,
} from '../../src/host/default_mailer.js';

/** Logger fake que captura chamadas info/error. */
function fakeLogger() {
  const calls: { level: string; meta: any; msg: string }[] = [];
  return {
    calls,
    info: (meta: any, msg: string) => calls.push({ level: 'info', meta, msg }),
    error: (meta: any, msg: string) => calls.push({ level: 'error', meta, msg }),
  };
}

/** HttpContext mínimo (logger + container sem config de mail). */
function fakeCtx(logger: any) {
  return { logger } as any;
}

test.group('default_mailer', (group) => {
  group.each.teardown(() => {
    __setMailLoaderForTests(undefined);
  });

  test('envia reset de senha via mailer default quando @adonisjs/mail está disponível', async ({
    assert,
  }) => {
    const sent: any[] = [];
    const mailStub = {
      send: async (cb: any) => {
        const message: any = {
          _from: undefined,
          _to: undefined,
          _subject: undefined,
          _text: undefined,
          _html: undefined,
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
    };
    __setMailLoaderForTests(() => Promise.resolve(mailStub));

    const logger = fakeLogger();
    await sendPasswordResetEmail(fakeCtx(logger), {
      email: 'a@b.com',
      resetUrl: 'https://host/auth/reset-password?token=x',
    });

    assert.lengthOf(sent, 1);
    assert.equal(sent[0]._to, 'a@b.com');
    assert.equal(sent[0]._subject, 'Reset your password');
    assert.include(sent[0]._text, 'https://host/auth/reset-password?token=x');
    // HTML branded com o link no botão de CTA.
    assert.include(sent[0]._html, '<!doctype html>');
    assert.include(sent[0]._html, 'https://host/auth/reset-password?token=x');
    // Sem hit de log (envio real ocorreu).
    assert.lengthOf(logger.calls, 0);
  });

  test('envia verificação de e-mail via mailer default', async ({ assert }) => {
    const sent: any[] = [];
    const mailStub = {
      send: async (cb: any) => {
        const message: any = {
          from() {
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
    };
    __setMailLoaderForTests(() => Promise.resolve(mailStub));

    const logger = fakeLogger();
    await sendEmailVerificationEmail(fakeCtx(logger), {
      email: 'c@d.com',
      verifyUrl: 'https://host/auth/verify-email?token=y',
    });

    assert.lengthOf(sent, 1);
    assert.equal(sent[0]._subject, 'Verify your email');
    assert.include(sent[0]._text, 'https://host/auth/verify-email?token=y');
    assert.include(sent[0]._html, 'https://host/auth/verify-email?token=y');
  });

  test('fallback: loga o link quando @adonisjs/mail está ausente (não lança)', async ({
    assert,
  }) => {
    __setMailLoaderForTests(() => Promise.resolve(null));

    const logger = fakeLogger();
    await sendPasswordResetEmail(fakeCtx(logger), {
      email: 'a@b.com',
      resetUrl: 'https://host/auth/reset-password?token=x',
    });

    const info = logger.calls.find((c) => c.level === 'info');
    assert.exists(info);
    assert.equal(info!.meta.resetUrl, 'https://host/auth/reset-password?token=x');
  });

  test('best-effort: erro no envio é logado, nunca propagado', async ({ assert }) => {
    const mailStub = {
      send: async () => {
        throw new Error('smtp down');
      },
    };
    __setMailLoaderForTests(() => Promise.resolve(mailStub));

    const logger = fakeLogger();
    // Não deve lançar.
    await sendEmailVerificationEmail(fakeCtx(logger), {
      email: 'c@d.com',
      verifyUrl: 'https://host/auth/verify-email?token=y',
    });

    const err = logger.calls.find((c) => c.level === 'error');
    assert.exists(err);
  });

  /** Stub de @adonisjs/mail que captura cada mensagem enviada em `sent`. */
  function captureMailStub(sent: any[]) {
    return {
      send: async (cb: any) => {
        const message: any = {
          _from: undefined,
          from(v: any) {
            this._from = v;
            return this;
          },
          to() {
            return this;
          },
          subject() {
            return this;
          },
          html() {
            return this;
          },
          text() {
            return this;
          },
        };
        cb(message);
        sent.push(message);
      },
    };
  }

  /**
   * ctx cujo container resolve o `authkit.server` (config RESOLVIDO = `configs.authkit`) e
   * cujo `app.config.get('mail')` devolve o `config/mail.ts` do host.
   */
  function fakeCtxWithConfig(logger: any, configs: Record<string, any>) {
    return {
      logger,
      containerResolver: {
        make: async (binding: string) =>
          binding === 'authkit.server' ? { config: configs.authkit } : undefined,
        app: { config: { get: (key: string) => configs[key] } },
      },
    } as any;
  }

  test('from: o `mail.from` do authkit tem prioridade sobre o `mail.from` do host', async ({
    assert,
  }) => {
    const sent: any[] = [];
    __setMailLoaderForTests(() => Promise.resolve(captureMailStub(sent)));

    const ctx = fakeCtxWithConfig(fakeLogger(), {
      authkit: { mail: { from: 'Auth <no-reply-auth@host>' } },
      mail: { from: 'App <no-reply@host>' },
    });
    await sendPasswordResetEmail(ctx, {
      email: 'a@b.com',
      resetUrl: 'https://host/auth/reset-password?token=x',
    });

    assert.lengthOf(sent, 1);
    assert.equal(sent[0]._from, 'Auth <no-reply-auth@host>');
  });

  test('from: cai no `mail.from` do host quando o authkit não define', async ({ assert }) => {
    const sent: any[] = [];
    __setMailLoaderForTests(() => Promise.resolve(captureMailStub(sent)));

    const ctx = fakeCtxWithConfig(fakeLogger(), {
      authkit: { mail: {} },
      mail: { from: 'App <no-reply@host>' },
    });
    await sendPasswordResetEmail(ctx, {
      email: 'a@b.com',
      resetUrl: 'https://host/auth/reset-password?token=x',
    });

    assert.lengthOf(sent, 1);
    assert.equal(sent[0]._from, 'App <no-reply@host>');
  });

  test('from: sem `from` em lugar nenhum, não chama message.from (deixa o @adonisjs/mail decidir)', async ({
    assert,
  }) => {
    const sent: any[] = [];
    __setMailLoaderForTests(() => Promise.resolve(captureMailStub(sent)));

    const ctx = fakeCtxWithConfig(fakeLogger(), { authkit: { mail: {} }, mail: {} });
    await sendPasswordResetEmail(ctx, {
      email: 'a@b.com',
      resetUrl: 'https://host/auth/reset-password?token=x',
    });

    assert.lengthOf(sent, 1);
    assert.isUndefined(sent[0]._from);
  });
});
