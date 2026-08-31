import { args, BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { settingsGet } from '../src/commands/settings_commands.js';

/**
 * Obtém uma runtime setting por key.
 *
 * Exemplo:
 *   node ace authkit:settings:get lockout
 *   node ace authkit:settings:get lockout --json
 */
export default class AuthkitSettingsGet extends BaseCommand {
  static commandName = 'authkit:settings:get';
  static description = 'Obtém uma runtime setting por key de `auth_settings`.';

  static help = [
    'Obtém o valor atual de uma setting pelo nome da key.',
    'Retorna aviso quando a setting não está definida (config/default aplica).',
    '',
    'Exemplos:',
    '  node ace authkit:settings:get lockout',
    '  node ace authkit:settings:get session_policy --json',
  ];

  static options: CommandOptions = { startApp: true };

  @args.string({ description: 'Nome da setting (ex.: lockout, session_policy).' })
  declare key: string;

  @flags.boolean({ description: 'Output em JSON machine-readable.' })
  declare json?: boolean;

  async run() {
    await settingsGet(this.app, this.key, {
      json: this.json,
      logger: {
        info: (m: string) => this.logger.info(m),
        warn: (m: string) => this.logger.warning(m),
      },
    });
  }
}
