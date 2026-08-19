import type { ExtensionContext, TelescopeExtension } from '@adonis-agora/telescope';
import { test } from '@japa/runner';
import type { AuditEvent } from '../src/audit/audit_sink.js';
import {
  authkitEventBreakdownProvider,
  authkitEventCountProvider,
  authkitLoginSuccessRateProvider,
  authkitLoginsOverTimeProvider,
  authkitTokenActivityProvider,
  defineAuthkitTelescopeExtension,
} from '../src/observability/telescope/index.js';

/** A captured `agora:authkit:<event>` diagnostic entry, as the watcher records it. */
function entry(
  event: string,
  payload: Partial<AuditEvent> = {},
  createdAt = new Date(),
): { content: { event: string; payload: AuditEvent }; createdAt: Date } {
  return {
    content: { event, payload: { type: event, ...payload } as AuditEvent },
    createdAt,
  };
}

/** An ExtensionContext over a fixed list of captured authkit diagnostic entries. */
function makeCtx(entries: ReturnType<typeof entry>[] = []): ExtensionContext {
  return {
    store: { list: async () => entries } as never,
    container: { make: async () => undefined as never },
    config: {} as never,
  };
}

test.group('observability/telescope — extension shape', () => {
  test('defineAuthkitTelescopeExtension returns a well-formed extension', ({ assert }) => {
    const ext: TelescopeExtension = defineAuthkitTelescopeExtension();
    assert.equal(ext.name, 'authkit');
    assert.isFunction(ext.entryTypes);
    assert.isFunction(ext.dashboards);
    assert.isFunction(ext.dataProviders);

    const ctx = makeCtx();
    const types = ext.entryTypes!(ctx);
    assert.lengthOf(types, 1);
    assert.equal(types[0].id, 'authkit');
    assert.isString(types[0].label);
    assert.isString(types[0].dot);

    const dashboards = ext.dashboards!(ctx);
    assert.lengthOf(dashboards, 1);
    assert.equal(dashboards[0].id, 'authkit.security');
    assert.isArray(dashboards[0].sections);
    assert.isAbove(dashboards[0].sections!.length, 0);

    const providers = ext.dataProviders!(ctx);
    assert.isAbove(providers.length, 0);
    // Every panel binding must resolve to a registered provider name.
    const names = new Set(providers.map((p) => p.name));
    for (const section of dashboards[0].sections!) {
      for (const panel of section.panels) {
        assert.isTrue(
          names.has(panel.data.provider),
          `panel binds to unknown provider ${panel.data.provider}`,
        );
      }
    }
  });
});

test.group('observability/telescope — data providers', () => {
  const entries = [
    entry('login.success', { accountId: 'a' }),
    entry('login.success', { accountId: 'b' }),
    entry('login.failure', { accountId: 'c' }),
    entry('mfa.enabled', { accountId: 'a' }),
    entry('account.locked', { accountId: 'c' }),
    entry('pat.issued', { accountId: 'a' }),
    entry('impersonation.panel_viewed', { accountId: 'b', actorId: 'admin' }),
  ];

  test('authkit.eventCount counts a metric group within the window', async ({ assert }) => {
    const ctx = makeCtx(entries);
    const ok = (await authkitEventCountProvider().resolve({ metric: 'loginSuccess' }, ctx)) as {
      value: number;
      spark: number[];
    };
    assert.equal(ok.value, 2);
    assert.lengthOf(ok.spark, 8);

    const fail = (await authkitEventCountProvider().resolve({ metric: 'loginFailure' }, ctx)) as {
      value: number;
    };
    assert.equal(fail.value, 1);

    const lockouts = (await authkitEventCountProvider().resolve({ metric: 'lockouts' }, ctx)) as {
      value: number;
    };
    assert.equal(lockouts.value, 1);
  });

  test('authkit.loginSuccessRate computes success / (success+failure)', async ({ assert }) => {
    const res = (await authkitLoginSuccessRateProvider().resolve({}, makeCtx(entries))) as {
      value: number;
      min: number;
      max: number;
    };
    assert.closeTo(res.value, 2 / 3, 1e-9);
    assert.equal(res.min, 0);
    assert.equal(res.max, 1);
  });

  test('authkit.loginSuccessRate is 1 when there are no logins', async ({ assert }) => {
    const res = (await authkitLoginSuccessRateProvider().resolve(
      {},
      makeCtx([entry('mfa.enabled')]),
    )) as { value: number };
    assert.equal(res.value, 1);
  });

  test('authkit.loginsOverTime returns success/failure timeseries rows', async ({ assert }) => {
    const res = (await authkitLoginsOverTimeProvider().resolve(
      { buckets: 4 },
      makeCtx(entries),
    )) as { rows: Array<{ label: string; success: number; failure: number }> };
    assert.lengthOf(res.rows, 4);
    const totalSuccess = res.rows.reduce((s, r) => s + r.success, 0);
    const totalFailure = res.rows.reduce((s, r) => s + r.failure, 0);
    assert.equal(totalSuccess, 2);
    assert.equal(totalFailure, 1);
  });

  test('authkit.eventBreakdown returns a segment per event family', async ({ assert }) => {
    const res = (await authkitEventBreakdownProvider().resolve({}, makeCtx(entries))) as {
      segments: Array<{ label: string; value: number; color: string }>;
    };
    const byLabel = new Map(res.segments.map((s) => [s.label, s.value]));
    assert.equal(byLabel.get('Login OK'), 2);
    assert.equal(byLabel.get('Login fail'), 1);
    assert.equal(byLabel.get('MFA'), 1);
    assert.equal(byLabel.get('Lockouts'), 1);
    assert.equal(byLabel.get('PAT'), 1);
    assert.equal(byLabel.get('Impersonation'), 1);
  });

  test('authkit.tokenActivity lists PAT + impersonation events as rows', async ({ assert }) => {
    const res = (await authkitTokenActivityProvider().resolve({}, makeCtx(entries))) as {
      rows: Array<{ event: string; subject: string; actor: string }>;
    };
    const events = res.rows.map((r) => r.event);
    assert.includeMembers(events, ['pat.issued', 'impersonation.panel_viewed']);
    assert.notInclude(events, 'login.success');
    const imp = res.rows.find((r) => r.event === 'impersonation.panel_viewed');
    assert.equal(imp?.actor, 'admin');
    assert.equal(imp?.subject, 'b');
  });

  test('authkit.tokenActivity never surfaces ip (LGPD/GDPR — no PII column)', async ({
    assert,
  }) => {
    // Even if a (legacy / non-redacted) entry carried an ip, the provider must
    // not expose it — the dashboard table has no IP column anymore.
    const res = (await authkitTokenActivityProvider().resolve(
      {},
      makeCtx([entry('pat.issued', { accountId: 'a', ip: '203.0.113.9' })]),
    )) as { rows: Array<Record<string, unknown>> };
    assert.lengthOf(res.rows, 1);
    assert.notProperty(res.rows[0], 'ip');
    assert.notInclude(JSON.stringify(res.rows[0]), '203.0.113.9');
  });
});
