import { args, BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { appCatalogStoreOf, presentCatalog } from '../src/service_tenants/app_catalog.js';

/**
 * What each Agora app accepts from the other apps: the catalogs the apps publish at boot
 * (`@adonis-agora/authkit-client`). The same list the console's "Apps it can call" offers and
 * `GET /apps/catalog` returns. Grant with `authkit:client grant-app`.
 */
export default class AuthkitApps extends BaseCommand {
  static commandName = 'authkit:apps';
  static description = 'List the apps and the capabilities each one accepts from the other apps.';

  static help = [
    'Every app that published its catalog, with the capabilities it accepts.',
    'Grant one to a service tenant with `authkit:client grant-app <client> --app=<app> --capability=<cap>`.',
    '',
    'Examples:',
    '  node ace authkit:apps',
    '  node ace authkit:apps entre-textos',
    '  node ace authkit:apps --json',
  ];

  static options: CommandOptions = { startApp: true };

  @args.string({ argumentName: 'app', description: 'Only this app', required: false })
  declare only?: string;

  @flags.boolean({ description: 'Machine-readable JSON output.' })
  declare json?: boolean;

  async run() {
    const service = (await this.app.container.make('authkit.server' as any)) as any;
    const store = await appCatalogStoreOf(service, () =>
      this.app.container.make('lucid.db' as any),
    );
    if (!store) {
      this.logger.error('No database (lucid.db): the app catalog lives in auth_app_catalog.');
      this.exitCode = 1;
      return;
    }
    const all = await store.list();
    const entries = this.only ? all.filter((e) => e.app === this.only) : all;
    if (this.json) {
      this.logger.log(
        JSON.stringify(
          entries.map((e) => presentCatalog(e)),
          null,
          2,
        ),
      );
      return;
    }
    if (entries.length === 0) {
      this.logger.info(
        this.only
          ? `${this.only} has not published a catalog.`
          : 'No app has published a catalog yet.',
      );
      return;
    }
    for (const entry of entries) {
      this.logger.log(
        `${this.colors.bold(entry.app)}  ${this.colors.dim(`(${entry.updatedAt?.toISOString() ?? 'unknown'})`)}`,
      );
      for (const cap of entry.capabilities) this.logger.log(`  ${cap}`);
      if (entry.capabilities.length === 0) this.logger.log(this.colors.dim('  (none)'));
    }
  }
}
