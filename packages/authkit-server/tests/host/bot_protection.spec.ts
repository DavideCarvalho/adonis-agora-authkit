import { test } from '@japa/runner';
import type { AuditEvent, AuditSink } from '../../src/audit/audit_sink.js';
import type { ResolvedServerConfig } from '../../src/define_config.js';
import {
  type BotProtectionConfigInput,
  botProtectionApplies,
  DEFAULT_BOT_TOKEN_FIELDS,
  extractBotToken,
  guardBotProtection,
  resolveBotProtection,
  verifyBotProtection,
} from '../../src/host/bot_protection.js';

/** Sink in-memory write-only que captura eventos. */
function memorySink(): AuditSink & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return {
    events,
    async record(event: AuditEvent) {
      events.push(event);
    },
  };
}

/** ctx fake com body de form configurável + logger que captura warnings. */
function fakeCtx(body: Record<string, string> = {}, ip = '9.9.9.9') {
  const warns: any[] = [];
  return {
    warns,
    logger: { info() {}, error() {}, warn: (...a: any[]) => warns.push(a) },
    request: {
      ip: () => ip,
      input: (field: string) => body[field],
    },
  } as any;
}

test.group('resolveBotProtection', () => {
  test('undefined quando não configurado', ({ assert }) => {
    assert.isUndefined(resolveBotProtection(undefined));
  });

  test('aplica defaults (on=[login,signup], tokenFields, timeout)', ({ assert }) => {
    const cfg = resolveBotProtection({ verify: async () => true })!;
    assert.deepEqual(cfg.on, ['login', 'signup']);
    assert.deepEqual(cfg.tokenFields, [...DEFAULT_BOT_TOKEN_FIELDS]);
    assert.equal(cfg.timeoutMs, 5000);
  });

  test('respeita overrides de on/tokenFields/timeout/widget', ({ assert }) => {
    const cfg = resolveBotProtection({
      verify: async () => true,
      on: ['reset'],
      tokenFields: ['h-captcha-response'],
      timeoutMs: 1000,
      widget: { scriptUrl: 'https://x/api.js', html: '<div class="h-captcha"></div>' },
    })!;
    assert.deepEqual(cfg.on, ['reset']);
    assert.deepEqual(cfg.tokenFields, ['h-captcha-response']);
    assert.equal(cfg.timeoutMs, 1000);
    assert.equal(cfg.widget?.scriptUrl, 'https://x/api.js');
  });
});

test.group('botProtectionApplies', () => {
  test('false quando cfg undefined', ({ assert }) => {
    assert.isFalse(botProtectionApplies(undefined, 'login'));
  });
  test('só nas ações configuradas', ({ assert }) => {
    const cfg = resolveBotProtection({ verify: async () => true, on: ['login'] })!;
    assert.isTrue(botProtectionApplies(cfg, 'login'));
    assert.isFalse(botProtectionApplies(cfg, 'signup'));
    assert.isFalse(botProtectionApplies(cfg, 'reset'));
  });
});

test.group('extractBotToken', () => {
  test('extrai do campo default cf-turnstile-response', ({ assert }) => {
    const ctx = fakeCtx({ 'cf-turnstile-response': 'tok-cf' });
    assert.equal(extractBotToken(ctx, [...DEFAULT_BOT_TOKEN_FIELDS]), 'tok-cf');
  });
  test('extrai do campo hCaptcha h-captcha-response', ({ assert }) => {
    const ctx = fakeCtx({ 'h-captcha-response': 'tok-h' });
    assert.equal(extractBotToken(ctx, [...DEFAULT_BOT_TOKEN_FIELDS]), 'tok-h');
  });
  test('extrai de um nome de campo custom (override)', ({ assert }) => {
    const ctx = fakeCtx({ 'my-token': 'tok-x' });
    assert.equal(extractBotToken(ctx, ['my-token']), 'tok-x');
  });
  test('null quando nenhum campo presente', ({ assert }) => {
    const ctx = fakeCtx({});
    assert.isNull(extractBotToken(ctx, [...DEFAULT_BOT_TOKEN_FIELDS]));
  });
});

test.group('verifyBotProtection (fail-safe)', () => {
  test('verify=false → false (rejeita) e o token é passado ao verify', async ({ assert }) => {
    let seen: any;
    const cfg = resolveBotProtection({
      verify: async (input) => {
        seen = input;
        return false;
      },
    })!;
    const ctx = fakeCtx({ 'cf-turnstile-response': 'abc' }, '1.2.3.4');
    const ok = await verifyBotProtection(ctx, cfg, 'login');
    assert.isFalse(ok);
    assert.equal(seen.token, 'abc');
    assert.equal(seen.ip, '1.2.3.4');
    assert.equal(seen.action, 'login');
  });

  test('verify=true → true (prossegue)', async ({ assert }) => {
    const cfg = resolveBotProtection({ verify: async () => true })!;
    const ok = await verifyBotProtection(fakeCtx({ 'authkit-bot-token': 'x' }), cfg, 'login');
    assert.isTrue(ok);
  });

  test('verify que LANÇA → fail-safe (true) + warning logado', async ({ assert }) => {
    const cfg = resolveBotProtection({
      verify: async () => {
        throw new Error('captcha provider down');
      },
    })!;
    const ctx = fakeCtx({ 'authkit-bot-token': 'x' });
    const ok = await verifyBotProtection(ctx, cfg, 'signup');
    assert.isTrue(ok);
    assert.lengthOf(ctx.warns, 1);
  });

  test('verify que estoura o TIMEOUT → fail-safe (true)', async ({ assert }) => {
    const cfg = resolveBotProtection({
      verify: () => new Promise<boolean>(() => {}), // nunca resolve
      timeoutMs: 20,
    })!;
    const ok = await verifyBotProtection(fakeCtx({ 'authkit-bot-token': 'x' }), cfg, 'login');
    assert.isTrue(ok);
  });
});

test.group('guardBotProtection', () => {
  function cfgWith(
    input: BotProtectionConfigInput | undefined,
    sink: AuditSink,
  ): ResolvedServerConfig {
    return {
      botProtection: input ? resolveBotProtection(input) : undefined,
      audit: sink,
    } as unknown as ResolvedServerConfig;
  }

  test('true quando a feature não se aplica à ação (não audita)', async ({ assert }) => {
    const sink = memorySink();
    const cfg = cfgWith({ verify: async () => false, on: ['login'] }, sink);
    // verify retornaria false, mas a ação 'reset' não está em `on` → passa direto.
    const ok = await guardBotProtection(fakeCtx({}), cfg, 'reset');
    assert.isTrue(ok);
    assert.lengthOf(sink.events, 0);
  });

  test('rejeita (false) e audita bot_protection.rejected SEM o token', async ({ assert }) => {
    const sink = memorySink();
    const cfg = cfgWith({ verify: async () => false, on: ['login'] }, sink);
    const ctx = fakeCtx({ 'cf-turnstile-response': 'secret-token' }, '5.5.5.5');
    const ok = await guardBotProtection(ctx, cfg, 'login', { email: 'a@b.com', clientId: 'web' });
    assert.isFalse(ok);
    assert.lengthOf(sink.events, 1);
    const ev = sink.events[0];
    assert.equal(ev.type, 'bot_protection.rejected');
    assert.equal(ev.ip, '5.5.5.5');
    assert.equal(ev.email, 'a@b.com');
    assert.equal(ev.clientId, 'web');
    assert.deepEqual(ev.metadata, { action: 'login' });
    // O token NUNCA é auditado.
    assert.notInclude(JSON.stringify(ev), 'secret-token');
  });

  test('fail-safe: verify que lança → permite e NÃO audita rejeição', async ({ assert }) => {
    const sink = memorySink();
    const cfg = cfgWith(
      {
        verify: async () => {
          throw new Error('boom');
        },
        on: ['signup'],
      },
      sink,
    );
    const ok = await guardBotProtection(fakeCtx({}), cfg, 'signup');
    assert.isTrue(ok);
    assert.lengthOf(sink.events, 0);
  });

  test('true quando botProtection não configurado', async ({ assert }) => {
    const sink = memorySink();
    const cfg = cfgWith(undefined, sink);
    assert.isTrue(await guardBotProtection(fakeCtx({}), cfg, 'login'));
  });
});
