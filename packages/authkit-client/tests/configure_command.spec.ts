import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Configure from '@adonisjs/core/commands/configure';
import { IgnitorFactory } from '@adonisjs/core/factories';
import { test } from '@japa/runner';

/**
 * Roda o `configure` DE VERDADE (codemods + gerador de stubs do AdonisJS) contra
 * um app descartável. Os specs de stub só leem/compilam os arquivos; este
 * executa o hook como o `node ace configure` faria.
 */
async function scratchApp() {
  const root = await mkdtemp(join(tmpdir(), 'authkit-client-configure-'));
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
  await writeFile(
    join(root, 'start/kernel.ts'),
    [
      `import router from '@adonisjs/core/services/router'`,
      `import server from '@adonisjs/core/services/server'`,
      ``,
      `server.use([])`,
      `router.use([])`,
      `export const middleware = router.named({})`,
      ``,
    ].join('\n'),
  );

  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .create(pathToFileURL(`${root}/`), { importer: (path) => import(path) });
  const app = ignitor.createApp('console');
  await app.init();
  await app.boot();

  const ace = await app.container.make('ace');
  ace.ui.switchMode('raw');
  const command = await ace.create(Configure, ['@adonis-agora/authkit-client']);
  return { root, command };
}

test.group('node ace configure (app descartável)', () => {
  test('gera config + controller, registra provider/middleware/env e aponta para registerOidcClient', async ({
    assert,
    cleanup,
  }) => {
    const { root, command } = await scratchApp();
    cleanup(() => rm(root, { recursive: true, force: true }));
    const { configure } = await import('../build/commands/configure.js');
    await configure(command);

    const read = (path: string) => readFile(join(root, path), 'utf8');

    assert.include(await read('config/authkit_client.ts'), 'defineConfig');
    // #202: o controller ejetado passa pelo manager, nunca pela sessão crua.
    const controller = await read('app/controllers/oidc_session_controller.ts');
    assert.include(controller, 'this.authkit.startSession(ctx, tokenSet)');
    assert.include(controller, 'this.authkit.endSession(ctx)');
    assert.notMatch(controller, /session\.(put|forget)\([^)]*sessionKey/);

    assert.include(
      await read('adonisrc.ts'),
      '@adonis-agora/authkit-client/authkit_client_provider',
    );
    assert.include(
      await read('start/kernel.ts'),
      '@adonis-agora/authkit-client/authkit_middleware',
    );
    assert.include(await read('start/env.ts'), 'AUTHKIT_REDIRECT_URI');

    // #202: o configure ensina o registrar da lib como o caminho das rotas.
    const logs = command.ui.logger
      .getLogs()
      .map((log) => log.message)
      .join('\n');
    assert.include(logs, 'registerOidcClient(router)');
  }).timeout(30_000);
});
