import { readFile } from 'node:fs/promises';
import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { AccountStore } from '../src/accounts/account_store.js';
import { importUsers, parseImportFile } from '../src/commands/import_users.js';
import { resolveAuthkitConfig } from '../src/commands/resolve_config.js';

/**
 * Importa usuários de outro sistema para o account store do AuthKit. Os hashes
 * de senha entram COMO ESTÃO (sem re-hash) — o lazy rehash no primeiro login
 * migra cada conta para o hasher atual (padrão Auth0/Clerk). Os e-mails
 * duplicados são pulados (idempotente).
 */
export default class AuthkitImportUsers extends BaseCommand {
  static commandName = 'authkit:users:import';
  static description =
    'Importa usuários de um arquivo JSON/NDJSON pelo account store (hashes entram como estão; lazy rehash no login).';

  static help = [
    'Cada registro aceita: email (obrigatório), password_hash (opcional, qualquer formato),',
    'name, email_verified, global_roles. Aceita um array JSON ou NDJSON (uma linha por usuário).',
    'Hashes legados de outros sistemas entram COMO ESTÃO — configure password.legacyVerifier no',
    'accountStore para que o lazy rehash os migre no primeiro login.',
    '',
    'Exemplos:',
    '  node ace authkit:users:import --file=users.ndjson',
    '  node ace authkit:users:import --file=users.json --dry-run',
  ];

  static options: CommandOptions = { startApp: true };

  @flags.string({ description: 'Caminho do arquivo JSON/NDJSON com os usuários.' })
  declare file?: string;

  @flags.boolean({ description: 'Valida e relata SEM persistir nada.' })
  declare dryRun?: boolean;

  async run() {
    if (!this.file) {
      this.logger.logError('❌ --file é obrigatório (caminho do arquivo JSON/NDJSON).');
      this.exitCode = 1;
      return;
    }

    const config = await this.app.container.make('config');
    // Resolve o config provider exportado por defineConfig (provider cru não tem accountStore).
    const authkitConfig = await resolveAuthkitConfig(this.app, config.get('authkit', null));
    const store = authkitConfig?.accountStore as AccountStore | undefined;
    if (!store) {
      this.logger.logError("❌ config('authkit').accountStore ausente.");
      this.exitCode = 1;
      return;
    }

    let content: string;
    try {
      content = await readFile(this.app.makePath(this.file), 'utf-8');
    } catch (error) {
      this.logger.logError(`❌ Não foi possível ler o arquivo: ${(error as Error).message}`);
      this.exitCode = 1;
      return;
    }

    const { records, parseErrors } = parseImportFile(content);
    const report = await importUsers(store, records, { dryRun: this.dryRun });
    // Erros de parsing entram no relatório agregado.
    report.errors.unshift(...parseErrors);

    if (this.dryRun) {
      this.logger.info('🧪 Dry-run — nenhum dado foi persistido.');
    }
    this.logger.success(
      `✅ ${report.created} usuário(s) ${this.dryRun ? 'seriam criados' : 'criados'}.`,
    );
    if (report.skippedDuplicate > 0) {
      this.logger.warning(`⚠️  ${report.skippedDuplicate} pulado(s) (e-mail já existente).`);
    }
    if (report.errors.length > 0) {
      this.logger.logError(`❌ ${report.errors.length} erro(s):`);
      for (const e of report.errors) {
        this.logger.logError(`   linha ${e.line}: ${e.reason}`);
      }
      this.exitCode = 1;
    }
  }
}
