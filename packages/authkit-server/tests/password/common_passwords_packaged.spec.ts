import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from '@japa/runner';

/**
 * Regressão: garante que o word list de senhas comuns é carregado a partir
 * do artefato *empacotado* (`build/`), não só de `src/`.
 *
 * O bug original: `tsc` emite `src/password/common_passwords.ts` para
 * `build/src/password/common_passwords.js`, mas o build script copiava o
 * `.txt` para `build/password/` — um diretório diferente. `dirname(import.meta.url)`
 * dentro do módulo compilado nunca encontrava o arquivo, e o fail-safe
 * silenciosamente virava um Set vazio. Todo o suite de `common_passwords.spec.ts`
 * roda via ts-exec direto de `src/`, onde o caminho relativo sempre foi
 * correto — por isso nada detectava a quebra. Este teste importa
 * especificamente de `build/` para fechar esse buraco.
 *
 * IMPORTANTE — por que este arquivo tem uma asserção de `existsSync`, e por
 * que ela não pode ser removida como "redundante" com as de load: a correção
 * em `loadCommonPasswords` inclui uma lista de candidatos cujo último item lê
 * direto de `src/password/common_passwords.txt` (fallback "src/ a partir de
 * um build"). Num checkout de repo — que é o único ambiente onde esta suite
 * roda — `src/` está sempre presente. Isso significa que as asserções de
 * *load* (`commonPasswordsCount()`, `isCommonPassword()`) continuam passando
 * mesmo que APENAS o alvo de cópia do build regrida para `build/password/`
 * de novo (o bug original, exatamente) — o fallback para `src/` mascara a
 * regressão. Por isso este teste também afirma, independentemente de qual
 * candidato a lista resolve em runtime, que o `.txt` existe fisicamente no
 * caminho-irmão do módulo compilado (`build/src/password/common_passwords.txt`).
 * Essa é a única asserção que falha no exato momento em que o alvo de cópia
 * regride — as de load não são a guarda real, apesar da aparência.
 *
 * Pula (não falha) se `build/` não existir — um checkout limpo sem build
 * não deve quebrar o suite. Mas se `build/` existir e a lista vier vazia, ou o
 * `.txt` não existir no caminho-irmão, FALHA — essa é exatamente a regressão
 * que este teste existe para pegar.
 */
const buildEntryUrl = new URL('../../build/src/password/common_passwords.js', import.meta.url);
const buildTxtPath = fileURLToPath(
  new URL('../../build/src/password/common_passwords.txt', import.meta.url),
);
const buildExists = existsSync(fileURLToPath(buildEntryUrl));

test.group('common_passwords — artefato empacotado (build/)', (group) => {
  group.each.skip(!buildExists, 'build/ não existe — rode `pnpm build` antes deste teste');

  test('build/src/password/common_passwords.txt existe no caminho-irmão do módulo compilado', ({
    assert,
  }) => {
    assert.isTrue(
      existsSync(buildTxtPath),
      `esperava encontrar o .txt em ${buildTxtPath} — se o alvo de cópia do build script regrediu para build/password/, esta asserção é a única que detecta isso (as de load abaixo podem passar mesmo assim via o fallback src/ da lista de candidatos)`,
    );
  });

  test('build/ carrega uma lista não-trivial de senhas comuns', async ({ assert }) => {
    const mod = await import(buildEntryUrl.href);
    const count = mod.commonPasswordsCount();
    assert.isAbove(
      count,
      1000,
      'commonPasswordsCount() a partir de build/ deveria ser > 1000 — se vier 0, o .txt não está onde o módulo compilado procura',
    );
  });

  test('build/ rejeita uma senha comum conhecida', async ({ assert }) => {
    const mod = await import(buildEntryUrl.href);
    assert.isTrue(mod.isCommonPassword('password'));
  });

  test('build/ aceita uma senha claramente incomum', async ({ assert }) => {
    const mod = await import(buildEntryUrl.href);
    assert.isFalse(mod.isCommonPassword('Xk9pQ!mZr7nL-uncommon-42'));
  });
});
