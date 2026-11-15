import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { SealedColumnReport } from '../src/crypto/authkit_crypto.js';

/**
 * `authkit:crypto:reseal` — sela de novo, com a chave atual, o que o AuthKit guarda encriptado
 * em repouso: o keystore (chaves privadas do JWKS) e os segredos TOTP. Os valores selados com uma
 * chave antiga de `crypto.keys` ou no formato anterior ao crypto kit; `--all`, todos.
 */
export default class AuthkitCryptoReseal extends BaseCommand {
  static commandName = 'authkit:crypto:reseal';
  static description =
    'Re-seal what AuthKit keeps encrypted at rest (JWKS keystore, TOTP secrets) with the current key.';

  static help = [
    'Re-seals values sealed with an older key of `crypto.keys` (config/authkit.ts) and values in',
    'the format AuthKit wrote before the crypto kit. Values the app changes meanwhile are skipped',
    '(run again). Exits 1 when a value does not open with the configured keys.',
    '',
    'Examples:',
    '  node ace authkit:crypto:reseal --dry-run',
    '  node ace authkit:crypto:reseal --json',
    '  node ace authkit:crypto:reseal --all      # after rotating the keys of config/encryption.ts',
  ];

  static options: CommandOptions = { startApp: true };

  @flags.boolean({ description: 'Count and test-open what would be re-sealed; write nothing.' })
  declare dryRun?: boolean;

  @flags.boolean({
    description:
      'Re-seal every value, not only retired/legacy ones (after rotating config/encryption.ts).',
  })
  declare all?: boolean;

  @flags.boolean({ description: 'Machine-readable output.' })
  declare json?: boolean;

  async run() {
    const service = await this.app.container.make('authkit.server');
    const report = await service.sealedAtRest({
      dryRun: this.dryRun === true,
      all: this.all === true,
    });
    if (this.json) {
      this.logger.log(JSON.stringify(report, null, 2));
    } else if (report.columns.length === 0) {
      this.logger.info('Nothing sealed at rest (no encrypted keystore, no TOTP secrets store).');
    } else {
      const table = this.ui.table();
      table.head([
        'Column',
        'Scanned',
        'Active',
        'Retired',
        'Legacy',
        'Unreadable',
        report.dryRun ? 'Would reseal' : 'Resealed',
        'Failed',
        'Skipped',
      ]);
      for (const c of report.columns as SealedColumnReport[]) {
        table.row(
          [
            c.column,
            c.scanned,
            c.active,
            c.retired,
            c.legacy,
            c.unreadable,
            c.resealed,
            c.failed,
            c.skipped,
          ].map(String),
        );
      }
      table.render();
      if (report.dryRun) this.logger.info('Dry run: nothing was written.');
    }
    const failed = report.columns.reduce((total, c) => total + c.failed, 0);
    if (failed > 0) {
      this.logger.logError(
        `${failed} value(s) did not open with the configured keys: put the key they were sealed with back in \`crypto.keys\`.`,
      );
      this.exitCode = 1;
    }
  }
}
