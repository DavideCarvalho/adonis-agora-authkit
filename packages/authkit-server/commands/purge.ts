import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { cliActor } from './client.js';

/**
 * Limpa o que o IdP acumula — seguro para rodar num cron: nada vivo é apagado.
 */
export default class AuthkitPurge extends BaseCommand {
  static commandName = 'authkit:purge';
  static description =
    'Delete expired/consumed tokens, grants, sessions and interactions, and unused dynamically registered clients.';

  static help = [
    'Removes what can no longer be used:',
    '  --tokens         expired and consumed access/refresh tokens, codes, device codes…',
    '  --grants         expired grants',
    '  --sessions       expired sessions',
    '  --interactions   expired login interactions',
    '  --clients        clients registered through /reg (e.g. MCP clients) longer ago than',
    '                   --older-than (default 30d) that have no live grant',
    'Without a kind flag, every kind is purged. Expired rows only need deleting on a database',
    'adapter (Redis expires them by itself). Safe to cron:',
    '',
    '  node ace authkit:purge --dry-run',
    '  node ace authkit:purge --clients --older-than=60d',
    '  node ace authkit:purge --json',
  ];

  static options: CommandOptions = { startApp: true };

  @flags.boolean({ description: 'Expired and consumed tokens and codes.' })
  declare tokens?: boolean;

  @flags.boolean({ description: 'Expired grants.' })
  declare grants?: boolean;

  @flags.boolean({ description: 'Expired sessions.' })
  declare sessions?: boolean;

  @flags.boolean({ description: 'Expired interactions.' })
  declare interactions?: boolean;

  @flags.boolean({ description: 'Unused dynamically registered clients (see --older-than).' })
  declare clients?: boolean;

  @flags.string({
    description: 'Clients registered longer ago than this (30d, 12h, 2w). Default 30d.',
  })
  declare olderThan?: string;

  @flags.boolean({ description: 'Count only; delete nothing.' })
  declare dryRun?: boolean;

  @flags.boolean({ description: 'Machine-readable output.' })
  declare json?: boolean;

  async run() {
    const { PurgeService, parseOlderThan } = await import('../src/host/purge_service.js');
    const olderThanDays = this.olderThan === undefined ? 30 : parseOlderThan(this.olderThan);
    if (olderThanDays === null) {
      this.logger.logError(`Invalid --older-than "${this.olderThan}" (use e.g. 30d, 12h, 2w).`);
      this.exitCode = 1;
      return;
    }
    const kinds = (['tokens', 'grants', 'sessions', 'interactions', 'clients'] as const).filter(
      (k) => this[k],
    );
    const service = await this.app.container.make('authkit.server');
    const report = await new PurgeService(service).run({
      kinds,
      olderThanDays,
      dryRun: this.dryRun,
    });
    if (!report.dryRun && report.total > 0) {
      await service.config.audit?.record({
        type: 'oidc.purged',
        actorId: cliActor(),
        ip: null,
        metadata: {
          expired: report.expired,
          consumed: report.consumed,
          clients: report.clients.length,
          olderThanDays,
        },
      });
    }
    if (this.json) {
      this.logger.info(JSON.stringify(report, null, 2));
      return;
    }
    const verb = report.dryRun ? 'Would delete' : 'Deleted';
    for (const [kind, n] of Object.entries(report.expired)) {
      this.logger.info(`  ${kind.padEnd(13)} ${n} expired`);
    }
    for (const [kind, n] of Object.entries(report.consumed)) {
      this.logger.info(`  ${kind.padEnd(13)} ${n} consumed`);
    }
    if (kinds.length === 0 || kinds.includes('clients')) {
      this.logger.info(
        `  ${'clients'.padEnd(13)} ${report.clients.length} unused (> ${olderThanDays}d)`,
      );
    }
    this.logger.success(`${verb} ${report.total} item(s)${report.dryRun ? ' (dry-run)' : ''}.`);
  }
}
