import { createHmac } from 'node:crypto';
/**
 * Testes para a feature de pepper no PasswordManager.
 *
 * Cobre:
 *   - Hash com pepper aplica HMAC antes do hasher
 *   - Verify com pepper corrente
 *   - Verify sem pepper (legacy back-compat)
 *   - Rotação de pepper (array): verifica com pepper antigo → lazy re-hash
 *   - Sem pepper: comportamento inalterado
 */
import { test } from '@japa/runner';
import {
  applyCurrentPepper,
  applyPepper,
  PasswordManager,
  resolvePeppers,
} from '../../src/password/password_manager.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVerifyHooks(storedHash: string) {
  return {
    nativeVerify: async (hashed: string, plain: string) => hashed === `HASH:${plain}`,
    needsRehash: (_hashed: string) => false,
  };
}

/** Cria hooks que verificam pelo sufixo de um HMAC simulado. */
function makeHmacVerifyHooks(pepper: string) {
  return {
    nativeVerify: async (_hashed: string, plain: string) => {
      // Simula: o hash armazenado foi criado com applyPepper(original, pepper)
      // então plain já chegou com pepper aplicado.
      return plain === _hashed.replace('HASH:', '');
    },
    needsRehash: () => false,
  };
}

// ---------------------------------------------------------------------------
// applyPepper
// ---------------------------------------------------------------------------

test.group('applyPepper', () => {
  test('aplica HMAC-SHA256 corretamente', ({ assert }) => {
    const result = applyPepper('secret', 'pepper1');
    const expected = createHmac('sha256', 'pepper1').update('secret').digest('hex');
    assert.equal(result, expected);
  });

  test('diferentes peppers geram hashes diferentes', ({ assert }) => {
    assert.notEqual(applyPepper('secret', 'pepper1'), applyPepper('secret', 'pepper2'));
  });

  test('mesma entrada + mesmo pepper → mesmo resultado (determinístico)', ({ assert }) => {
    assert.equal(applyPepper('secret', 'pepper1'), applyPepper('secret', 'pepper1'));
  });
});

// ---------------------------------------------------------------------------
// applyCurrentPepper
// ---------------------------------------------------------------------------

test.group('applyCurrentPepper', () => {
  test('sem pepper → retorna a senha inalterada', ({ assert }) => {
    assert.equal(applyCurrentPepper('secret', undefined), 'secret');
  });

  test('pepper string → aplica HMAC', ({ assert }) => {
    const result = applyCurrentPepper('secret', 'pepper1');
    assert.equal(result, applyPepper('secret', 'pepper1'));
  });

  test('pepper array → usa o PRIMEIRO (corrente)', ({ assert }) => {
    const result = applyCurrentPepper('secret', ['pepper2', 'pepper1']);
    assert.equal(result, applyPepper('secret', 'pepper2'));
  });

  test('array vazio → retorna a senha inalterada', ({ assert }) => {
    assert.equal(applyCurrentPepper('secret', []), 'secret');
  });
});

// ---------------------------------------------------------------------------
// resolvePeppers
// ---------------------------------------------------------------------------

test.group('resolvePeppers', () => {
  test('sem pepper → retorna [""] (sentinel sem-pepper)', ({ assert }) => {
    assert.deepEqual(resolvePeppers(undefined), ['']);
  });

  test('pepper string → retorna [string, ""]', ({ assert }) => {
    assert.deepEqual(resolvePeppers('p1'), ['p1', '']);
  });

  test('pepper array → retorna array + "" no final', ({ assert }) => {
    assert.deepEqual(resolvePeppers(['p2', 'p1']), ['p2', 'p1', '']);
  });
});

// ---------------------------------------------------------------------------
// PasswordManager.verify com pepper
// ---------------------------------------------------------------------------

test.group('PasswordManager.verify com pepper', () => {
  test('sem pepper: verifica normalmente (back-compat)', async ({ assert }) => {
    const pm = new PasswordManager();
    const hooks = {
      nativeVerify: async (_h: string, plain: string) => plain === 'secret',
      needsRehash: () => false,
    };
    const res = await pm.verify('HASH', 'secret', hooks);
    assert.deepEqual(res, { ok: true, rehash: false });
  });

  test('com pepper: verifica com HMAC aplicado', async ({ assert }) => {
    const pm = new PasswordManager({ pepper: 'pepper1' });
    const peppered = applyPepper('secret', 'pepper1');
    const hooks = {
      nativeVerify: async (_h: string, plain: string) => plain === peppered,
      needsRehash: () => false,
    };
    const res = await pm.verify('HASH', 'secret', hooks);
    assert.deepEqual(res, { ok: true, rehash: false });
  });

  test('com pepper: senha ERRADA não confere', async ({ assert }) => {
    const pm = new PasswordManager({ pepper: 'pepper1' });
    const hooks = {
      nativeVerify: async (_h: string, plain: string) => plain === 'wrong',
      needsRehash: () => false,
    };
    const res = await pm.verify('HASH', 'secret', hooks);
    assert.deepEqual(res, { ok: false, rehash: false });
  });

  test('legacy sem pepper: confere com sentinel "" → rehash=true (re-hash com pepper)', async ({
    assert,
  }) => {
    const pm = new PasswordManager({ pepper: 'pepper1' });
    // O hash foi criado SEM pepper (conta legacy) → native verifica com plain direto.
    const hooks = {
      // Retorna true apenas quando a senha chega SEM pepper (plain = 'secret').
      nativeVerify: async (_h: string, plain: string) => plain === 'secret',
      needsRehash: () => false,
    };
    const res = await pm.verify('HASH', 'secret', hooks);
    // Deve conferer via sentinel sem-pepper e sinalizar rehash.
    assert.isTrue(res.ok);
    assert.isTrue(res.rehash);
  });

  test('rotação de peppers: verifica com pepper antigo → rehash=true', async ({ assert }) => {
    const pm = new PasswordManager({ pepper: ['newPepper', 'oldPepper'] });
    const pepperedOld = applyPepper('secret', 'oldPepper');
    const hooks = {
      // Hash foi criado com oldPepper → só confere quando plain = pepperedOld.
      nativeVerify: async (_h: string, plain: string) => plain === pepperedOld,
      needsRehash: () => false,
    };
    const res = await pm.verify('HASH', 'secret', hooks);
    assert.isTrue(res.ok);
    // Pepper antigo → obrigatório re-hash com o corrente.
    assert.isTrue(res.rehash);
  });

  test('rotação: pepper corrente não gera rehash (só parâmetros desatualizados)', async ({
    assert,
  }) => {
    const pm = new PasswordManager({ pepper: ['newPepper', 'oldPepper'] });
    const pepperedNew = applyPepper('secret', 'newPepper');
    const hooks = {
      nativeVerify: async (_h: string, plain: string) => plain === pepperedNew,
      needsRehash: () => false,
    };
    const res = await pm.verify('HASH', 'secret', hooks);
    assert.deepEqual(res, { ok: true, rehash: false });
  });

  test('rotação: pepper corrente com needsRehash=true → rehash=true', async ({ assert }) => {
    const pm = new PasswordManager({ pepper: ['newPepper', 'oldPepper'] });
    const pepperedNew = applyPepper('secret', 'newPepper');
    const hooks = {
      nativeVerify: async (_h: string, plain: string) => plain === pepperedNew,
      needsRehash: () => true, // parâmetros desatualizados
    };
    const res = await pm.verify('HASH', 'secret', hooks);
    assert.deepEqual(res, { ok: true, rehash: true });
  });

  test('legacyVerifier: tenta com pepper corrente e sem pepper', async ({ assert }) => {
    let callCount = 0;
    const pm = new PasswordManager({
      pepper: 'p1',
      legacyVerifier: async (_hashed, plain) => {
        callCount++;
        // Aceita a senha SEM pepper (sistema legado que não pepperou).
        return plain === 'secret' ? true : null;
      },
    });
    const hooks = {
      nativeVerify: async () => false, // native sempre falha
      needsRehash: () => false,
    };
    const res = await pm.verify('HASH', 'secret', hooks);
    assert.isTrue(res.ok);
    assert.isTrue(res.rehash);
    assert.isAbove(callCount, 0);
  });
});
