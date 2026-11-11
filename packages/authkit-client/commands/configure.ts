import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from '../stubs/main.js';

const ADONIS_AUTH = '@adonisjs/auth';

/**
 * `node ace configure @adonis-agora/authkit-client`
 *
 * `ctx.auth` comes from `@adonisjs/auth`, backed by the AuthKit session through
 * `authkitClientGuard`, and `ctx.authkit` carries the AuthKit-only surface.
 * Flags:
 *
 * - `--model=<import>`: the user model the guard's provider loads (default `#models/user`).
 * - `--no-install`: print the install command instead of installing `@adonisjs/auth`.
 */
export async function configure(command: Configure) {
  const flags = (command.parsedFlags ?? {}) as Record<string, unknown>;
  const modelImport =
    typeof flags.model === 'string' && flags.model.trim() ? flags.model.trim() : '#models/user';

  const codemods = await command.createCodemods();
  await codemods.makeUsingStub(stubsRoot, 'config/authkit_client.stub', {});
  await codemods.makeUsingStub(stubsRoot, 'controllers/oidc_session_controller.stub', {});
  await codemods.updateRcFile((rc) => {
    rc.addProvider('@adonisjs/auth/auth_provider');
    rc.addProvider('@adonis-agora/authkit-client/authkit_client_provider');
  });

  await ensureAdonisAuth(command, codemods, flags.install !== false);

  const authConfigPath = command.app.configPath('auth.ts');
  if (existsSync(authConfigPath)) {
    command.logger.warning(
      'config/auth.ts already exists, so it was left as is. Add the AuthKit guard to it:\n' +
        "  import { authkitClientGuard } from '@adonis-agora/authkit-client/auth'\n" +
        `  web: authkitClientGuard({ provider: sessionUserProvider({ model: () => import('${modelImport}') }) }),`,
    );
  } else {
    await codemods.makeUsingStub(stubsRoot, 'config/auth.stub', { modelImport });
  }

  await codemods.makeUsingStub(stubsRoot, 'middleware/auth_middleware.stub', {});
  await codemods.makeUsingStub(stubsRoot, 'middleware/silent_auth_middleware.stub', {});
  await codemods.registerMiddleware('router', [
    { path: '@adonisjs/auth/initialize_auth_middleware' },
    { path: '@adonis-agora/authkit-client/authkit_context_middleware' },
  ]);
  await codemods.registerMiddleware('named', [
    { name: 'auth', path: '#middleware/auth_middleware' },
    { name: 'silentAuth', path: '#middleware/silent_auth_middleware' },
  ]);

  await codemods.defineEnvValidations({
    leadingComment: 'Variáveis do @adonis-agora/authkit-client (OIDC client)',
    variables: {
      AUTHKIT_ISSUER: `Env.schema.string({ format: 'url', tld: false })`,
      AUTHKIT_CLIENT_ID: 'Env.schema.string()',
      AUTHKIT_CLIENT_SECRET: 'Env.schema.string.optional()',
      AUTHKIT_REDIRECT_URI: `Env.schema.string({ format: 'url', tld: false })`,
    },
  });

  // As rotas não são registradas pelo configure. O caminho é o `registerOidcClient`
  // (startSession/endSession, RP-initiated logout, back-channel); o controller
  // ejetado acima existe só para quem precisa customizar o fluxo.
  command.logger.info(
    'Registre as rotas de sessão em start/routes.ts com registerOidcClient(router) ' +
      "(import { registerOidcClient } from '@adonis-agora/authkit-client'). " +
      'O app/controllers/oidc_session_controller.ts publicado é só para customizar o fluxo.',
  );
  command.logger.info(
    `ctx.auth usa o authkitClientGuard (config/auth.ts, model ${modelImport}): proteja rotas com ` +
      'middleware.auth() e leia auth.user. Para criar o usuário local no primeiro login, ' +
      'configure resolveUser: lucidMirror(User, …) em config/authkit_client.ts.',
  );
}

/** Installs `@adonisjs/auth` when the app does not depend on it yet. */
async function ensureAdonisAuth(
  command: Configure,
  codemods: Awaited<ReturnType<Configure['createCodemods']>>,
  install: boolean,
) {
  let manifest: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {};
  try {
    manifest = JSON.parse(await readFile(command.app.makePath('package.json'), 'utf8'));
  } catch {
    // No readable package.json: treat the dependency as missing.
  }
  if (manifest.dependencies?.[ADONIS_AUTH] || manifest.devDependencies?.[ADONIS_AUTH]) return;

  const packages = [{ name: ADONIS_AUTH, isDevDependency: false }];
  if (install) await codemods.installPackages(packages);
  else await codemods.listPackagesToInstall(packages);
}
