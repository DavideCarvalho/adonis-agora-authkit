import { test } from '@japa/runner';
import {
  normalizeUserLoginMethods,
  parseUserLoginMethodsPayload,
  resolveEffectiveUserLoginMethods,
} from '../../src/host/user_login_methods.js';

const GLOBAL_ALL_ON = {
  password: true,
  magicLink: true,
  passkey: true,
  social: ['google'],
  forgotPassword: true,
  passkeyAutofill: true,
};

test.group('normalizeUserLoginMethods', () => {
  test('null/undefined/invalid → null', ({ assert }) => {
    assert.isNull(normalizeUserLoginMethods(null));
    assert.isNull(normalizeUserLoginMethods(undefined));
    assert.isNull(normalizeUserLoginMethods('x'));
    assert.isNull(normalizeUserLoginMethods([]));
    assert.isNull(normalizeUserLoginMethods({ password: 'yes' }));
    assert.isNull(normalizeUserLoginMethods({}));
  });

  test('descarta campos desconhecidos e não-booleanos', ({ assert }) => {
    assert.deepEqual(normalizeUserLoginMethods({ password: false, foo: true, magicLink: 'no' }), {
      password: false,
    });
  });

  test('mantém os quatro métodos booleanos', ({ assert }) => {
    assert.deepEqual(
      normalizeUserLoginMethods({ password: true, magicLink: false, passkey: true, social: false }),
      { password: true, magicLink: false, passkey: true, social: false },
    );
  });
});

test.group('parseUserLoginMethodsPayload', () => {
  test('recusa body sem methods', ({ assert }) => {
    assert.deepEqual(parseUserLoginMethodsPayload({}), { ok: false, error: 'invalid_methods' });
    assert.deepEqual(parseUserLoginMethodsPayload(null), { ok: false, error: 'invalid_body' });
    assert.deepEqual(parseUserLoginMethodsPayload({ methods: 'x' }), {
      ok: false,
      error: 'invalid_methods',
    });
  });

  test('aceita methods válido e vazio (reset)', ({ assert }) => {
    const ok = parseUserLoginMethodsPayload({ methods: { password: false } });
    assert.isTrue(ok.ok);
    assert.deepEqual(ok.ok ? ok.value : null, { password: false });
    const reset = parseUserLoginMethodsPayload({ methods: {} });
    assert.isTrue(reset.ok);
    assert.deepEqual(reset.ok ? reset.value : null, {});
  });
});

test.group('resolveEffectiveUserLoginMethods', () => {
  test('sem preferência → herda globais', ({ assert }) => {
    const r = resolveEffectiveUserLoginMethods(GLOBAL_ALL_ON, null);
    assert.deepEqual(r, GLOBAL_ALL_ON);
  });

  test('false do usuário desliga; true não liga método global off', ({ assert }) => {
    const global = { ...GLOBAL_ALL_ON, magicLink: false, social: [] };
    const r = resolveEffectiveUserLoginMethods(global, {
      magicLink: true,
      social: true,
      password: false,
    });
    assert.isFalse(r.magicLink); // global off vence
    assert.isEmpty(r.social); // sem providers configurados
    assert.isFalse(r.password); // usuário desligou
    assert.isFalse(r.forgotPassword); // derivado do password
  });

  test('fail-safe all-off: preferência que zera tudo é ignorada', ({ assert }) => {
    const r = resolveEffectiveUserLoginMethods(GLOBAL_ALL_ON, {
      password: false,
      magicLink: false,
      passkey: false,
      social: false,
    });
    assert.deepEqual(r, GLOBAL_ALL_ON);
  });

  test('desligar um método preserva os demais', ({ assert }) => {
    const r = resolveEffectiveUserLoginMethods(GLOBAL_ALL_ON, { passkey: false });
    assert.isFalse(r.passkey);
    assert.isFalse(r.passkeyAutofill); // autofill segue passkey
    assert.isTrue(r.password);
    assert.isTrue(r.magicLink);
    assert.deepEqual(r.social, ['google']);
  });

  test('desligar social esvazia a lista de providers', ({ assert }) => {
    const r = resolveEffectiveUserLoginMethods(GLOBAL_ALL_ON, { social: false });
    assert.isEmpty(r.social);
    assert.isTrue(r.password);
  });

  test('preferência órfã após global desligar tudo exceto um método continua válida', ({
    assert,
  }) => {
    const global = { ...GLOBAL_ALL_ON, magicLink: false, passkey: false, social: [] };
    const r = resolveEffectiveUserLoginMethods(global, { magicLink: false, passkey: false });
    // password continua on — não é all-off.
    assert.isTrue(r.password);
  });
});
