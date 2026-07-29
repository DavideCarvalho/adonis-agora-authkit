/**
 * Testes para o serviço de notificações de segurança e integração com
 * e-mails de troca de e-mail verificada.
 *
 * Cobre:
 * - dispatchSecurityNotice: settings on/off, kinds, hook custom, fail-safe
 * - security_notifications runtime setting resolver
 * - email_change runtime setting resolver
 * - e-mails de troca de e-mail (notice ao atual, confirm ao novo, completed ao antigo)
 * - audit events: security_notice.sent
 */

import { test } from '@japa/runner';
import type { AuditEvent } from '../../src/audit/audit_sink.js';
import {
  __setMailLoaderForTests,
  sendEmailChangeNoticeEmail,
  sendEmailChangedCompletedEmail,
  sendSecurityNoticeEmail,
} from '../../src/host/default_mailer.js';
import {
  ALL_SECURITY_NOTIFICATION_KINDS,
  type SecurityNotificationKind,
  resolveEffectiveEmailChange,
  resolveEffectiveSecurityNotifications,
} from '../../src/host/runtime_toggles.js';
import { dispatchSecurityNotice } from '../../src/host/security_notice_service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Config mínima usada só para `authkitOrigin(cfg)` dentro dos mailer helpers —
 * o issuer casa com o `host()` de `fakeCtx` (`acme.example.com`) para preservar
 * o comportamento (e as asserções) de antes da conversão issuer-based (plan 004).
 */
const FAKE_CFG = { issuer: 'https://acme.example.com' } as any;

function fakeRuntimeSettings(value: Record<string, unknown> | null) {
  return {
    async isTablePresent() {
      return value !== null;
    },
    async getSetting(key: string) {
      return value && (value[key] ?? null);
    },
    async setSetting() {},
    async deleteSetting() {},
  } as any;
}

function fakeLogger() {
  const calls: { level: string; meta: any; msg: string }[] = [];
  return {
    calls,
    info: (meta: any, msg: string) => calls.push({ level: 'info', meta, msg }),
    error: (meta: any, msg: string) => calls.push({ level: 'error', meta, msg }),
    warn: (meta: any, msg: string) => calls.push({ level: 'warn', meta, msg }),
  };
}

/** HttpContext mínimo para testes de mailer. */
function fakeCtx(logger: ReturnType<typeof fakeLogger>, extra?: { containerDb?: any }) {
  return {
    logger,
    request: {
      protocol: () => 'https',
      host: () => 'acme.example.com',
      ip: () => '1.2.3.4',
    },
    containerResolver: {
      make: async (key: string) => {
        if (key === 'lucid.db' && extra?.containerDb) return extra.containerDb;
        throw new Error(`container key not found: ${key}`);
      },
    },
  } as any;
}

// ---------------------------------------------------------------------------
// resolveEffectiveSecurityNotifications
// ---------------------------------------------------------------------------

test.group('resolveEffectiveSecurityNotifications', () => {
  test('retorna defaults quando tabela ausente', async ({ assert }) => {
    const settings = fakeRuntimeSettings(null);
    const result = await resolveEffectiveSecurityNotifications(settings);
    assert.equal(result.enabled, true);
    assert.deepEqual(result.kinds, [...ALL_SECURITY_NOTIFICATION_KINDS]);
  });

  test('retorna defaults quando setting não encontrada', async ({ assert }) => {
    const settings = fakeRuntimeSettings({}); // tabela existe, setting ausente
    const result = await resolveEffectiveSecurityNotifications(settings);
    assert.equal(result.enabled, true);
    assert.deepEqual(result.kinds, [...ALL_SECURITY_NOTIFICATION_KINDS]);
  });

  test('respeita enabled: false da setting', async ({ assert }) => {
    const settings = fakeRuntimeSettings({ security_notifications: { enabled: false } });
    const result = await resolveEffectiveSecurityNotifications(settings);
    assert.equal(result.enabled, false);
  });

  test('respeita kinds customizados da setting', async ({ assert }) => {
    const settings = fakeRuntimeSettings({
      security_notifications: { enabled: true, kinds: ['password_changed', 'mfa_enabled'] },
    });
    const result = await resolveEffectiveSecurityNotifications(settings);
    assert.equal(result.enabled, true);
    assert.deepEqual(result.kinds, ['password_changed', 'mfa_enabled']);
  });

  test('ignora kinds inválidos e usa defaults quando array vazio', async ({ assert }) => {
    const settings = fakeRuntimeSettings({
      security_notifications: { enabled: true, kinds: ['invalid_event'] },
    });
    const result = await resolveEffectiveSecurityNotifications(settings);
    // kinds inválidos são filtrados; array vazio → volta ao default
    assert.deepEqual(result.kinds, [...ALL_SECURITY_NOTIFICATION_KINDS]);
  });

  test('fail-safe quando getSetting lança', async ({ assert }) => {
    const failSettings = {
      async isTablePresent() {
        return true;
      },
      async getSetting() {
        throw new Error('db down');
      },
    } as any;
    const result = await resolveEffectiveSecurityNotifications(failSettings);
    // Deve retornar defaults sem lançar
    assert.equal(result.enabled, true);
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveEmailChange
// ---------------------------------------------------------------------------

test.group('resolveEffectiveEmailChange', () => {
  test('retorna defaults quando tabela ausente', async ({ assert }) => {
    const settings = fakeRuntimeSettings(null);
    const result = await resolveEffectiveEmailChange(settings);
    assert.equal(result.enabled, true);
    assert.equal(result.ttlHours, 24);
    assert.equal(result.requirePassword, true);
  });

  test('retorna defaults quando setting ausente', async ({ assert }) => {
    const settings = fakeRuntimeSettings({});
    const result = await resolveEffectiveEmailChange(settings);
    assert.equal(result.enabled, true);
    assert.equal(result.ttlHours, 24);
    assert.equal(result.requirePassword, true);
  });

  test('respeita enabled: false', async ({ assert }) => {
    const settings = fakeRuntimeSettings({ email_change: { enabled: false } });
    const result = await resolveEffectiveEmailChange(settings);
    assert.equal(result.enabled, false);
  });

  test('respeita ttlHours customizado', async ({ assert }) => {
    const settings = fakeRuntimeSettings({ email_change: { enabled: true, ttlHours: 48 } });
    const result = await resolveEffectiveEmailChange(settings);
    assert.equal(result.ttlHours, 48);
  });

  test('ignora ttlHours <= 0 e usa default 24', async ({ assert }) => {
    const settings = fakeRuntimeSettings({ email_change: { enabled: true, ttlHours: 0 } });
    const result = await resolveEffectiveEmailChange(settings);
    assert.equal(result.ttlHours, 24);
  });

  test('respeita requirePassword: false', async ({ assert }) => {
    const settings = fakeRuntimeSettings({
      email_change: { enabled: true, requirePassword: false },
    });
    const result = await resolveEffectiveEmailChange(settings);
    assert.equal(result.requirePassword, false);
  });

  test('fail-safe quando getSetting lança', async ({ assert }) => {
    const failSettings = {
      async isTablePresent() {
        return true;
      },
      async getSetting() {
        throw new Error('db down');
      },
    } as any;
    const result = await resolveEffectiveEmailChange(failSettings);
    assert.equal(result.enabled, true);
    assert.equal(result.ttlHours, 24);
  });
});

// ---------------------------------------------------------------------------
// dispatchSecurityNotice
// ---------------------------------------------------------------------------

test.group('dispatchSecurityNotice', (group) => {
  group.each.teardown(() => __setMailLoaderForTests(undefined));

  /** Stub de mail service que captura chamadas. */
  function mailStub(sent: any[]) {
    return {
      send: async (cb: any) => {
        const msg: any = {
          _from: undefined,
          _to: undefined,
          _subject: undefined,
          _html: undefined,
          _text: undefined,
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
        await cb(msg);
        sent.push(msg);
      },
    };
  }

  /**
   * DB fake que retorna settings configuradas.
   * Estrutura esperada por RuntimeSettings:
   *   db.connection() → { schema: { hasTable } }
   *   db.table(name).where(key, value).first() → row | null
   */
  function fakeDbWithSettings(settingsByKey: Record<string, unknown>) {
    const db: any = {
      from(name: string) {
        return this.table(name);
      },
      table(_name: string) {
        const filters: Array<{ col: string; val: string | null; isNull: boolean }> = [];
        function makeChain(f: typeof filters): any {
          const q: any = {
            where(col: string, val: string) {
              return makeChain([...f, { col, val, isNull: false }]);
            },
            whereNull(col: string) {
              return makeChain([...f, { col, val: null, isNull: true }]);
            },
            async first() {
              const keyFilter = f.find((x) => x.col === 'key');
              const keyVal = keyFilter?.val;
              if (keyVal && keyVal in settingsByKey) {
                return {
                  key: keyVal,
                  organization_id: null,
                  value: JSON.stringify(settingsByKey[keyVal]),
                };
              }
              return null;
            },
            delete: async () => {},
            insert: async () => {},
            // select().limit() → probe (table present quando não lança).
            select(_cols?: string) {
              return {
                limit(_n: number) {
                  return Promise.resolve([]);
                },
                then(resolve: any, reject: any) {
                  return Promise.resolve([]).then(resolve, reject);
                },
                where(_c: string, _v: string) {
                  return {
                    limit: (_n: number) => Promise.resolve([]),
                    then: (r: any, _j: any) => Promise.resolve([]).then(r),
                  };
                },
                whereNull(_c: string) {
                  return {
                    limit: (_n: number) => Promise.resolve([]),
                    then: (r: any, _j: any) => Promise.resolve([]).then(r),
                  };
                },
              };
            },
          };
          return q;
        }
        return makeChain(filters);
      },
    };
    return db;
  }

  test('não envia quando enabled: false na setting', async ({ assert }) => {
    const sent: any[] = [];
    __setMailLoaderForTests(() => Promise.resolve(mailStub(sent)));

    const db = fakeDbWithSettings({ security_notifications: { enabled: false } });
    const logger = fakeLogger();
    const ctx = fakeCtx(logger, { containerDb: db });

    await dispatchSecurityNotice(
      ctx,
      {
        account: { id: 'u1', email: 'user@acme.example.com' },
        kind: 'password_changed',
        timestamp: '2026-06-06T00:00:00Z',
      },
      undefined,
      undefined,
      FAKE_CFG,
    );

    assert.equal(sent.length, 0);
  });

  test('não envia para kind não incluído nos kinds da setting', async ({ assert }) => {
    const sent: any[] = [];
    __setMailLoaderForTests(() => Promise.resolve(mailStub(sent)));

    const db = fakeDbWithSettings({
      security_notifications: { enabled: true, kinds: ['mfa_enabled'] },
    });
    const logger = fakeLogger();
    const ctx = fakeCtx(logger, { containerDb: db });

    await dispatchSecurityNotice(
      ctx,
      {
        account: { id: 'u1', email: 'user@acme.example.com' },
        kind: 'password_changed',
        timestamp: '2026-06-06T00:00:00Z',
      },
      undefined,
      undefined,
      FAKE_CFG,
    );

    assert.equal(sent.length, 0);
  });

  test('usa hook onSecurityNotice do config quando fornecido (substitui default)', async ({
    assert,
  }) => {
    const hookCalls: any[] = [];
    const sent: any[] = [];
    __setMailLoaderForTests(() => Promise.resolve(mailStub(sent)));

    const db = fakeDbWithSettings({});
    const logger = fakeLogger();
    const ctx = fakeCtx(logger, { containerDb: db });

    const mailHooks = {
      onSecurityNotice: async (data: any) => {
        hookCalls.push(data);
      },
    };

    await dispatchSecurityNotice(
      ctx,
      {
        account: { id: 'u1', email: 'user@acme.example.com' },
        kind: 'password_changed',
        timestamp: '2026-06-06T00:00:00Z',
      },
      mailHooks,
      undefined,
      FAKE_CFG,
    );

    assert.equal(hookCalls.length, 1);
    assert.equal(hookCalls[0].kind, 'password_changed');
    assert.equal(hookCalls[0].account.email, 'user@acme.example.com');
    // Hook substitui o mailer default — não envia e-mail direto.
    assert.equal(sent.length, 0);
  });

  test('fail-safe quando hook lança — não propaga o erro', async ({ assert }) => {
    const db = fakeDbWithSettings({});
    const logger = fakeLogger();
    const ctx = fakeCtx(logger, { containerDb: db });

    const mailHooks = {
      onSecurityNotice: async () => {
        throw new Error('hook explodiu');
      },
    };

    // Não deve lançar
    await assert.doesNotReject(() =>
      dispatchSecurityNotice(
        ctx,
        {
          account: { id: 'u1', email: 'user@acme.example.com' },
          kind: 'mfa_enabled',
          timestamp: '2026-06-06T00:00:00Z',
        },
        mailHooks,
        undefined,
        FAKE_CFG,
      ),
    );
  });

  test('audita security_notice.sent quando enviado', async ({ assert }) => {
    __setMailLoaderForTests(() =>
      Promise.resolve({
        send: async (cb: any) => {
          const msg: any = {
            from() {
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
          await cb(msg);
        },
      }),
    );

    const db = fakeDbWithSettings({});
    const logger = fakeLogger();
    const ctx = fakeCtx(logger, { containerDb: db });
    const auditEvents: AuditEvent[] = [];
    const audit = {
      record: async (e: AuditEvent) => {
        auditEvents.push(e);
      },
    };

    await dispatchSecurityNotice(
      ctx,
      {
        account: { id: 'u1', email: 'user@acme.example.com' },
        kind: 'mfa_disabled',
        timestamp: '2026-06-06T00:00:00Z',
      },
      undefined,
      audit as any,
      FAKE_CFG,
    );

    const noticeEvent = auditEvents.find((e) => e.type === 'security_notice.sent');
    assert.ok(noticeEvent, 'deve auditar security_notice.sent');
    assert.equal(noticeEvent?.accountId, 'u1');
    assert.deepEqual(noticeEvent?.metadata?.kind, 'mfa_disabled');
  });

  test('todos os kinds são aceitos por default (tabela ausente = defaults)', async ({ assert }) => {
    // Sem tabela → todos os kinds habilitados (table() lança → probe detecta ausência)
    const db = {
      table: () => {
        throw new Error('table does not exist');
      },
    } as any;
    const logger = fakeLogger();
    const ctx = fakeCtx(logger, { containerDb: db });
    const hookCalls: string[] = [];

    const mailHooks = {
      onSecurityNotice: async (data: any) => {
        hookCalls.push(data.kind);
      },
    };

    const kinds: SecurityNotificationKind[] = [
      'password_changed',
      'mfa_enabled',
      'mfa_disabled',
      'passkey_added',
      'passkey_removed',
      'email_changed',
    ];

    for (const kind of kinds) {
      await dispatchSecurityNotice(
        ctx,
        { account: { id: 'u1', email: 'u@x.com' }, kind, timestamp: '2026-06-06T00:00:00Z' },
        mailHooks,
        undefined,
        FAKE_CFG,
      );
    }

    assert.equal(hookCalls.length, kinds.length);
  });
});

// ---------------------------------------------------------------------------
// sendEmailChangeNoticeEmail / sendEmailChangedCompletedEmail / sendSecurityNoticeEmail
// ---------------------------------------------------------------------------

test.group('email_change mailer functions', (group) => {
  group.each.teardown(() => __setMailLoaderForTests(undefined));

  function mailStub(sent: any[]) {
    return {
      send: async (cb: any) => {
        const msg: any = {
          _to: undefined,
          _subject: undefined,
          _html: undefined,
          _text: undefined,
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
        await cb(msg);
        sent.push(msg);
      },
    };
  }

  test('sendEmailChangeNoticeEmail envia para o e-mail atual (OLD)', async ({ assert }) => {
    const sent: any[] = [];
    __setMailLoaderForTests(() => Promise.resolve(mailStub(sent)));

    const logger = fakeLogger();
    const ctx = fakeCtx(logger);

    await sendEmailChangeNoticeEmail(ctx, FAKE_CFG, {
      email: 'old@acme.example.com',
      newEmail: 'new@acme.example.com',
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]._to, 'old@acme.example.com');
    assert.ok(
      sent[0]._subject?.includes('change') || sent[0]._subject?.includes('troca'),
      'assunto deve mencionar troca',
    );
    assert.ok(
      sent[0]._html?.includes('new@acme.example.com'),
      'corpo deve mencionar o novo e-mail',
    );
  });

  test('sendEmailChangeNoticeEmail loga em fallback (sem mail)', async ({ assert }) => {
    __setMailLoaderForTests(() => Promise.resolve(null));

    const logger = fakeLogger();
    const ctx = fakeCtx(logger);

    await sendEmailChangeNoticeEmail(ctx, FAKE_CFG, {
      email: 'old@acme.example.com',
      newEmail: 'new@acme.example.com',
    });

    assert.equal(logger.calls.filter((c) => c.level === 'info').length, 1);
  });

  test('sendEmailChangedCompletedEmail envia para o e-mail ANTIGO com OLD+NEW', async ({
    assert,
  }) => {
    const sent: any[] = [];
    __setMailLoaderForTests(() => Promise.resolve(mailStub(sent)));

    const logger = fakeLogger();
    const ctx = fakeCtx(logger);

    await sendEmailChangedCompletedEmail(ctx, FAKE_CFG, {
      oldEmail: 'old@acme.example.com',
      newEmail: 'new@acme.example.com',
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]._to, 'old@acme.example.com');
    assert.ok(
      sent[0]._html?.includes('old@acme.example.com'),
      'corpo deve mencionar o e-mail antigo',
    );
    assert.ok(
      sent[0]._html?.includes('new@acme.example.com'),
      'corpo deve mencionar o e-mail novo',
    );
  });

  test('sendEmailChangedCompletedEmail fail-safe: nunca lança', async ({ assert }) => {
    __setMailLoaderForTests(() => Promise.reject(new Error('mail down')));

    const logger = fakeLogger();
    const ctx = fakeCtx(logger);

    await assert.doesNotReject(() =>
      sendEmailChangedCompletedEmail(ctx, FAKE_CFG, {
        oldEmail: 'old@acme.example.com',
        newEmail: 'new@acme.example.com',
      }),
    );
    assert.equal(logger.calls.filter((c) => c.level === 'error').length, 1);
  });

  test('sendSecurityNoticeEmail envia e-mail com o kind correto no assunto', async ({ assert }) => {
    const sent: any[] = [];
    __setMailLoaderForTests(() => Promise.resolve(mailStub(sent)));

    const logger = fakeLogger();
    const ctx = fakeCtx(logger);

    await sendSecurityNoticeEmail(ctx, FAKE_CFG, {
      email: 'user@acme.example.com',
      kind: 'password_changed',
      timestamp: '2026-06-06T00:00:00Z',
      ip: '10.0.0.1',
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0]._to, 'user@acme.example.com');
    assert.ok(
      sent[0]._subject?.toLowerCase().includes('password') ||
        sent[0]._subject?.toLowerCase().includes('senha'),
      'assunto deve mencionar o kind',
    );
  });

  test('sendSecurityNoticeEmail fail-safe: nunca lança', async ({ assert }) => {
    __setMailLoaderForTests(() => Promise.reject(new Error('mail down')));

    const logger = fakeLogger();
    const ctx = fakeCtx(logger);

    await assert.doesNotReject(() =>
      sendSecurityNoticeEmail(ctx, FAKE_CFG, {
        email: 'user@acme.example.com',
        kind: 'mfa_disabled',
        timestamp: '2026-06-06T00:00:00Z',
      }),
    );
    assert.equal(logger.calls.filter((c) => c.level === 'error').length, 1);
  });

  test('sendSecurityNoticeEmail loga info em dev (sem mail)', async ({ assert }) => {
    __setMailLoaderForTests(() => Promise.resolve(null));

    const logger = fakeLogger();
    const ctx = fakeCtx(logger);

    await sendSecurityNoticeEmail(ctx, FAKE_CFG, {
      email: 'user@acme.example.com',
      kind: 'passkey_added',
      timestamp: '2026-06-06T00:00:00Z',
    });

    assert.equal(logger.calls.filter((c) => c.level === 'info').length, 1);
  });
});
