/**
 * Migração dos endereços gravados (`authkit:users:normalize-emails`).
 *
 * É o que substitui a ponte de compatibilidade que existia na v0.70: em vez de
 * tentar grafias alternativas a cada login (uma query a mais por e-mail
 * desconhecido, no caminho de ataque), a base é corrigida UMA vez.
 *
 * PROVA DE MUTAÇÃO: tirar o modo relatório faz o primeiro teste gravar; tirar a
 * recusa por colisão faz a migração fundir duas contas no mesmo endereço.
 */

import { test } from '@japa/runner';
import type { AccountStore, AuthAccount } from '../../src/accounts/account_store.js';
import { normalizeAccountEmails } from '../../src/commands/normalize_emails.js';

/**
 * Store em memória com listagem paginada (ordenada por e-mail, como o Lucid) e
 * a capacidade de regravação. `withoutRewrite` simula um store de host que não
 * a implementa.
 */
function makeStore(emails: string[], options: { withoutRewrite?: boolean } = {}) {
  const accounts: AuthAccount[] = emails.map((email, i) => ({ id: `acc-${i + 1}`, email }));
  const store: any = {
    listAccounts: async ({ page = 1, size = 100 }: { page?: number; size?: number }) => {
      const sorted = [...accounts].sort((a, b) => a.email.localeCompare(b.email));
      return { data: sorted.slice((page - 1) * size, page * size), total: sorted.length };
    },
    findByEmail: async (email: string) => accounts.find((a) => a.email === email) ?? null,
  };
  if (!options.withoutRewrite) {
    store.rewriteAccountEmail = async (accountId: string, email: string) => {
      const row = accounts.find((a) => a.id === accountId);
      if (!row) return false;
      const taken = accounts.find((a) => a.email === email);
      if (taken && taken.id !== row.id) return false;
      row.email = email;
      return true;
    };
  }
  return { store: store as AccountStore, accounts };
}

test.group('authkit:users:normalize-emails — relatório (sem --apply)', () => {
  test('relata o que mudaria e NÃO grava nada', async ({ assert }) => {
    const { store, accounts } = makeStore([
      'Davi@Acme.com',
      'davicarvalho96@gmail.com',
      ' Espaco@Acme.com ',
    ]);

    const report = await normalizeAccountEmails(store);

    assert.equal(report.scanned, 3);
    assert.equal(report.applied, 0);
    assert.equal(report.alreadyNormalized, 1, 'a mutilada JÁ está normalizada como grafia');
    assert.deepEqual(
      report.changes.map((c) => [c.from, c.to]),
      [
        [' Espaco@Acme.com ', 'espaco@acme.com'],
        ['Davi@Acme.com', 'davi@acme.com'],
      ],
    );
    assert.isTrue(report.changes.every((c) => !c.applied));
    // O estado da base fica intacto.
    assert.deepEqual(
      accounts.map((a) => a.email),
      ['Davi@Acme.com', 'davicarvalho96@gmail.com', ' Espaco@Acme.com '],
    );
  });

  test('conta já normalizada não aparece como mudança', async ({ assert }) => {
    const { store } = makeStore(['davi@acme.com', 'ana@acme.com']);

    const report = await normalizeAccountEmails(store);

    assert.equal(report.alreadyNormalized, 2);
    assert.lengthOf(report.changes, 0);
    assert.lengthOf(report.collisions, 0);
    assert.lengthOf(report.unusable, 0);
  });

  test('e-mail vazio sai LISTADO, não como "já normalizada"', async ({ assert }) => {
    // Coluna nula/vazia/só espaços: normalizar daria string vazia como
    // identidade. A linha fica como está, mas NÃO pode se esconder dentro de uma
    // métrica que o operador lê como "essa está bem".
    const { store } = makeStore(['   ', 'davi@acme.com']);

    const report = await normalizeAccountEmails(store);

    assert.equal(report.alreadyNormalized, 1);
    assert.deepEqual(
      report.unusable.map((a) => a.email),
      ['   '],
    );
    assert.lengthOf(report.changes, 0);
  });

  test('a varredura pagina até o fim', async ({ assert }) => {
    const emails = Array.from({ length: 25 }, (_, i) => `User${i}@Acme.com`);
    const { store } = makeStore(emails);

    const report = await normalizeAccountEmails(store, { pageSize: 10 });

    assert.equal(report.scanned, 25);
    assert.lengthOf(report.changes, 25);
  });
});

test.group('authkit:users:normalize-emails — --apply', () => {
  test('grava a forma normalizada', async ({ assert }) => {
    const { store, accounts } = makeStore(['Davi@Acme.com', 'ana@acme.com']);

    const report = await normalizeAccountEmails(store, { apply: true });

    assert.equal(report.applied, 1);
    assert.isTrue(report.changes[0].applied);
    assert.deepEqual(accounts.map((a) => a.email).sort(), ['ana@acme.com', 'davi@acme.com']);
  });

  test('conta já normalizada não é tocada', async ({ assert }) => {
    const touched: string[] = [];
    const { store } = makeStore(['ana@acme.com', 'Davi@Acme.com']);
    const original = (store as any).rewriteAccountEmail;
    (store as any).rewriteAccountEmail = async (accountId: string, email: string) => {
      touched.push(accountId);
      return original(accountId, email);
    };

    await normalizeAccountEmails(store, { apply: true });

    assert.deepEqual(touched, ['acc-2'], 'só a conta fora da forma normalizada é regravada');
  });

  test('store sem a capacidade de regravar recusa o --apply', async ({ assert }) => {
    const { store, accounts } = makeStore(['Davi@Acme.com'], { withoutRewrite: true });

    await assert.rejects(
      () => normalizeAccountEmails(store, { apply: true }),
      /rewriteAccountEmail/,
    );
    assert.deepEqual(
      accounts.map((a) => a.email),
      ['Davi@Acme.com'],
    );
  });
});

test.group('authkit:users:normalize-emails — colisões', () => {
  test('colisão é RECUSADA, listada e não toca em nenhuma das contas', async ({ assert }) => {
    // Duas contas distintas que colapsam em `davi@acme.com`. A migração não
    // escolhe vencedor nem funde: as duas ficam como estão.
    const { store, accounts } = makeStore(['Davi@Acme.com', 'davi@acme.com', 'Ana@Acme.com']);

    const report = await normalizeAccountEmails(store, { apply: true });

    assert.lengthOf(report.collisions, 1);
    assert.equal(report.collisions[0].email, 'davi@acme.com');
    assert.deepEqual(report.collisions[0].accounts.map((a) => a.email).sort(), [
      'Davi@Acme.com',
      'davi@acme.com',
    ]);
    assert.equal(report.skippedByCollision, 2);
    // A conta fora da colisão segue sendo migrada normalmente.
    assert.equal(report.applied, 1);
    assert.deepEqual(accounts.map((a) => a.email).sort(), [
      'Davi@Acme.com',
      'ana@acme.com',
      'davi@acme.com',
    ]);
  });

  test('a conta da colisão não entra na lista de mudanças', async ({ assert }) => {
    const { store } = makeStore(['Davi@Acme.com', 'davi@acme.com']);

    const report = await normalizeAccountEmails(store);

    assert.lengthOf(report.changes, 0);
    assert.lengthOf(report.collisions, 1);
  });

  test('colisão que nasce DEPOIS da varredura é recusada pelo store', async ({ assert }) => {
    const { store } = makeStore(['Davi@Acme.com']);
    (store as any).rewriteAccountEmail = async () => false;

    const report = await normalizeAccountEmails(store, { apply: true });

    assert.equal(report.applied, 0);
    assert.isFalse(report.changes[0].applied);
    assert.isString(report.changes[0].error);
  });
});
