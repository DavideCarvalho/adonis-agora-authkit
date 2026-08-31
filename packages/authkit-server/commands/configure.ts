import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from '../stubs/main.js';
import { resolveUiPreset, type UiPreset, uiStubPaths } from './ui_preset.js';

function assertPresetPrereqs(preset: UiPreset, appRoot: string) {
  if (preset !== 'react') return;
  const pkgPath = join(appRoot, 'package.json');
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const hasInertia = !!deps['@adonisjs/inertia'];
  const hasReact = !!deps.react;
  const hasVite =
    existsSync(join(appRoot, 'vite.config.ts')) || existsSync(join(appRoot, 'vite.config.js'));
  if (!hasInertia || !hasReact || !hasVite) {
    throw new Error(
      'authkit --ui=react requer @adonisjs/inertia + react + Vite no app. ' +
        'Rode `node ace add @adonisjs/inertia` (com React) antes, ou use --ui=edge|headless.',
    );
  }
}

export async function configure(command: Configure) {
  const flag = command.parsedFlags?.ui as string | undefined;
  const chosen =
    flag ??
    (await command.prompt.choice('UI das telas de login/consent', ['edge', 'react', 'headless']));
  const preset = resolveUiPreset(chosen);

  assertPresetPrereqs(preset, command.app.makePath());

  const codemods = await command.createCodemods();

  // O preset react usa um stub de config dedicado que inclui `inertiaRenderer` com
  // o allowlist `views` já preenchido — evitando SSR crash por páginas inexistentes.
  const configStub = preset === 'react' ? 'config/authkit_react.stub' : 'config/authkit.stub';
  await codemods.makeUsingStub(stubsRoot, configStub, {});
  await codemods.makeUsingStub(stubsRoot, 'models/auth_user.stub', {});
  for (const path of uiStubPaths(preset)) {
    await codemods.makeUsingStub(stubsRoot, path, {});
  }

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@adonis-agora/authkit-server/authkit_server_provider');
  });

  await codemods.defineEnvValidations({
    leadingComment: 'Variáveis do @adonis-agora/authkit-server (Authorization Server OIDC)',
    variables: {
      AUTHKIT_ISSUER: `Env.schema.string({ format: 'url', tld: false })`,
    },
  });

  await codemods.defineEnvVariables({
    AUTHKIT_ISSUER: 'http://localhost:3333/oidc',
  });
}
