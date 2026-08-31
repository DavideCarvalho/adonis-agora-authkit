import { args, BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { settingsSet } from '../src/commands/settings_commands.js';

/**
 * Grava (upsert) uma runtime setting em `auth_settings`.
 *
 * Exemplo:
 *   node ace authkit:settings:set lockout '{"enabled":true,"maxAttempts":3}'
 *   node ace authkit:settings:set lockout '{"enabled":false}' --json
 *   node ace authkit:settings:set my_custom_key '{"foo":"bar"}'
 */
export default class AuthkitSettingsSet extends BaseCommand {
  static commandName = 'authkit:settings:set';
  static description =
    'Grava (upsert) uma runtime setting em `auth_settings`. Valida shape para keys conhecidas.';

  static help = [
    'Grava ou atualiza uma setting pelo nome da key com o valor JSON fornecido.',
    'Para keys conhecidas do catálogo AuthKit, valida o shape antes de persistir.',
    'Keys desconhecidas são aceitas com aviso (stored as-is).',
    'Audita settings.updated com actor "cli".',
    '',
    'Exemplos:',
    '  node ace authkit:settings:set lockout \'{"enabled":true,"maxAttempts":3,"windowSec":900}\'',
    '  node ace authkit:settings:set session_policy \'{"rememberEnabled":true,"rememberDays":14}\'',
    '  node ace authkit:settings:set token_ttl \'{"accessTokenSec":1800}\'',
    '  node ace authkit:settings:set my_flag \'{"enabled":true}\'',
    '  node ace authkit:settings:set lockout \'{"enabled":false}\' --json',
  ];

  static options: CommandOptions = { startApp: true };

  @args.string({ description: 'Nome da setting (ex.: lockout, session_policy, token_ttl).' })
  declare key: string;

  @args.string({ description: 'Valor JSON da setting (deve ser um objeto JSON válido).' })
  declare value: string;

  @flags.boolean({ description: 'Output em JSON machine-readable.' })
  declare json?: boolean;

  async run() {
    const ok = await settingsSet(this.app, this.key, this.value, {
      json: this.json,
      logger: {
        info: (m: string) => this.logger.info(m),
        warn: (m: string) => this.logger.warning(m),
        error: (m: string) => this.logger.logError(m),
      },
    });
    if (!ok) this.exitCode = 1;
  }
}
