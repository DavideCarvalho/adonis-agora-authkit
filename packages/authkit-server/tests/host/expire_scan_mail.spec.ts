import { test } from '@japa/runner';
import type { AuditEvent, AuditSink } from '../../src/audit/audit_sink.js';
import { runExpireScan } from '../../src/commands/expire_scan_command.js';
import {
  __resetMailConfigWarningForTests,
  __setMailLoaderForTests,
} from '../../src/host/default_mailer.js';
import { resolveMessages } from '../../src/host/i18n.js';

/**
 * Regressão: o `authkit:accounts:expire-scan --warn` montava o PRÓPRIO e-mail de aviso,
 * hardcoded em inglês e sem marca, por fora do mailer default. Num host pt-BR com
 * `branding.company` o aviso saía em inglês e sem a marca do host, ao contrário de
 * todos os outros e-mails default.
 */

const DAY = 24 * 60 * 60 * 1000;

/** Config resolvido de um host pt-BR com só `company` + `clients` no branding. */
function hostCfg(audit: AuditSink, extra: Record<string, unknown> = {}) {
  const accounts = [{ id: 'acc-warn', email: 'warn@test.com', globalRoles: [] }];
  return {
    issuer: 'https://auth.entretextos.test',
    locale: 'pt-BR',
    messages: resolveMessages({ locale: 'pt-BR' }),
    branding: { company: 'educ(a)ção', clients: {} },
    mail: { from: 'Segurança <no-reply-auth@entretextos.test>' },
    audit,
    accountStore: {
      async listAccounts({ page }: { page: number }) {
        return { data: page === 1 ? accounts : [], total: accounts.length };
      },
    },
    ...extra,
  };
}

/** Audit com um `login.success` há 55 dias (a expirar em ~5 dias com 60/10). */
function makeAudit(recorded: AuditEvent[]): AuditSink {
  const lastLogin = new Date(Date.now() - 55 * DAY).toISOString();
  return {
    async record(e) {
      recorded.push(e);
    },
    async list(params) {
      if (params.type === 'login.success' && params.subject === 'acc-warn') {
        return {
          data: [{ type: 'login.success', accountId: 'acc-warn', createdAt: lastLogin } as any],
          total: 1,
        };
      }
      return { data: [], total: 0 };
    },
  };
}

/** `lucid.db` mínimo: a tabela `auth_settings` existe e tem `account_expiration` ligado. */
function makeDb() {
  const setting = JSON.stringify({ enabled: true, inactiveDays: 60, warnDays: 10 });
  const query: any = {
    from: () => query,
    select: () => query,
    where: () => query,
    whereNull: () => query,
    limit: async () => [],
    first: async () => ({ key: 'account_expiration', value: setting }),
  };
  return query;
}

function fakeApp(cfg: unknown) {
  const db = makeDb();
  return {
    config: { get: (key: string) => (key === 'authkit' ? cfg : undefined) },
    container: {
      make: async (key: string) => {
        if (key === 'lucid.db') return db;
        throw new Error(`no binding ${key}`);
      },
    },
  } as any;
}

function captureMail(sent: any[]) {
  __setMailLoaderForTests(() =>
    Promise.resolve({
      send: async (cb: any) => {
        const message: any = {};
        for (const k of ['from', 'to', 'subject', 'html', 'text']) {
          message[k] = (v: any) => {
            message[`_${k}`] = v;
            return message;
          };
        }
        cb(message);
        sent.push(message);
      },
    }),
  );
}

const logger = { info: () => {}, warn: () => {}, error: () => {} };

test.group('expire-scan --warn — e-mail de aviso', (group) => {
  group.each.setup(() => __resetMailConfigWarningForTests());
  group.each.teardown(() => __setMailLoaderForTests(undefined));

  test('sem hook: sai pelo mailer default em pt-BR com a marca do host', async ({ assert }) => {
    const sent: any[] = [];
    captureMail(sent);
    const recorded: AuditEvent[] = [];

    const result = await runExpireScan(fakeApp(hostCfg(makeAudit(recorded))), {
      warn: true,
      logger,
    });

    assert.equal(result.warned, 1);
    assert.lengthOf(sent, 1);
    const [message] = sent;
    assert.equal(message._to, 'warn@test.com');
    assert.equal(message._subject, 'Sua conta será desativada por inatividade');
    assert.include(message._html, 'lang="pt-BR"');
    assert.include(message._html, 'educ(a)ção');
    assert.notInclude(message._html, 'AuthKit');
    assert.match(message._text, /desativada em \d+ dia\(s\)/);
    assert.include(message._html, 'https://auth.entretextos.test/account/login');
    assert.equal(message._from, 'Segurança <no-reply-auth@entretextos.test>');
    assert.deepEqual(
      recorded.map((e) => e.type),
      ['account.expiration_warned'],
    );
  });

  test('host em inglês recebe o catálogo en', async ({ assert }) => {
    const sent: any[] = [];
    captureMail(sent);
    const cfg = hostCfg(makeAudit([]), { locale: 'en', messages: resolveMessages() });

    await runExpireScan(fakeApp(cfg), { warn: true, logger });

    assert.lengthOf(sent, 1);
    assert.equal(sent[0]._subject, 'Your account will be deactivated due to inactivity');
    assert.include(sent[0]._html, 'educ(a)ção');
  });

  test('o hook `mail.onAccountExpirationWarning` tem prioridade sobre o mailer default', async ({
    assert,
  }) => {
    const sent: any[] = [];
    captureMail(sent);
    const calls: Array<{ email: string; expiresInDays: number }> = [];
    const cfg = hostCfg(makeAudit([]), {
      mail: {
        onAccountExpirationWarning: async (data: { email: string; expiresInDays: number }) => {
          calls.push(data);
        },
      },
    });

    await runExpireScan(fakeApp(cfg), { warn: true, logger });

    assert.lengthOf(sent, 0, 'mailer default não roda quando o host tem hook');
    assert.lengthOf(calls, 1);
    assert.equal(calls[0].email, 'warn@test.com');
    assert.isAbove(calls[0].expiresInDays, 0);
  });
});
