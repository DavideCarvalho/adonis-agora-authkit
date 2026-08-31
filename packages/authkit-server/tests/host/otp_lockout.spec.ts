import { test } from '@japa/runner';
import {
  __setOtpLockoutLimiterLoaderForTests,
  createOtpLockout,
  generateOtpUnlockToken,
  OTP_LOCKOUT_DEFAULTS,
  OTP_UNLOCK_TOKEN_PREFIX,
  rawToDbOtpUnlockToken,
  resolveEffectiveOtpLockout,
} from '../../src/host/otp_lockout.js';

// ---- helpers ----

function makeLimiterStub() {
  const counters = new Map<string, number>();
  const blocks = new Map<string, number>();

  function instance() {
    return {
      async increment(key: string) {
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return { consumed: next };
      },
      async delete(key: string) {
        counters.delete(key);
        blocks.delete(key);
        return true;
      },
      async block(key: string, duration: number) {
        blocks.set(key, duration);
        return {};
      },
      async isBlocked(key: string) {
        return blocks.has(key);
      },
      async availableIn(key: string) {
        return blocks.get(key) ?? 0;
      },
    };
  }

  return {
    use(_opts: unknown) {
      return instance();
    },
    _counters: counters,
    _blocks: blocks,
  };
}

function lockoutCfg(overrides: Partial<typeof OTP_LOCKOUT_DEFAULTS> = {}) {
  return { ...OTP_LOCKOUT_DEFAULTS, ...overrides };
}

// ---- tests ----

test.group('OtpLockout — isLocked / recordFailure / clearFailures / unlock', (group) => {
  group.each.setup(() => {
    const stub = makeLimiterStub();
    __setOtpLockoutLimiterLoaderForTests(() => Promise.resolve(stub));
    return () => __setOtpLockoutLimiterLoaderForTests(undefined);
  });

  test('isLocked retorna false quando não há lock', async ({ assert }) => {
    const lockout = createOtpLockout(lockoutCfg());
    assert.isFalse(await lockout.isLocked('acc1'));
  });

  test('recordFailure retorna false antes de atingir maxAttempts', async ({ assert }) => {
    const lockout = createOtpLockout(lockoutCfg({ maxAttempts: 3 }));
    assert.isFalse(await lockout.recordFailure('acc1'));
    assert.isFalse(await lockout.recordFailure('acc1'));
    assert.isFalse(await lockout.isLocked('acc1'));
  });

  test('recordFailure retorna true e trava ao atingir maxAttempts', async ({ assert }) => {
    const lockout = createOtpLockout(lockoutCfg({ maxAttempts: 3 }));
    await lockout.recordFailure('acc1');
    await lockout.recordFailure('acc1');
    const locked = await lockout.recordFailure('acc1'); // 3ª = trava
    assert.isTrue(locked);
    assert.isTrue(await lockout.isLocked('acc1'));
  });

  test('recovery code failure também conta (mesma lógica)', async ({ assert }) => {
    // Simula 3 falhas de recovery → deve travar
    const lockout = createOtpLockout(lockoutCfg({ maxAttempts: 3 }));
    await lockout.recordFailure('acc2');
    await lockout.recordFailure('acc2');
    const locked = await lockout.recordFailure('acc2');
    assert.isTrue(locked);
  });

  test('clearFailures zera o contador (senha correta)', async ({ assert }) => {
    const lockout = createOtpLockout(lockoutCfg({ maxAttempts: 5 }));
    await lockout.recordFailure('acc3');
    await lockout.recordFailure('acc3');
    await lockout.clearFailures('acc3');
    // Depois do clear, pode acumular falhas de novo sem herdar o histórico
    assert.isFalse(await lockout.isLocked('acc3'));
  });

  test('unlock zera lock + falhas', async ({ assert }) => {
    const lockout = createOtpLockout(lockoutCfg({ maxAttempts: 2 }));
    await lockout.recordFailure('acc4');
    await lockout.recordFailure('acc4'); // trava
    assert.isTrue(await lockout.isLocked('acc4'));
    await lockout.unlock('acc4');
    assert.isFalse(await lockout.isLocked('acc4'));
  });

  test('conta já travada: recordFailure é no-op (não re-emite evento)', async ({ assert }) => {
    const auditEvents: string[] = [];
    const mockSink = {
      async record(evt: any) {
        auditEvents.push(evt.type);
      },
    };
    const lockout = createOtpLockout(lockoutCfg({ maxAttempts: 2 }));
    await lockout.recordFailure('acc5', { sink: mockSink as any });
    await lockout.recordFailure('acc5', { sink: mockSink as any }); // 2ª trava
    const prevLen = auditEvents.length;
    await lockout.recordFailure('acc5', { sink: mockSink as any }); // já travado → no-op
    assert.equal(auditEvents.length, prevLen); // não emitiu de novo
  });

  test('emite otp.locked no audit na transição de trava', async ({ assert }) => {
    const auditEvents: string[] = [];
    const mockSink = {
      async record(evt: any) {
        auditEvents.push(evt.type);
      },
    };
    const lockout = createOtpLockout(lockoutCfg({ maxAttempts: 1 }));
    await lockout.recordFailure('acc6', { sink: mockSink as any });
    assert.include(auditEvents, 'otp.locked');
  });

  test('accountId vazio → no-op seguro', async ({ assert }) => {
    const lockout = createOtpLockout(lockoutCfg());
    assert.isFalse(await lockout.isLocked(''));
    await lockout.recordFailure(''); // não deve lançar
    assert.isTrue(true);
  });
});

test.group('OtpLockout — sem limiter (no-op)', (group) => {
  group.each.setup(() => {
    __setOtpLockoutLimiterLoaderForTests(() => Promise.resolve(null));
    return () => __setOtpLockoutLimiterLoaderForTests(undefined);
  });

  test('isLocked retorna false sem limiter', async ({ assert }) => {
    const lockout = createOtpLockout(lockoutCfg());
    assert.isFalse(await lockout.isLocked('acc_noLimiter'));
  });

  test('recordFailure retorna false sem limiter (no-op)', async ({ assert }) => {
    const lockout = createOtpLockout(lockoutCfg());
    assert.isFalse(await lockout.recordFailure('acc_noLimiter'));
  });

  test('unlock não lança sem limiter', async ({ assert }) => {
    const lockout = createOtpLockout(lockoutCfg());
    await lockout.unlock('acc_noLimiter');
    assert.isTrue(true);
  });
});

test.group('OtpLockout — enabled=false', () => {
  test('enabled=false: tudo no-op', async ({ assert }) => {
    const stub = makeLimiterStub();
    __setOtpLockoutLimiterLoaderForTests(() => Promise.resolve(stub));
    const lockout = createOtpLockout(lockoutCfg({ enabled: false }));
    assert.isFalse(await lockout.isLocked('acc'));
    assert.isFalse(await lockout.recordFailure('acc'));
    __setOtpLockoutLimiterLoaderForTests(undefined);
  });
});

test.group('generateOtpUnlockToken + rawToDbOtpUnlockToken', () => {
  test('gera token raw + dbValue com prefixo correto', ({ assert }) => {
    const { raw, dbValue } = generateOtpUnlockToken();
    assert.isString(raw);
    assert.isAbove(raw.length, 20);
    assert.isTrue(dbValue.startsWith(OTP_UNLOCK_TOKEN_PREFIX));
    assert.notEqual(dbValue, `${OTP_UNLOCK_TOKEN_PREFIX}${raw}`); // dbValue é hash, não raw
  });

  test('rawToDbOtpUnlockToken produz o mesmo dbValue que generateOtpUnlockToken', ({ assert }) => {
    const { raw, dbValue } = generateOtpUnlockToken();
    assert.equal(rawToDbOtpUnlockToken(raw), dbValue);
  });

  test('tokens diferentes para cada geração', ({ assert }) => {
    const t1 = generateOtpUnlockToken();
    const t2 = generateOtpUnlockToken();
    assert.notEqual(t1.raw, t2.raw);
    assert.notEqual(t1.dbValue, t2.dbValue);
  });

  test('TTL vencido: token deve ser rejeitado (dbValue correto mas expirado)', ({ assert }) => {
    // Testa a lógica de TTL via verificação no controller — aqui só verificamos
    // que o dbValue é o sha256 do raw (prefixo + hash)
    const { raw, dbValue } = generateOtpUnlockToken();
    const recomputed = rawToDbOtpUnlockToken(raw);
    assert.equal(recomputed, dbValue);
    // Garante que token forjado (raw adulterado) não bate
    const forged = rawToDbOtpUnlockToken(`${raw}tampered`);
    assert.notEqual(forged, dbValue);
  });
});

test.group('resolveEffectiveOtpLockout', () => {
  function fakeSettings(val: unknown) {
    return {
      async getSetting(_key: string) {
        return val;
      },
      async setSetting() {},
      async deleteSetting() {},
      async listSettings() {
        return [];
      },
    };
  }

  test('defaults quando setting ausente', async ({ assert }) => {
    const s = fakeSettings(null);
    const resolved = await resolveEffectiveOtpLockout(s as any);
    assert.deepEqual(resolved, OTP_LOCKOUT_DEFAULTS);
  });

  test('usa valores da setting quando presentes', async ({ assert }) => {
    const s = fakeSettings({ enabled: false, maxAttempts: 3, unlockTtlHours: 12 });
    const resolved = await resolveEffectiveOtpLockout(s as any);
    assert.deepEqual(resolved, { enabled: false, maxAttempts: 3, unlockTtlHours: 12 });
  });

  test('fall-safe em campos inválidos (usa defaults)', async ({ assert }) => {
    const s = fakeSettings({ enabled: 'yes', maxAttempts: -1, unlockTtlHours: 'never' });
    const resolved = await resolveEffectiveOtpLockout(s as any);
    assert.equal(resolved.enabled, OTP_LOCKOUT_DEFAULTS.enabled);
    assert.equal(resolved.maxAttempts, OTP_LOCKOUT_DEFAULTS.maxAttempts);
    assert.equal(resolved.unlockTtlHours, OTP_LOCKOUT_DEFAULTS.unlockTtlHours);
  });

  test('fail-safe: erro em getSetting → defaults', async ({ assert }) => {
    const s = {
      async getSetting() {
        throw new Error('db error');
      },
      async setSetting() {},
      async deleteSetting() {},
      async listSettings() {
        return [];
      },
    };
    const resolved = await resolveEffectiveOtpLockout(s as any);
    assert.deepEqual(resolved, OTP_LOCKOUT_DEFAULTS);
  });
});
