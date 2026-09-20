import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { AccountStore } from '../src/accounts/account_store.js';
import { normalizeAccountEmails } from '../src/commands/normalize_emails.js';
import { resolveAuthkitConfig } from '../src/commands/resolve_config.js';

/**
 * Migra os endereços GRAVADOS para a forma normalizada da identidade (`trim` +
 * `toLowerCase`) — a MESMA que o cadastro grava e que o login busca.
 *
 * É PASSO OBRIGATÓRIO do upgrade para quem tem contas criadas antes da v0.69:
 * o cadastro antigo gravava o endereço mutilado (`.normalizeEmail()` do VineJS
 * removia pontos e `+tag` no gmail) e import/convite/provider social gravavam a
 * grafia crua, com maiúsculas. O login busca UMA forma só; qualquer outra grafia
 * gravada deixa a conta INALCANÇÁVEL, sem mensagem de erro (a tela é à prova de
 * enumeração).
 */
export default class AuthkitNormalizeEmails extends BaseCommand {
  static commandName = 'authkit:users:normalize-emails';
  static description =
    'Migra os e-mails gravados para a forma normalizada da identidade (trim + lowercase). Sem --apply apenas relata.';

  static help = [
    'Sem --apply o comando NÃO escreve nada: varre as contas e relata quantas mudariam,',
    'quais, e as COLISÕES (duas contas que colapsam no mesmo endereço).',
    'Com --apply grava, recusando-se a tocar em qualquer conta envolvida numa colisão —',
    'a migração nunca funde contas nem escolhe vencedor: as colididas saem listadas para',
    'decisão humana.',
    '',
    'Sai com código != 0 quando há colisões (ou erro de escrita): é a sua deixa de que',
    'a base ainda precisa de decisão humana.',
    '',
    'Exemplos:',
    '  node ace authkit:users:normalize-emails',
    '  node ace authkit:users:normalize-emails --apply',
  ];

  static options: CommandOptions = { startApp: true };

  @flags.boolean({ description: 'Grava a normalização (sem ele, apenas relata).' })
  declare apply?: boolean;

  async run() {
    const config = await this.app.container.make('config');
    // Resolve o config provider exportado por defineConfig (provider cru não tem accountStore).
    const authkitConfig = await resolveAuthkitConfig(this.app, config.get('authkit', null));
    const store = authkitConfig?.accountStore as AccountStore | undefined;
    if (!store) {
      this.logger.logError("❌ config('authkit').accountStore ausente.");
      this.exitCode = 1;
      return;
    }

    let report: Awaited<ReturnType<typeof normalizeAccountEmails>>;
    try {
      report = await normalizeAccountEmails(store, { apply: this.apply });
    } catch (error) {
      this.logger.logError(`❌ ${(error as Error).message}`);
      this.exitCode = 1;
      return;
    }

    if (!this.apply) {
      this.logger.info('🧪 Relatório — nenhum dado foi alterado (use --apply para gravar).');
    }
    this.logger.info(
      `🔎 ${report.scanned} conta(s) varrida(s); ${report.alreadyNormalized} já normalizada(s).`,
    );

    if (report.changes.length === 0) {
      this.logger.success('✅ Nenhum endereço a normalizar.');
    } else if (this.apply) {
      this.logger.success(`✅ ${report.applied} endereço(s) normalizado(s).`);
    } else {
      this.logger.warning(`⚠️  ${report.changes.length} endereço(s) seriam normalizado(s):`);
    }
    for (const change of report.changes) {
      if (change.error) continue;
      this.logger.info(`   ${change.from} → ${change.to}`);
    }

    const failures = report.changes.filter((change) => !!change.error);
    if (failures.length > 0) {
      this.logger.logError(`❌ ${failures.length} não gravada(s):`);
      for (const change of failures) {
        this.logger.logError(`   ${change.from} → ${change.to}: ${change.error}`);
      }
      this.exitCode = 1;
    }

    if (report.unusable.length > 0) {
      // Não entram em "já normalizada": o relatório não dá por boa uma linha que
      // deixou para trás.
      this.logger.warning(
        `⚠️  ${report.unusable.length} conta(s) com e-mail vazio/inutilizável — NÃO migrada(s):`,
      );
      for (const account of report.unusable) {
        this.logger.warning(`   id ${account.accountId}: ${JSON.stringify(account.email)}`);
      }
    }

    if (report.collisions.length > 0) {
      this.logger.logError(
        `❌ ${report.collisions.length} colisão(ões) — ${report.skippedByCollision} conta(s) NÃO tocada(s). Decida à mão (a migração não funde contas):`,
      );
      for (const collision of report.collisions) {
        this.logger.logError(`   ${collision.email}:`);
        for (const account of collision.accounts) {
          this.logger.logError(`     - ${account.email} (id ${account.accountId})`);
        }
      }
      this.exitCode = 1;
    }
  }
}
