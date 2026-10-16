import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Configure from '@adonisjs/core/commands/configure';
import { IgnitorFactory } from '@adonisjs/core/factories';
import { test } from '@japa/runner';
import { uiStubDestination, uiStubPaths } from '../commands/ui_preset.js';

/**
 * Roda o `configure` DE VERDADE (codemods + gerador de stubs do AdonisJS) contra
 * um app descartável, para cada preset.
 *
 * Os specs de stub leem os arquivos direto ou só compilam os `.stub` — nenhum
 * deles passava pelo `makeUsingStub`, e foi assim que o `--ui=react` continuou
 * quebrado depois do primeiro fix do #194: as páginas `.tsx` do preset tinham
 * crases (template literals) e o frontmatter `{{{ exports() }}}` reescrito pelo
 * formatter para `{ exports() }`. Só executar o hook pega essa classe de bug.
 */
async function scratchApp(preset: string) {
  const root = await mkdtemp(join(tmpdir(), 'authkit-configure-'));
  await mkdir(join(root, 'start'), { recursive: true });
  await writeFile(join(root, '.env'), '');
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));
  await writeFile(
    join(root, 'adonisrc.ts'),
    `import { defineConfig } from '@adonisjs/core/app'\n\nexport default defineConfig({})\n`,
  );
  await writeFile(
    join(root, 'start/env.ts'),
    `import { Env } from '@adonisjs/core/env'\n\nexport default await Env.create(new URL('../', import.meta.url), {})\n`,
  );
  // Pré-requisitos do preset react (Inertia + React + Vite); inofensivos nos outros.
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'scratch',
      type: 'module',
      dependencies: { '@adonisjs/inertia': '*', react: '*' },
    }),
  );
  await writeFile(join(root, 'vite.config.ts'), 'export default {}\n');

  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .create(pathToFileURL(`${root}/`), { importer: (path) => import(path) });
  const app = ignitor.createApp('console');
  await app.init();
  await app.boot();

  const ace = await app.container.make('ace');
  ace.ui.switchMode('raw');
  const command = await ace.create(Configure, ['@adonis-agora/authkit-server', `--ui=${preset}`]);
  return { root, command };
}

async function runConfigure(preset: string) {
  const { root, command } = await scratchApp(preset);
  // O hook compilado, com o `stubsRoot` do build — o mesmo que o pacote publicado usa.
  const { configure } = await import('../build/commands/configure.js');
  await configure(command);
  return root;
}

const read = (root: string, path: string) => readFile(join(root, path), 'utf8');

test.group('node ace configure (app descartável)', () => {
  for (const preset of ['edge', 'headless', 'react'] as const) {
    test(`--ui=${preset} conclui e gera config, model, migration, provider e env`, async ({
      assert,
      cleanup,
    }) => {
      const root = await runConfigure(preset);
      cleanup(() => rm(root, { recursive: true, force: true }));

      const config = await read(root, 'config/authkit.ts');
      // #195: o config ejetado usa o contrato atual (accountStore), não a API removida.
      assert.include(config, 'accountStore: lucidAccountStore(AuthUser)');
      assert.notInclude(config, 'findAccount');
      assert.notInclude(config, 'verifyCredentials');
      if (preset === 'react') assert.include(config, 'inertiaRenderer');

      assert.include(await read(root, 'app/models/auth_user.ts'), 'class AuthUser');
      const migrations = await readdir(join(root, 'database/migrations'));
      assert.lengthOf(migrations, 1);
      assert.match(migrations[0], /^\d+_create_auth_users_table\.ts$/);
      assert.include(
        await read(root, join('database/migrations', migrations[0])),
        "tableName = 'auth_users'",
      );

      assert.include(
        await read(root, 'adonisrc.ts'),
        '@adonis-agora/authkit-server/authkit_server_provider',
      );
      assert.include(await read(root, 'start/env.ts'), 'AUTHKIT_ISSUER');
      assert.include(await read(root, '.env'), 'AUTHKIT_ISSUER');
    }).timeout(30_000);
  }

  test('--ui=react publica as páginas byte a byte, crases e template literals intactos', async ({
    assert,
    cleanup,
  }) => {
    const root = await runConfigure('react');
    cleanup(() => rm(root, { recursive: true, force: true }));
    const { stubsRoot } = await import('../build/stubs/main.js');

    const paths = uiStubPaths('react');
    assert.isAbove(paths.length, 0);
    for (const path of paths) {
      const destination = uiStubDestination(path);
      assert.isTrue(existsSync(join(root, destination)), `${destination} não foi gerado`);
      assert.equal(
        await read(root, destination),
        await readFile(join(stubsRoot, path), 'utf8'),
        `${destination} difere do stub`,
      );
    }
    // Sanidade: o conteúdo que quebrava o template engine chegou ao app.
    assert.include(
      await read(root, 'inertia/pages/authkit/login.tsx'),
      '`/auth/interaction/${uid}',
    );
    // Os imports relativos das páginas (../../components/auth_shell) resolvem no destino.
    assert.isTrue(existsSync(join(root, 'inertia/components/auth_shell.tsx')));
  }).timeout(30_000);
});

test.group('stubs React do preset', () => {
  test('são TSX puro, sem frontmatter (o configure define o destino)', async ({ assert }) => {
    const { stubsRoot } = await import('../build/stubs/main.js');
    for (const path of uiStubPaths('react')) {
      const content = await readFile(join(stubsRoot, path), 'utf8');
      assert.notMatch(content, /^\s*\{+\s*exports\(/, `${path} ainda tem frontmatter`);
    }
  });

  test('uiStubDestination mapeia components e pages para inertia/', ({ assert }) => {
    assert.equal(
      uiStubDestination('ui/react/components/auth_shell.tsx'),
      'inertia/components/auth_shell.tsx',
    );
    assert.equal(
      uiStubDestination('ui/react/pages/account/mfa.tsx'),
      'inertia/pages/authkit/account/mfa.tsx',
    );
    assert.throws(() => uiStubDestination('ui/react/other/x.tsx'), /sem destino conhecido/);
  });
});
