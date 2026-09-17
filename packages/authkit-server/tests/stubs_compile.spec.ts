import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@japa/runner';
import { compile } from 'tempura';

const STUBS_ROOT = fileURLToPath(new URL('../build/stubs', import.meta.url));

/**
 * Todos os `.stub` do pacote, recursivamente.
 */
function findStubs(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...findStubs(full));
    else if (entry.endsWith('.stub')) found.push(full);
  }
  return found;
}

/**
 * Regressão do bug #194: `node ace configure` quebrava em TODOS os presets com
 * `SyntaxError` porque o gerador de stubs compila o `.stub` como template — e
 * uma crase dentro do stub (em comentário, por exemplo) fecha o template mais
 * cedo, jogando o texto seguinte no parser de JavaScript.
 *
 * O detalhe que fazia isso passar batido é que nenhum teste chamava o
 * `makeUsingStub`: o spec de e2e lê o stub direto e remove o frontmatter
 * `{{{ ... }}}`, então o stub nunca era compilado. Este teste compila todos.
 *
 * Só o `compile` importa aqui: é ele que monta a função (e portanto onde o
 * `SyntaxError` nasce). Renderizar exigiria props de cada stub e traria ruído
 * que não tem a ver com a regressão.
 */
test.group('configure stubs', () => {
  test('todo .stub é compilável pelo template engine', ({ assert }) => {
    const stubs = findStubs(STUBS_ROOT);
    assert.isAbove(stubs.length, 0, 'nenhum .stub encontrado — o build rodou?');

    const broken: string[] = [];

    for (const file of stubs) {
      const raw = readFileSync(file, 'utf8');
      const body = raw.replace(/^\{\{\{[\s\S]*?\}\}\}\n?/, '');

      try {
        compile(body);
      } catch (error) {
        const prefix = relative(STUBS_ROOT, file);
        broken.push(`${prefix}: ${(error as Error).message}`);
      }
    }

    assert.deepEqual(
      broken,
      [],
      `stubs que quebram o \`node ace configure\`:\n  ${broken.join('\n  ')}`,
    );
  });

  test('nenhum .stub usa crase (a causa raiz do bug #194)', ({ assert }) => {
    const offenders: string[] = [];

    for (const file of findStubs(STUBS_ROOT)) {
      const raw = readFileSync(file, 'utf8');
      if (raw.includes('`')) offenders.push(relative(STUBS_ROOT, file));
    }

    assert.deepEqual(
      offenders,
      [],
      `stubs com crase quebram a compilação do template — use aspas ou nada:\n  ${offenders.join('\n  ')}`,
    );
  });
});
