import { test } from '@japa/runner';
import { memoryLimiter } from '../src/replay.js';

const limits = { sessionsPerMinute: 2, mediatedPerHour: 1 };

test.group('poppy — memoryLimiter', () => {
  test('conta por janela e devolve o Retry-After em segundos', async ({ assert }) => {
    let t = 0;
    const limit = memoryLimiter(limits, { now: () => t });
    assert.isNull(await limit({ action: 'session', key: 'a' }));
    assert.isNull(await limit({ action: 'session', key: 'a' }));
    assert.equal(await limit({ action: 'session', key: 'a' }), 60);
    t = 30_000;
    assert.equal(await limit({ action: 'session', key: 'a' }), 30);
    t = 60_000;
    assert.isNull(await limit({ action: 'session', key: 'a' }));
  });

  test('um identificador novo por pedido não cresce o mapa além do teto', async ({ assert }) => {
    let t = 0;
    const limit = memoryLimiter(limits, { max: 3, now: () => t });
    // `victim` estoura a cota; depois, três e-mails novos chegam (janelas ainda abertas).
    assert.isNull(await limit({ action: 'mediated', key: 'victim' }));
    assert.isNotNull(await limit({ action: 'mediated', key: 'victim' }));
    for (const email of ['x1', 'x2']) {
      t += 1;
      assert.isNull(await limit({ action: 'mediated', key: email }));
    }
    // Ainda no teto (3): a vítima continua limitada.
    assert.isNotNull(await limit({ action: 'mediated', key: 'victim' }));
    // A quarta chave tira a MAIS ANTIGA (a vítima), nunca cresce o mapa.
    t += 1;
    assert.isNull(await limit({ action: 'mediated', key: 'x3' }));
    assert.isNotNull(await limit({ action: 'mediated', key: 'x2' }));
    assert.isNotNull(await limit({ action: 'mediated', key: 'x3' }));
    assert.isNull(await limit({ action: 'mediated', key: 'victim' }));
  });

  test('janelas vencidas saem antes de qualquer despejo', async ({ assert }) => {
    let t = 0;
    const limit = memoryLimiter(limits, { max: 2, now: () => t });
    // `s` é uma janela de sessão (1 min); `m` é de Mediated (1 h), já estourada.
    assert.isNull(await limit({ action: 'session', key: 's' }));
    t = 1;
    assert.isNull(await limit({ action: 'mediated', key: 'm' }));
    assert.isNotNull(await limit({ action: 'mediated', key: 'm' }));
    // Passou 1 min: a janela de `s` venceu e sai no lugar de `m`, que segue limitada.
    t = 61_000;
    assert.isNull(await limit({ action: 'mediated', key: 'n' }));
    assert.isNotNull(await limit({ action: 'mediated', key: 'm' }));
  });

  test('um teto inválido falha alto', ({ assert }) => {
    assert.throws(() => memoryLimiter(limits, { max: 0 }), /max must be a positive integer/);
  });
});
