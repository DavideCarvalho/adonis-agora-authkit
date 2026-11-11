import { createHash } from 'node:crypto';
import { test } from '@japa/runner';
import { PasswordManager, PasswordPolicyError } from '../../src/password/password_manager.js';
import type { FetchLike } from '../../src/password/pwned.js';

function suffixOf(password: string): string {
  return createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase().slice(5);
}

test.group('PasswordManager.verify', () => {
  test('verificação nativa OK, sem rehash necessário', async ({ assert }) => {
    const pm = new PasswordManager();
    const res = await pm.verify('hashed', 'plain', {
      nativeVerify: async () => true,
      needsRehash: () => false,
    });
    assert.deepEqual(res, { ok: true, rehash: false });
  });

  test('verificação nativa OK, mas needsRehash → rehash true', async ({ assert }) => {
    const pm = new PasswordManager();
    const res = await pm.verify('staleHash', 'plain', {
      nativeVerify: async () => true,
      needsRehash: () => true,
    });
    assert.deepEqual(res, { ok: true, rehash: true });
  });

  test('nativa falha, sem legacyVerifier → não confere', async ({ assert }) => {
    const pm = new PasswordManager();
    const res = await pm.verify('hashed', 'wrong', {
      nativeVerify: async () => false,
      needsRehash: () => false,
    });
    assert.deepEqual(res, { ok: false, rehash: false });
  });

  test('nativa falha, legacyVerifier true → confere + rehash', async ({ assert }) => {
    const pm = new PasswordManager({
      legacyVerifier: async (hashed, plain) => hashed === '$2y$legacy' && plain === 'secret',
    });
    const res = await pm.verify('$2y$legacy', 'secret', {
      nativeVerify: async () => false,
      needsRehash: () => true,
    });
    assert.deepEqual(res, { ok: true, rehash: true });
  });

  test('nativa falha, legacyVerifier false → não confere', async ({ assert }) => {
    const pm = new PasswordManager({ legacyVerifier: async () => false });
    const res = await pm.verify('$2y$legacy', 'wrong', {
      nativeVerify: async () => false,
      needsRehash: () => false,
    });
    assert.deepEqual(res, { ok: false, rehash: false });
  });

  test('nativa falha, legacyVerifier null (formato não tratado) → não confere', async ({
    assert,
  }) => {
    const pm = new PasswordManager({ legacyVerifier: async () => null });
    const res = await pm.verify('unknown-format', 'x', {
      nativeVerify: async () => false,
      needsRehash: () => false,
    });
    assert.deepEqual(res, { ok: false, rehash: false });
  });

  test('nativeVerify lança → trata como falha e cai no legacy', async ({ assert }) => {
    const pm = new PasswordManager({ legacyVerifier: async () => true });
    const res = await pm.verify('weird', 'x', {
      nativeVerify: async () => {
        throw new Error('bad hash');
      },
      needsRehash: () => false,
    });
    assert.deepEqual(res, { ok: true, rehash: true });
  });

  test('legacyVerifier lança → null safe (não confere)', async ({ assert }) => {
    const pm = new PasswordManager({
      legacyVerifier: async () => {
        throw new Error('boom');
      },
    });
    const res = await pm.verify('x', 'y', {
      nativeVerify: async () => false,
      needsRehash: () => false,
    });
    assert.deepEqual(res, { ok: false, rehash: false });
  });

  test('hasLegacyVerifier reflete a config', ({ assert }) => {
    assert.isFalse(new PasswordManager().hasLegacyVerifier());
    assert.isTrue(new PasswordManager({ legacyVerifier: async () => null }).hasLegacyVerifier());
  });
});

test.group('PasswordManager.assertAcceptable', () => {
  test('passa com a senha cumprindo a política default', async ({ assert }) => {
    const pm = new PasswordManager();
    await pm.assertAcceptable('longenough');
    assert.isTrue(true);
  });

  test('lança PasswordPolicyError com a chave + params da regra (via policyOverride)', async ({
    assert,
  }) => {
    const pm = new PasswordManager();
    try {
      await pm.assertAcceptable('short', { minLength: 12 });
      assert.fail('deveria ter lançado');
    } catch (error) {
      assert.instanceOf(error, PasswordPolicyError);
      assert.equal((error as PasswordPolicyError).key, 'password.policy.min_length');
      assert.deepEqual((error as PasswordPolicyError).params, { min: 12 });
    }
  });

  test('checkPwned ligado via policyOverride + senha vazada → lança password.pwned', async ({
    assert,
  }) => {
    const suffix = suffixOf('password123');
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () => `${suffix}:99\n`,
    });
    const pm = new PasswordManager({}, { fetchImpl });
    try {
      // blockCommon: false para testar somente o caminho HIBP (password123 é senha comum)
      await pm.assertAcceptable('password123', { checkPwned: true, blockCommon: false });
      assert.fail('deveria ter lançado');
    } catch (error) {
      assert.instanceOf(error, PasswordPolicyError);
      assert.equal((error as PasswordPolicyError).key, 'password.pwned');
    }
  });

  test('checkPwned via policyOverride + senha NÃO vazada → passa', async ({ assert }) => {
    const fetchImpl: FetchLike = async () => ({ ok: true, status: 200, text: async () => '' });
    const pm = new PasswordManager({}, { fetchImpl });
    await pm.assertAcceptable('uniqueLongPass1', { checkPwned: true });
    assert.isTrue(true);
  });

  test('checkPwned fail-safe (rede falha) → permite a senha', async ({ assert }) => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('network down');
    };
    const warns: unknown[] = [];
    const pm = new PasswordManager({}, { fetchImpl, logger: { warn: (o) => warns.push(o) } });
    await pm.assertAcceptable('uniqueLongPass1', { checkPwned: true });
    assert.lengthOf(warns, 1);
  });

  test('política avaliada ANTES do pwned via policyOverride (não chama a rede se já viola)', async ({
    assert,
  }) => {
    let fetched = false;
    const fetchImpl: FetchLike = async () => {
      fetched = true;
      return { ok: true, status: 200, text: async () => '' };
    };
    const pm = new PasswordManager({}, { fetchImpl });
    await assert.rejects(() => pm.assertAcceptable('short', { minLength: 20, checkPwned: true }));
    assert.isFalse(fetched);
  });
});

test.group('PasswordManager.verify without a password', () => {
  test('a missing or empty password fails instead of throwing', async ({ assert }) => {
    const pm = new PasswordManager({ pepper: 'p' });
    const hooks = { nativeVerify: async () => true, needsRehash: () => false };
    for (const plain of [undefined, null, '']) {
      assert.deepEqual(await pm.verify('hash', plain as unknown as string, hooks), {
        ok: false,
        rehash: false,
      });
    }
  });
});
