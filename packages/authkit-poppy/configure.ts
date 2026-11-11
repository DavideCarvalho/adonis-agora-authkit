/**
 * `node ace configure @adonis-agora/authkit-poppy` (ou `node ace add`). O Poppy não tem provider
 * próprio nem env: liga-se em `personalAgents.extensions` do `config/authkit.ts`, então o comando
 * confere o que precisa existir e mostra a mudança — editar o `defineConfig` do host
 * automaticamente seria frágil demais.
 */
import { existsSync, readFileSync } from 'node:fs';
import type Configure from '@adonisjs/core/commands/configure';

export const POPPY_CONFIG_SNIPPET = `import { poppy } from '@adonis-agora/authkit-poppy'

export default defineConfig({
  // ...
  personalAgents: {
    extensions: [
      poppy({
        organization: { name: 'Shop', domain: 'shop.example' },
        scopes: { 'orders:read': 'See your orders' },
      }),
    ],
  },
})`;

export async function configure(command: Configure) {
  const logger = command.logger;
  const pkgPath = command.app.makePath('package.json');
  const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps['@adonis-agora/authkit-server']) {
    logger.error(
      '@adonis-agora/authkit-poppy plugs into @adonis-agora/authkit-server. Run `node ace add @adonis-agora/authkit-server` first.',
    );
    command.exitCode = 1;
    return;
  }

  const configPath = command.app.configPath('authkit.ts');
  const source = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  if (source.includes('@adonis-agora/authkit-poppy')) {
    logger.success('config/authkit.ts already imports @adonis-agora/authkit-poppy');
    return;
  }
  if (/personalAgents\s*:\s*\{[^}]*\bpoppy\s*:/s.test(source)) {
    logger.warning(
      'config/authkit.ts still has `personalAgents.poppy` (authkit-server 0.x). Move it into `personalAgents.extensions: [poppy({ ... })]` — same options.',
    );
  }
  logger.info('Add the Poppy extension to config/authkit.ts:');
  command.ui.instructions().heading('config/authkit.ts').add(POPPY_CONFIG_SNIPPET).render();
  logger.info(
    "Tables (auth_poppy_*) are created at boot with AuthKit's own (`schema.autoManage`); with it off, call `ensurePoppySchema(this.db)` in a migration.",
  );
}
