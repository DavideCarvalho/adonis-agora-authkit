import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@japa/runner';
import * as tempura from 'tempura';

function collectStubFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...collectStubFiles(fullPath));
    } else if (entry.endsWith('.stub')) {
      files.push(fullPath);
    }
  }
  return files;
}

test.group('configure stubs', () => {
  test('stubsRoot resolve e os .stub existem no build', async ({ assert }) => {
    const { stubsRoot } = await import('../build/stubs/main.js');
    assert.isTrue(existsSync(join(stubsRoot, 'config/authkit_client.stub')));
    assert.isTrue(existsSync(join(stubsRoot, 'controllers/oidc_session_controller.stub')));
  });

  test('todo .stub compila via tempura sem lançar erro (regressão do backtick não escapado)', async ({
    assert,
  }) => {
    // `codemods.makeUsingStub` (chamado por `node ace configure`) compila o
    // conteúdo bruto do stub com `tempura.compile(...)`, envolvendo-o numa
    // template literal JS interna. Um backtick literal dentro do stub (mesmo
    // dentro de um comentário `//`) fecha essa template literal cedo e quebra
    // TODO `node ace configure` que use esse stub — foi exatamente o que
    // aconteceu em config/authkit_client.stub (backtick em torno de
    // `resolveRoles` num comentário). Este teste compila todo `.stub`
    // publicado para pegar essa classe de regressão automaticamente, em vez
    // de só checar a existência do arquivo.
    const { stubsRoot } = await import('../build/stubs/main.js');
    const stubFiles = collectStubFiles(stubsRoot);
    assert.isAbove(stubFiles.length, 0);

    for (const stubFile of stubFiles) {
      const content = readFileSync(stubFile, 'utf8');
      assert.doesNotThrow(() => {
        tempura.compile(content, { props: [] });
      }, `falha ao compilar ${stubFile} via tempura`);
    }
  });
});
