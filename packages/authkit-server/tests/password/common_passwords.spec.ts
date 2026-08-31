import { test } from '@japa/runner';
import {
  __setCommonPasswordsForTests,
  commonPasswordsCount,
  isCommonPassword,
} from '../../src/password/common_passwords.js';
import { PasswordManager, PasswordPolicyError } from '../../src/password/password_manager.js';

test.group('common_passwords — isCommonPassword', (group) => {
  group.each.teardown(() => {
    __setCommonPasswordsForTests(null); // reset para o arquivo real
  });

  test('lazy load: carregado apenas uma vez (count > 0)', ({ assert }) => {
    // Reseta e força re-carregamento
    __setCommonPasswordsForTests(null);
    const count = commonPasswordsCount();
    assert.isAbove(count, 0, 'lista de senhas comuns deve ter entradas');
  });

  test('rejeita senhas comuns conhecidas (case-insensitive)', ({ assert }) => {
    assert.isTrue(isCommonPassword('123456'));
    assert.isTrue(isCommonPassword('password'));
    assert.isTrue(isCommonPassword('qwerty'));
    assert.isTrue(isCommonPassword('iloveyou'));
    assert.isTrue(isCommonPassword('letmein'));
    assert.isTrue(isCommonPassword('welcome'));
    assert.isTrue(isCommonPassword('admin'));
  });

  test('case-insensitive: rejeita variações em maiúsculas', ({ assert }) => {
    assert.isTrue(isCommonPassword('PASSWORD'));
    assert.isTrue(isCommonPassword('Password'));
    assert.isTrue(isCommonPassword('QWERTY'));
    assert.isTrue(isCommonPassword('ILoveYou'));
  });

  test('aceita senhas que não estão na lista', ({ assert }) => {
    assert.isFalse(isCommonPassword('Xk9pQ!mZr7nL'));
    assert.isFalse(isCommonPassword('S3cur3Passw0rd!XyZ'));
    assert.isFalse(isCommonPassword('randomUniqueLongPassword42!'));
  });

  test('fail-safe: Set vazio quando arquivo não existe', ({ assert }) => {
    __setCommonPasswordsForTests(new Set());
    assert.isFalse(isCommonPassword('password')); // lista vazia → não rejeita
    assert.equal(commonPasswordsCount(), 0);
  });

  test('lazy load ocorre somente uma vez (injeta Set customizado)', ({ assert }) => {
    const custom = new Set(['myspecialpassword', 'anotherbad']);
    __setCommonPasswordsForTests(custom);
    assert.isTrue(isCommonPassword('myspecialpassword'));
    assert.isTrue(isCommonPassword('MYSPECIALPASSWORD')); // case-insensitive
    assert.isFalse(isCommonPassword('password')); // não está no custom
    assert.equal(commonPasswordsCount(), 2);
  });
});

test.group('PasswordManager.assertAcceptable — blockCommon', (group) => {
  group.each.teardown(() => {
    __setCommonPasswordsForTests(null);
  });

  test('rejeita senha comum por padrão (blockCommon=true default)', async ({ assert }) => {
    // Injeta uma lista com senha conhecida
    __setCommonPasswordsForTests(new Set(['badpassword']));
    const pm = new PasswordManager();
    try {
      await pm.assertAcceptable('badpassword');
      assert.fail('deveria ter lançado');
    } catch (error) {
      assert.instanceOf(error, PasswordPolicyError);
      assert.equal((error as PasswordPolicyError).key, 'password.common');
    }
  });

  test('blockCommon: false desabilita a checagem', async ({ assert }) => {
    __setCommonPasswordsForTests(new Set(['badpassword']));
    const pm = new PasswordManager();
    // Não deve lançar quando blockCommon=false
    await pm.assertAcceptable('badpassword', { blockCommon: false });
    assert.isTrue(true);
  });

  test('lista vazia = fail-safe: aceita qualquer senha', async ({ assert }) => {
    __setCommonPasswordsForTests(new Set());
    const pm = new PasswordManager();
    await pm.assertAcceptable('password'); // seria rejeitada sem lista vazia
    assert.isTrue(true);
  });

  test('rejeição de senha comum é case-insensitive', async ({ assert }) => {
    __setCommonPasswordsForTests(new Set(['badpassword']));
    const pm = new PasswordManager();
    try {
      await pm.assertAcceptable('BADPASSWORD');
      assert.fail('deveria ter lançado');
    } catch (error) {
      assert.instanceOf(error, PasswordPolicyError);
      assert.equal((error as PasswordPolicyError).key, 'password.common');
    }
  });

  test('blockCommon roda ANTES do HIBP (order matters)', async ({ assert }) => {
    __setCommonPasswordsForTests(new Set(['commonpwd']));
    const pm = new PasswordManager(
      {},
      {
        fetchImpl: async () => {
          throw new Error('HIBP não deveria ter sido chamado');
        },
      },
    );
    try {
      // Com blockCommon=true (default), rejeita antes de chamar HIBP
      await pm.assertAcceptable('commonpwd', { checkPwned: true });
      assert.fail('deveria ter lançado');
    } catch (error) {
      assert.instanceOf(error, PasswordPolicyError);
      // Deve ser password.common, NÃO HIBP error (HIBP nem foi chamado)
      assert.equal((error as PasswordPolicyError).key, 'password.common');
    }
  });

  test('aceita senha fora da lista (blockCommon=true)', async ({ assert }) => {
    __setCommonPasswordsForTests(new Set(['badone']));
    const pm = new PasswordManager();
    await pm.assertAcceptable('Xk9pQ!mZr7nL'); // não está na lista
    assert.isTrue(true);
  });
});
