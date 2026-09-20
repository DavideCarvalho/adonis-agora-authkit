import { test } from '@japa/runner';
import { resolveLogin, resolveRateLimit } from '../../src/define_config.js';
import { renderTransactionalEmail } from '../../src/host/email_templates.js';
import {
  decodeOtpToken,
  encodeOtpToken,
  evaluateLoginOtp,
  generateOtpCode,
  hashLoginOtp,
  linkTokenFromOtpUrl,
  OTP_LOGIN_DEFAULTS,
  OTP_LOGIN_PREFIX,
  resolveOtpLoginConfig,
  safeEqualHex,
} from '../../src/host/otp_login.js';
import { __setLimiterLoaderForTests, createAuthThrottles } from '../../src/host/rate_limit.js';

const HEX64 = 'a'.repeat(64);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test.group('otp login — config', () => {
  test('defaults: desligado, 6 dígitos, 10 min, 5 tentativas', ({ assert }) => {
    assert.deepEqual(resolveOtpLoginConfig(), {
      enabled: false,
      digits: 6,
      ttlMinutes: 10,
      maxAttempts: 5,
    });
    // Back-compat: sem `login.otp`, o resolveLogin injeta o default desligado.
    assert.deepEqual(resolveLogin(), {
      requireVerifiedEmail: false,
      otp: OTP_LOGIN_DEFAULTS,
    });
  });

  test('liga e normaliza dentro dos limites de sanidade', ({ assert }) => {
    assert.deepEqual(resolveOtpLoginConfig({ enabled: true, digits: 8, ttlMinutes: 3 }), {
      enabled: true,
      digits: 8,
      ttlMinutes: 3,
      maxAttempts: 5,
    });
  });

  test('valores fora da faixa caem no default (digits 4–10, ttl≥1, max≥1)', ({ assert }) => {
    const c = resolveOtpLoginConfig({ digits: 2, ttlMinutes: 0, maxAttempts: 0 });
    assert.equal(c.digits, 6);
    assert.equal(c.ttlMinutes, 10);
    assert.equal(c.maxAttempts, 5);
    assert.equal(resolveOtpLoginConfig({ digits: 99 }).digits, 6);
  });
});

// ---------------------------------------------------------------------------
// Geração do código (sem viés, zero-padded, cripto)
// ---------------------------------------------------------------------------

test.group('otp login — geração do código', () => {
  test('sempre tem `digits` dígitos e é numérico (zero-padded)', ({ assert }) => {
    for (let i = 0; i < 2000; i++) {
      const code = generateOtpCode(6);
      assert.lengthOf(code, 6);
      assert.match(code, /^[0-9]{6}$/);
    }
  });

  test('respeita a largura configurada', ({ assert }) => {
    assert.lengthOf(generateOtpCode(4), 4);
    assert.lengthOf(generateOtpCode(8), 8);
  });

  test('cobre toda a faixa incluindo zeros à esquerda (distribuição ampla)', ({ assert }) => {
    const seen = new Set<string>();
    let sawLeadingZero = false;
    for (let i = 0; i < 5000; i++) {
      const code = generateOtpCode(6);
      seen.add(code);
      if (code[0] === '0') sawLeadingZero = true;
    }
    // Muitos valores distintos (nada de constante/enviesado) e zeros à esquerda.
    assert.isAbove(seen.size, 4000);
    assert.isTrue(sawLeadingZero);
  });
});

// ---------------------------------------------------------------------------
// Hash + comparação constant-time
// ---------------------------------------------------------------------------

test.group('otp login — hash e comparação', () => {
  test('hash atrela ao uid (mesmo código, uid diferente → hash diferente)', ({ assert }) => {
    const a = hashLoginOtp('uid-1', '123456');
    const b = hashLoginOtp('uid-2', '123456');
    const c = hashLoginOtp('uid-1', '123456');
    assert.notEqual(a, b);
    assert.equal(a, c);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  test('safeEqualHex: igual → true; diferente → false; tamanhos distintos → false', ({
    assert,
  }) => {
    const h = hashLoginOtp('u', '000000');
    assert.isTrue(safeEqualHex(h, h));
    assert.isFalse(safeEqualHex(h, hashLoginOtp('u', '000001')));
    assert.isFalse(safeEqualHex(h, 'abc'));
    assert.isFalse(safeEqualHex('', ''));
  });
});

// ---------------------------------------------------------------------------
// Codec do slot ml2:
// ---------------------------------------------------------------------------

test.group('otp login — codec do slot ml2:', () => {
  test('encode/decode roundtrip', ({ assert }) => {
    const state = { linkToken: HEX64, codeHash: 'b'.repeat(64), codeExpMs: 1234567, attempts: 2 };
    const encoded = encodeOtpToken(state);
    assert.isTrue(encoded.startsWith(OTP_LOGIN_PREFIX));
    assert.deepEqual(decodeOtpToken(encoded), state);
  });

  test('decode aceita codeHash vazio (código invalidado por lockout)', ({ assert }) => {
    const encoded = encodeOtpToken({ linkToken: HEX64, codeHash: '', codeExpMs: 10, attempts: 5 });
    const parsed = decodeOtpToken(encoded);
    assert.equal(parsed?.codeHash, '');
    assert.equal(parsed?.attempts, 5);
  });

  test('decode rejeita ml: legado, tokens de reset e malformados', ({ assert }) => {
    assert.isNull(decodeOtpToken('ml:deadbeef'));
    assert.isNull(decodeOtpToken('some-reset-token'));
    assert.isNull(decodeOtpToken(null));
    assert.isNull(decodeOtpToken(`${OTP_LOGIN_PREFIX}nothex:${'b'.repeat(64)}:1:0`));
    assert.isNull(decodeOtpToken(`${OTP_LOGIN_PREFIX}${HEX64}:${'b'.repeat(64)}`)); // partes de menos
  });

  test('linkTokenFromOtpUrl extrai o token hex; rejeita não-hex (anti LIKE injection)', ({
    assert,
  }) => {
    assert.equal(linkTokenFromOtpUrl(`${OTP_LOGIN_PREFIX}${HEX64}`), HEX64);
    assert.isNull(linkTokenFromOtpUrl(`${OTP_LOGIN_PREFIX}abc%_`));
    assert.isNull(linkTokenFromOtpUrl('ml:deadbeef'));
  });
});

// ---------------------------------------------------------------------------
// Máquina de estados PURA (ordem das checagens + PROVA DE MUTAÇÃO do lockout)
// ---------------------------------------------------------------------------

test.group('otp login — evaluateLoginOtp (máquina de estados)', () => {
  const uid = 'uid-x';
  const now = 1_000_000;
  const parsedFor = (code: string, over: Partial<ReturnType<typeof decodeOtpToken>> = {}) => ({
    linkToken: HEX64,
    codeHash: hashLoginOtp(uid, code),
    codeExpMs: now + 60_000,
    attempts: 0,
    ...over,
  });

  test('sem código pendente → no_code', ({ assert }) => {
    assert.equal(
      evaluateLoginOtp({ parsed: null, uid, code: '000000', nowMs: now, maxAttempts: 5 }).result,
      'no_code',
    );
  });

  test('código correto → ok e limpa o slot (nextToken null; mata o link junto)', ({ assert }) => {
    const out = evaluateLoginOtp({
      parsed: parsedFor('424242'),
      uid,
      code: '424242',
      nowMs: now,
      maxAttempts: 5,
    });
    assert.equal(out.result, 'ok');
    assert.isNull(out.nextToken);
  });

  test('código errado → invalid e incrementa o contador (persistido no nextToken)', ({
    assert,
  }) => {
    const out = evaluateLoginOtp({
      parsed: parsedFor('424242'),
      uid,
      code: '999999',
      nowMs: now,
      maxAttempts: 5,
    });
    assert.equal(out.result, 'invalid');
    assert.equal(decodeOtpToken(out.nextToken as string)?.attempts, 1);
  });

  test('5ª falha → locked e INVALIDA o código (codeHash vazio) mantendo o link', ({ assert }) => {
    const out = evaluateLoginOtp({
      parsed: parsedFor('424242', { attempts: 4 }),
      uid,
      code: '999999',
      nowMs: now,
      maxAttempts: 5,
    });
    assert.equal(out.result, 'locked');
    const next = decodeOtpToken(out.nextToken as string);
    assert.equal(next?.codeHash, ''); // código morto
    assert.equal(next?.linkToken, HEX64); // link preservado
  });

  test('código expirado → expired (mesmo com o código certo)', ({ assert }) => {
    const out = evaluateLoginOtp({
      parsed: parsedFor('424242', { codeExpMs: now - 1 }),
      uid,
      code: '424242',
      nowMs: now,
      maxAttempts: 5,
    });
    assert.equal(out.result, 'expired');
  });

  test('código atrelado ao uid: verificar com OUTRO uid falha', ({ assert }) => {
    const out = evaluateLoginOtp({
      parsed: parsedFor('424242'),
      uid: 'uid-OUTRO',
      code: '424242',
      nowMs: now,
      maxAttempts: 5,
    });
    assert.equal(out.result, 'invalid');
  });

  // ── PROVA DE MUTAÇÃO da checagem de LOCKOUT ────────────────────────────────
  // Com o contador já esgotado, QUALQUER tentativa (mesmo o código certo) tem de
  // dar `locked` — é a guarda que impede o brute-force. Se a linha de lockout de
  // `evaluateLoginOtp` for removida, este teste vira VERMELHO: sem ela, o código
  // certo passaria a 'ok' e o errado a 'invalid' (contador re-incrementado),
  // reabrindo o chute infinito.
  test('[mutation-proof] tentativas esgotadas → locked, mesmo com o código certo', ({ assert }) => {
    const exhausted = parsedFor('424242', { attempts: 5 });
    assert.equal(
      evaluateLoginOtp({ parsed: exhausted, uid, code: '424242', nowMs: now, maxAttempts: 5 })
        .result,
      'locked',
    );
    assert.equal(
      evaluateLoginOtp({ parsed: exhausted, uid, code: '999999', nowMs: now, maxAttempts: 5 })
        .result,
      'locked',
    );
  });

  test('[mutation-proof] código invalidado (hash vazio) → locked', ({ assert }) => {
    const dead = parsedFor('424242', { codeHash: '', attempts: 5 });
    assert.equal(
      evaluateLoginOtp({ parsed: dead, uid, code: '424242', nowMs: now, maxAttempts: 5 }).result,
      'locked',
    );
  });
});

// ---------------------------------------------------------------------------
// E-mail: código renderizado quando presente; idêntico ao de antes quando ausente
// ---------------------------------------------------------------------------

test.group('otp login — e-mail carrega o código', () => {
  const base = {
    brand: { appName: 'Acme' },
    subject: 'Seu link',
    heading: 'Entrar',
    intro: 'Clique para entrar.',
    ctaLabel: 'Entrar',
    ctaUrl: 'https://x/y',
  };

  test('sem code: e-mail idêntico ao magic link puro (nenhum dígito no corpo)', ({ assert }) => {
    const out = renderTransactionalEmail(base);
    assert.notInclude(out.html, 'letter-spacing:6px');
    assert.notInclude(out.text, 'código');
    // Byte-parity com o e-mail pré-OTP: o slot do codeBlock não pode deixar
    // linha em branco entre o parágrafo de intro e a tabela do CTA.
    assert.match(out.html, /<\/p>\n<table role="presentation" cellpadding="0" cellspacing="0">/);
  });

  test('com code: renderiza o código em destaque (HTML monoespaçado + texto)', ({ assert }) => {
    const out = renderTransactionalEmail({
      ...base,
      code: '135790',
      codeLabel: 'Ou use este código:',
    });
    assert.include(out.html, '135790');
    assert.include(out.html, 'monospace');
    assert.include(out.text, '135790');
    assert.include(out.text, 'Ou use este código:');
  });

  test('o código é escapado (sem injeção de HTML)', ({ assert }) => {
    const out = renderTransactionalEmail({ ...base, code: '<b>1</b>' });
    assert.notInclude(out.html, '<b>1</b>');
    assert.include(out.html, '&lt;b&gt;');
  });
});

// ---------------------------------------------------------------------------
// Throttle dedicado authkit_otp_login — mais apertado que o login e responde 429
// ---------------------------------------------------------------------------

function fakeLimiter() {
  const counts = new Map<string, number>();
  const limiter = {
    allowRequests(points: number) {
      const chain: any = {
        points,
        _key: undefined as string | undefined,
        every() {
          return chain;
        },
        store() {
          return chain;
        },
        usingKey(k: string) {
          chain._key = k;
          return chain;
        },
      };
      return chain;
    },
    define(name: string, fn: (ctx: any) => any) {
      return async (ctx: any, next: () => Promise<void>) => {
        const chain = fn(ctx);
        const bucketKey = `${name}:${chain._key ?? '∅'}`;
        const used = (counts.get(bucketKey) ?? 0) + 1;
        counts.set(bucketKey, used);
        if (used > chain.points) {
          ctx.__throttled = true;
          return; // 429: não chama next
        }
        return next();
      };
    },
  };
  return limiter;
}

test.group('otp login — throttle authkit_otp_login', (group) => {
  group.each.teardown(() => __setLimiterLoaderForTests(undefined));

  test('bucket padrão é mais apertado que o login (5/min vs 10/min)', ({ assert }) => {
    const rl = resolveRateLimit({ enabled: true });
    assert.equal(rl.otpLogin.points, 5);
    assert.isBelow(rl.otpLogin.points, rl.login.points);
  });

  test('tentativas acima do teto do mesmo IP são limitadas (429)', async ({ assert }) => {
    __setLimiterLoaderForTests(async () => fakeLimiter());
    const cfg = resolveRateLimit({ enabled: true });
    cfg.otpLogin = { points: 3, duration: '1 min' };
    const throttles = createAuthThrottles(cfg)!;
    assert.isFunction(throttles.otpLogin);

    let allowed = 0;
    let blocked = 0;
    for (let i = 0; i < 6; i++) {
      const ctx = { request: { ip: () => '5.5.5.5' }, __throttled: false } as any;
      await throttles.otpLogin(ctx, async () => {
        allowed++;
      });
      if (ctx.__throttled) blocked++;
    }
    assert.equal(allowed, 3);
    assert.equal(blocked, 3);
  });
});
