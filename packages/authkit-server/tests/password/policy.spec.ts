import { test } from '@japa/runner';
import {
  checkPasswordPolicy,
  DEFAULT_PWNED_TIMEOUT_MS,
  policyViolationParams,
  resolveCheckPwned,
  resolvePasswordConfig,
  resolvePasswordPolicy,
} from '../../src/password/policy.js';

test.group('resolvePasswordPolicy', () => {
  test('defaults: minLength 8, sem exigências de classe', ({ assert }) => {
    const p = resolvePasswordPolicy();
    assert.deepEqual(p, {
      minLength: 8,
      requireUppercase: false,
      requireLowercase: false,
      requireNumbers: false,
      requireSymbols: false,
    });
  });

  test('overrides aplicados', ({ assert }) => {
    const p = resolvePasswordPolicy({ minLength: 12, requireSymbols: true });
    assert.equal(p.minLength, 12);
    assert.isTrue(p.requireSymbols);
  });
});

test.group('resolveCheckPwned', () => {
  test('undefined → desligado', ({ assert }) => {
    assert.deepEqual(resolveCheckPwned(), { enabled: false, timeoutMs: DEFAULT_PWNED_TIMEOUT_MS });
  });
  test('true → ligado com timeout default', ({ assert }) => {
    assert.deepEqual(resolveCheckPwned(true), {
      enabled: true,
      timeoutMs: DEFAULT_PWNED_TIMEOUT_MS,
    });
  });
  test('objeto → ligado com timeout custom', ({ assert }) => {
    assert.deepEqual(resolveCheckPwned({ timeoutMs: 500 }), { enabled: true, timeoutMs: 500 });
  });
});

test.group('resolvePasswordConfig', () => {
  test('compõe policy + checkPwned', ({ assert }) => {
    const c = resolvePasswordConfig({ policy: { minLength: 10 }, checkPwned: true });
    assert.equal(c.policy.minLength, 10);
    assert.isTrue(c.checkPwned.enabled);
  });
});

test.group('checkPasswordPolicy', () => {
  test('comprimento mínimo', ({ assert }) => {
    const policy = resolvePasswordPolicy({ minLength: 8 });
    assert.equal(checkPasswordPolicy('short', policy), 'password.policy.min_length');
    assert.isNull(checkPasswordPolicy('longenough', policy));
  });

  test('exige maiúscula', ({ assert }) => {
    const policy = resolvePasswordPolicy({ requireUppercase: true });
    assert.equal(checkPasswordPolicy('lowercase1', policy), 'password.policy.uppercase');
    assert.isNull(checkPasswordPolicy('Uppercase1', policy));
  });

  test('exige minúscula', ({ assert }) => {
    const policy = resolvePasswordPolicy({ requireLowercase: true });
    assert.equal(checkPasswordPolicy('UPPERONLY1', policy), 'password.policy.lowercase');
    assert.isNull(checkPasswordPolicy('hasLower1', policy));
  });

  test('exige número', ({ assert }) => {
    const policy = resolvePasswordPolicy({ requireNumbers: true });
    assert.equal(checkPasswordPolicy('noNumbersHere', policy), 'password.policy.numbers');
    assert.isNull(checkPasswordPolicy('has1number', policy));
  });

  test('exige símbolo', ({ assert }) => {
    const policy = resolvePasswordPolicy({ requireSymbols: true });
    assert.equal(checkPasswordPolicy('noSymbol123', policy), 'password.policy.symbols');
    assert.isNull(checkPasswordPolicy('has!symbol1', policy));
  });

  test('ordem: comprimento vence outras regras', ({ assert }) => {
    const policy = resolvePasswordPolicy({ minLength: 20, requireSymbols: true });
    // viola comprimento E símbolo → reporta comprimento primeiro
    assert.equal(checkPasswordPolicy('short', policy), 'password.policy.min_length');
  });
});

test.group('policyViolationParams', () => {
  test('min_length carrega {min}', ({ assert }) => {
    const policy = resolvePasswordPolicy({ minLength: 12 });
    assert.deepEqual(policyViolationParams('password.policy.min_length', policy), { min: 12 });
  });
  test('outras regras sem params', ({ assert }) => {
    const policy = resolvePasswordPolicy();
    assert.isUndefined(policyViolationParams('password.policy.symbols', policy));
  });
});
