import { args, BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { settingsUnset } from '../src/commands/settings_commands.js';

/**
 * Remove uma runtime setting de `auth_settings` (reset to config/default).
 *
 * Exemplo:
 *   node ace authkit:settings:unset lockout
 *   node ace authkit:settings:unset lockout --json
 */
export default class AuthkitSettingsUnset extends BaseCommand {
  static commandName = 'authkit:settings:unset';
  static description = 'Remove uma runtime setting de `auth_settings` (reset ao config/default).';

  static help = [
    'Remove a setting pelo nome da key. Após a remoção, o config estático ou o default',
    'da lib passa a ser a fonte de verdade para aquela setting.',
    'Avisa quando a key não estava definida (nada é apagado).',
    'Audita settings.updated (action: deleted) com actor "cli".',
    '',
    'Exemplos:',
    '  node ace authkit:settings:unset lockout',
    '  node ace authkit:settings:unset session_policy --json',
  ];

  static options: CommandOptions = { startApp: true };

  @args.string({ description: 'Nome da setting a remover (ex.: lockout, session_policy).' })
  declare key: string;

  @flags.boolean({ description: 'Output em JSON machine-readable.' })
  declare json?: boolean;

  async run() {
    await settingsUnset(this.app, this.key, {
      json: this.json,
      logger: {
        info: (m: string) => this.logger.info(m),
        warn: (m: string) => this.logger.warning(m),
        error: (m: string) => this.logger.logError(m),
      },
    });
  }
}
