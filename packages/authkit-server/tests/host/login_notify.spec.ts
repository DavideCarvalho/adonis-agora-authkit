import { test } from '@japa/runner';
import type {
  AuditEvent,
  AuditPage,
  AuditSink,
  ListAuditParams,
  StoredAuditEvent,
} from '../../src/audit/audit_sink.js';
import type { ResolvedServerConfig } from '../../src/define_config.js';
import { __setMailLoaderForTests } from '../../src/host/default_mailer.js';
import { notifyLoginSuccess } from '../../src/host/login_notify.js';
import { buildTrustedDevicePayload, TRUSTED_DEVICE_COOKIE } from '../../src/host/trusted_device.js';

/** Sink de auditoria in-memory com consulta (filtra por type + subject). */
function memorySink(): AuditSink & { events: StoredAuditEvent[] } {
  const events: StoredAuditEvent[] = [];
  let seq = 0;
  return {
    events,
    async record(event: AuditEvent) {
      events.push({ ...event, id: String(++seq), createdAt: new Date().toISOString() });
    },
    async list(params: ListAuditParams): Promise<AuditPage> {
      const data = events.filter(
        (e) =>
          (!params.type || e.type === params.type) &&
          (!params.subject || e.accountId === params.subject),
      );
      return { data, total: data.length };
    },
  };
}

/** Sink write-only (sem `list`). */
function writeOnlySink(): AuditSink & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    async record(event: AuditEvent) {
      events.push(event);
    },
  };
}

/** Mailer stub que captura os envios. */
function stubMailer() {
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
  return sent;
}

function fakeCtx(opts: { cookie?: unknown; userAgent?: string } = {}) {
  return {
    logger: { info() {}, error() {} },
    request: {
      protocol: () => 'https',
      host: () => 'idp.test',
      header: (name: string) =>
        name.toLowerCase() === 'user-agent' ? (opts.userAgent ?? null) : null,
      encryptedCookie: (name: string) => (name === TRUSTED_DEVICE_COOKIE ? opts.cookie : undefined),
    },
  } as any;
}

function cfgWith(
  audit: AuditSink | undefined,
  newLoginEmail = true,
  newDeviceEmail = false,
  extra: Partial<ResolvedServerConfig> = {},
): ResolvedServerConfig {
  return {
    // Casa com `fakeCtx().request.host()` ('idp.test') — o origin do e-mail agora
    // vem do issuer (plan 004), não de `request.host()`.
    issuer: 'https://idp.test',
    notifications: { newLoginEmail, newDeviceEmail },
    audit,
    accountStore: {
      findById: async (id: string) => ({ id, email: `${id}@x.com`, globalRoles: [] }),
    },
    ...extra,
  } as unknown as ResolvedServerConfig;
}

/** Aguarda a tarefa fire-and-forget da notificação concluir (poll de microtasks). */
async function flush(predicate: () => boolean, ticks = 50) {
  for (let i = 0; i < ticks; i++) {
    if (predicate()) return;
    await new Promise((r) => setImmediate(r));
  }
}

test.group('notifyLoginSuccess (alerta de novo acesso)', (group) => {
  group.each.teardown(() => __setMailLoaderForTests(undefined));

  test('primeiro login de um IP dispara o e-mail + audita login.new_ip_notified', async ({
    assert,
  }) => {
    const sent = stubMailer();
    const sink = memorySink();
    const cfg = cfgWith(sink);

    await notifyLoginSuccess(fakeCtx(), cfg, { accountId: 'u1', email: 'u1@x.com', ip: '1.1.1.1' });
    await flush(() => sent.length > 0);

    assert.lengthOf(sent, 1);
    assert.equal(sent[0]._to, 'u1@x.com');
    assert.equal(sent[0]._subject, 'New login to your account');
    assert.include(sent[0]._text, '1.1.1.1');
    // Auditou login.success + login.new_ip_notified.
    assert.isOk(sink.events.find((e) => e.type === 'login.success'));
    assert.isOk(sink.events.find((e) => e.type === 'login.new_ip_notified'));
  });

  test('login repetido do MESMO IP não dispara novo e-mail', async ({ assert }) => {
    const sent = stubMailer();
    const sink = memorySink();
    const cfg = cfgWith(sink);

    await notifyLoginSuccess(fakeCtx(), cfg, { accountId: 'u1', email: 'u1@x.com', ip: '2.2.2.2' });
    await flush(() => sent.length > 0);
    assert.lengthOf(sent, 1);

    // Segundo login do mesmo IP: já há um login.success deste IP → não notifica.
    await notifyLoginSuccess(fakeCtx(), cfg, { accountId: 'u1', email: 'u1@x.com', ip: '2.2.2.2' });
    await flush(() => false, 10);
    assert.lengthOf(sent, 1);
  });

  test('sink sem `list` → no-op (não envia e-mail)', async ({ assert }) => {
    const sent = stubMailer();
    const sink = writeOnlySink();
    const cfg = cfgWith(sink);

    await notifyLoginSuccess(fakeCtx(), cfg, { accountId: 'u1', email: 'u1@x.com', ip: '3.3.3.3' });
    await flush(() => false, 10);
    assert.lengthOf(sent, 0);
    // O login.success ainda foi auditado.
    assert.isOk(sink.events.find((e) => e.type === 'login.success'));
  });

  test('newLoginEmail:false desliga o alerta', async ({ assert }) => {
    const sent = stubMailer();
    const sink = memorySink();
    const cfg = cfgWith(sink, false);

    await notifyLoginSuccess(fakeCtx(), cfg, { accountId: 'u1', email: 'u1@x.com', ip: '4.4.4.4' });
    await flush(() => false, 10);
    assert.lengthOf(sent, 0);
  });

  test('resolve o e-mail via accountStore quando o caller não fornece (fluxo MFA)', async ({
    assert,
  }) => {
    const sent = stubMailer();
    const sink = memorySink();
    const cfg = cfgWith(sink);

    // Sem `email` no input → resolvido por findById ('u9@x.com').
    await notifyLoginSuccess(fakeCtx(), cfg, { accountId: 'u9', ip: '5.5.5.5' });
    await flush(() => sent.length > 0);
    assert.lengthOf(sent, 1);
    assert.equal(sent[0]._to, 'u9@x.com');
  });
});

test.group('notifyLoginSuccess (alerta de novo dispositivo)', (group) => {
  group.each.teardown(() => __setMailLoaderForTests(undefined));

  test('login SEM cookie de confiança → audita login.new_device + envia e-mail', async ({
    assert,
  }) => {
    const sent = stubMailer();
    const sink = writeOnlySink();
    // newLoginEmail off (isola o sinal de dispositivo), newDeviceEmail on.
    const cfg = cfgWith(sink, false, true);

    await notifyLoginSuccess(fakeCtx({ userAgent: 'Mozilla/5.0 TestBrowser' }), cfg, {
      accountId: 'd1',
      email: 'd1@x.com',
      ip: '7.7.7.7',
    });
    await flush(() => sent.length > 0);

    assert.lengthOf(sent, 1);
    assert.equal(sent[0]._to, 'd1@x.com');
    assert.equal(sent[0]._subject, 'New login to your account');
    assert.include(sent[0]._text, 'TestBrowser');
    assert.include(sent[0]._text, '7.7.7.7');
    assert.isOk(sink.events.find((e) => e.type === 'login.new_device'));
  });

  test('login COM cookie de confiança válido → NÃO audita nem envia', async ({ assert }) => {
    const sent = stubMailer();
    const sink = writeOnlySink();
    const cfg = cfgWith(sink, false, true);
    const cookie = buildTrustedDevicePayload('d2', { enabled: true, days: 30 });

    await notifyLoginSuccess(fakeCtx({ cookie }), cfg, {
      accountId: 'd2',
      email: 'd2@x.com',
      ip: '8.8.8.8',
    });
    await flush(() => false, 10);

    assert.lengthOf(sent, 0);
    assert.isUndefined(sink.events.find((e) => e.type === 'login.new_device'));
    // O login.success ainda foi auditado.
    assert.isOk(sink.events.find((e) => e.type === 'login.success'));
  });

  test('caller passa trustedDevice:true → pula o sinal mesmo sem cookie', async ({ assert }) => {
    const sent = stubMailer();
    const sink = writeOnlySink();
    const cfg = cfgWith(sink, false, true);

    await notifyLoginSuccess(fakeCtx(), cfg, {
      accountId: 'd3',
      email: 'd3@x.com',
      ip: '8.8.8.8',
      trustedDevice: true,
    });
    await flush(() => false, 10);

    assert.lengthOf(sent, 0);
    assert.isUndefined(sink.events.find((e) => e.type === 'login.new_device'));
  });

  test('cookie de OUTRA conta → tratado como dispositivo novo (notifica)', async ({ assert }) => {
    const sent = stubMailer();
    const sink = writeOnlySink();
    const cfg = cfgWith(sink, false, true);
    const cookie = buildTrustedDevicePayload('other', { enabled: true, days: 30 });

    await notifyLoginSuccess(fakeCtx({ cookie }), cfg, {
      accountId: 'd4',
      email: 'd4@x.com',
      ip: '8.8.8.8',
    });
    await flush(() => sent.length > 0);

    assert.lengthOf(sent, 1);
    assert.isOk(sink.events.find((e) => e.type === 'login.new_device'));
  });

  test('hook custom mail.onNewDeviceLogin tem prioridade sobre o mailer default', async ({
    assert,
  }) => {
    const sent = stubMailer();
    const sink = writeOnlySink();
    const calls: any[] = [];
    const cfg = cfgWith(sink, false, true, {
      mail: { onNewDeviceLogin: async (data: any) => calls.push(data) },
    } as any);

    await notifyLoginSuccess(fakeCtx({ userAgent: 'CustomUA' }), cfg, {
      accountId: 'd5',
      email: 'd5@x.com',
      ip: '6.6.6.6',
    });
    await flush(() => calls.length > 0);

    assert.lengthOf(calls, 1);
    assert.equal(calls[0].account.id, 'd5');
    assert.equal(calls[0].account.email, 'd5@x.com');
    assert.equal(calls[0].ip, '6.6.6.6');
    assert.equal(calls[0].userAgent, 'CustomUA');
    assert.isString(calls[0].timestamp);
    // Mailer default NÃO foi usado (hook tem prioridade).
    assert.lengthOf(sent, 0);
    assert.isOk(sink.events.find((e) => e.type === 'login.new_device'));
  });

  test('newDeviceEmail:false → não envia, mas AINDA audita login.new_device', async ({
    assert,
  }) => {
    const sent = stubMailer();
    const sink = writeOnlySink();
    const cfg = cfgWith(sink, false, false);

    await notifyLoginSuccess(fakeCtx(), cfg, { accountId: 'd6', email: 'd6@x.com', ip: '6.6.6.6' });
    await flush(() => false, 10);

    assert.lengthOf(sent, 0);
    // Audit do sinal acontece independentemente do envio.
    assert.isOk(sink.events.find((e) => e.type === 'login.new_device'));
  });

  test('fail-safe: erro no envio do hook NÃO propaga', async ({ assert }) => {
    const sent = stubMailer();
    const sink = writeOnlySink();
    const cfg = cfgWith(sink, false, true, {
      mail: {
        onNewDeviceLogin: async () => {
          throw new Error('smtp down');
        },
      },
    } as any);

    // Não deve lançar.
    await notifyLoginSuccess(fakeCtx(), cfg, { accountId: 'd7', email: 'd7@x.com', ip: '6.6.6.6' });
    await flush(() => false, 10);

    assert.lengthOf(sent, 0);
    // O audit do sinal ocorreu antes do envio (fire-and-forget).
    assert.isOk(sink.events.find((e) => e.type === 'login.new_device'));
  });
});
