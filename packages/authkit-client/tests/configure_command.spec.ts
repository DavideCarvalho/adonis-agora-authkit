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
async function scratchApp(
  argv: string[] = [],
  options: { authConfig?: string; withAuthDependency?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'authkit-client-configure-'));
  await mkdir(join(root, 'start'), { recursive: true });
  await writeFile(join(root, '.env'), '');
  // `@adonisjs/auth` already a dependency: the spec must never run a real install.
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'scratch',
      dependencies: options.withAuthDependency === false ? {} : { '@adonisjs/auth': '^10.0.0' },
    }),
  );
  if (options.authConfig !== undefined) {
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config/auth.ts'), options.authConfig);
  }
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
  const command = await ace.create(Configure, ['@adonis-agora/authkit-client', ...argv]);
  return { root, command };
}

const logsOf = (command: Awaited<ReturnType<typeof scratchApp>>['command']) =>
  command.ui.logger
    .getLogs()
    .map((log) => log.message)
    .join('\n');

test.group('node ace configure (app descartável)', () => {
  test('default: ctx.auth via @adonisjs/auth + authkitClientGuard, ctx.authkit ao lado', async ({
    assert,
    cleanup,
  }) => {
    const { root, command } = await scratchApp();
    cleanup(() => rm(root, { recursive: true, force: true }));
    const { configure } = await import('../build/commands/configure.js');
    await configure(command);

    const read = (path: string) => readFile(join(root, path), 'utf8');

    const authConfig = await read('config/auth.ts');
    assert.include(authConfig, "from '@adonis-agora/authkit-client/auth'");
    assert.include(authConfig, 'authkitClientGuard({');
    assert.include(authConfig, 'sessionUserProvider({');
    assert.include(authConfig, "import('#models/user')");

    const rc = await read('adonisrc.ts');
    assert.include(rc, '@adonisjs/auth/auth_provider');
    assert.include(rc, '@adonis-agora/authkit-client/authkit_client_provider');

    const kernel = await read('start/kernel.ts');
    const initAt = kernel.indexOf('@adonisjs/auth/initialize_auth_middleware');
    const contextAt = kernel.indexOf('@adonis-agora/authkit-client/authkit_context_middleware');
    assert.isAbove(initAt, -1);
    assert.isAbove(contextAt, initAt, 'initialize_auth_middleware runs first');
    assert.match(kernel, /auth: \(\) => import\('#middleware\/auth_middleware'\)/);
    assert.match(kernel, /silentAuth: \(\) => import\('#middleware\/silent_auth_middleware'\)/);

    assert.include(await read('app/middleware/auth_middleware.ts'), 'authenticateUsing');
    assert.include(await read('app/middleware/auth_middleware.ts'), "'/auth/login'");
    assert.include(await read('app/middleware/silent_auth_middleware.ts'), 'ctx.auth.check()');
    assert.include(logsOf(command), 'middleware.auth()');
  }).timeout(30_000);

  test('--model aponta o provider para o model do app', async ({ assert, cleanup }) => {
    const { root, command } = await scratchApp(['--model=#models/app_user']);
    cleanup(() => rm(root, { recursive: true, force: true }));
    const { configure } = await import('../build/commands/configure.js');
    await configure(command);

    assert.include(
      await readFile(join(root, 'config/auth.ts'), 'utf8'),
      "import('#models/app_user')",
    );
  }).timeout(30_000);

  test('config/auth.ts existente não é sobrescrito; o configure imprime o que adicionar', async ({
    assert,
    cleanup,
  }) => {
    const existing = '// my own auth config\nexport default {}\n';
    const { root, command } = await scratchApp([], { authConfig: existing });
    cleanup(() => rm(root, { recursive: true, force: true }));
    const { configure } = await import('../build/commands/configure.js');
    await configure(command);

    assert.equal(await readFile(join(root, 'config/auth.ts'), 'utf8'), existing);
    const logs = logsOf(command);
    assert.include(logs, 'config/auth.ts already exists');
    assert.include(logs, 'authkitClientGuard({ provider: sessionUserProvider(');
  }).timeout(30_000);

  test('sem @adonisjs/auth no app e --no-install: imprime o comando de instalação', async ({
    assert,
    cleanup,
  }) => {
    const { root, command } = await scratchApp(['--no-install'], { withAuthDependency: false });
    cleanup(() => rm(root, { recursive: true, force: true }));
    const { configure } = await import('../build/commands/configure.js');
    await configure(command);

    const logs = logsOf(command);
    assert.include(logs, 'Please install following packages');
    assert.include(logs, '@adonisjs/auth');
    assert.include(await readFile(join(root, 'config/auth.ts'), 'utf8'), 'authkitClientGuard({');
  }).timeout(30_000);

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
      '@adonis-agora/authkit-client/authkit_context_middleware',
    );
    assert.include(await read('start/env.ts'), 'AUTHKIT_REDIRECT_URI');

    // #202: o configure ensina o registrar da lib como o caminho das rotas.
    assert.include(logsOf(command), 'registerOidcClient(router)');
  }).timeout(30_000);
});
