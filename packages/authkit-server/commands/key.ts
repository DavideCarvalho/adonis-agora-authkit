import { args, BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { cliActor } from './client.js';

const ACTIONS = ['list', 'generate', 'rotate', 'retire'] as const;
type Action = (typeof ACTIONS)[number];
const ALGS = ['RS256', 'PS256', 'ES256', 'EdDSA'];

/**
 * Chaves de assinatura (JWKS) pela linha de comando — o mesmo serviço do console admin
 * ("rotacionar agora") e do agendador de rotação. Só com `jwks: { source: 'managed', store }`:
 * sem `store` a chave é efêmera (uma por boot) e com `source: 'jwks'` as chaves vêm de fora.
 */
export default class AuthkitKey extends BaseCommand {
  static commandName = 'authkit:key';
  static description = 'Manage the JWKS signing keys: list, generate, rotate, retire.';

  static help = [
    'Actions:',
    '  list           every key: kid, alg, status (active / verification / staged), created',
    '  generate       a new key, published in the JWKS but not signing yet (staged);',
    '                 the next `rotate` makes it the active key',
    '  rotate         a new active key (the staged one, if any); the previous ones stay',
    '                 published for verification (--keep, default 2) until their tokens expire',
    '  retire <kid>   remove a key that no longer signs: tokens signed by it stop validating',
    '',
    'Needs `jwks: { source: "managed", store: … }` in config/authkit.ts (file, lucid, redis or a',
    'vault). Other processes pick the new keys up through the keystore reload poll.',
    '',
    'Examples:',
    '  node ace authkit:key list --json',
    '  node ace authkit:key generate --alg=ES256',
    '  node ace authkit:key rotate --dry-run',
    '  node ace authkit:key rotate --keep=3',
    '  node ace authkit:key retire 0b5c… --force',
  ];

  static options: CommandOptions = { startApp: true };

  @args.string({ description: `Action: ${ACTIONS.join(', ')}` })
  declare action: string;

  @args.string({ description: 'Key id (retire)', required: false })
  declare kid?: string;

  @flags.string({
    description: `generate: algorithm (${ALGS.join(', ')}). Default: the configured one.`,
  })
  declare alg?: string;

  @flags.number({ description: 'rotate: how many keys stay published (default 2).' })
  declare keep?: number;

  @flags.boolean({ description: 'rotate: drop every old key right away (no grace period).' })
  declare retireOld?: boolean;

  @flags.boolean({ description: 'rotate: show the plan without changing the keystore.' })
  declare dryRun?: boolean;

  @flags.boolean({ description: 'Do not ask for confirmation.' })
  declare force?: boolean;

  @flags.boolean({ description: 'Machine-readable output.' })
  declare json?: boolean;

  #fail(message: string) {
    this.logger.logError(message);
    this.exitCode = 1;
  }

  #print(value: unknown) {
    this.logger.info(JSON.stringify(value, null, 2));
  }

  async #confirm(question: string): Promise<boolean> {
    if (this.force) return true;
    try {
      return await this.prompt.confirm(question);
    } catch {
      return false;
    }
  }

  async run() {
    const action = this.action as Action;
    if (!ACTIONS.includes(action)) {
      return this.#fail(`Unknown action "${this.action}". Use one of: ${ACTIONS.join(', ')}.`);
    }
    const service = await this.app.container.make('authkit.server');
    if (action === 'list') return this.#list(service);

    if (!service.hasManagedKeystore) {
      const source = (service.config as any).jwksConfig?.source;
      return this.#fail(
        source === 'managed'
          ? 'jwks is managed WITHOUT a `store`: the key is ephemeral (a new one each boot), so there is nothing to change. Set `jwks.store` to persist and rotate keys.'
          : 'jwks keys come from config (`source: "jwks"`): rotate them where they are defined.',
      );
    }
    switch (action) {
      case 'generate':
        return this.#generate(service);
      case 'rotate':
        return this.#rotate(service);
      case 'retire':
        return this.#retire(service);
    }
  }

  async #list(service: any) {
    const managed = service.hasManagedKeystore;
    const keys = managed
      ? await service.listManagedKeys()
      : service.publicJwks.keys.map((k: any, i: number) => ({
          kid: k.kid ?? null,
          alg: k.alg ?? null,
          status: i === 0 ? 'active' : 'verification',
          createdAt: null,
          ageDays: null,
        }));
    const source = managed
      ? 'managed (persisted store)'
      : (service.config as any).jwksConfig?.source === 'managed'
        ? 'managed (ephemeral: a new key each boot)'
        : 'static (config)';
    if (this.json) {
      return this.#print({
        source,
        keys: keys.map((k: any) => ({
          kid: k.kid,
          alg: k.alg,
          status: k.status,
          createdAt: k.createdAt,
          ageDays: k.ageDays,
        })),
      });
    }
    this.logger.info(`Keystore: ${source}`);
    const table = this.ui.table();
    table.head(['kid', 'alg', 'status', 'created']);
    for (const k of keys) table.row([k.kid ?? '', k.alg ?? '', k.status, k.createdAt ?? '']);
    table.render();
  }

  async #generate(service: any) {
    if (this.alg && !ALGS.includes(this.alg)) {
      return this.#fail(`--alg must be one of ${ALGS.join(', ')}.`);
    }
    const { kid } = await service.generateKey(this.alg, { actorId: cliActor() });
    if (this.json) return this.#print({ kid, status: 'staged' });
    this.logger.success(
      `Key generated: kid=${kid} (staged: published, signs after the next rotate).`,
    );
  }

  async #rotate(service: any) {
    const keep = this.keep ?? 2;
    if (!Number.isInteger(keep) || keep < 1) return this.#fail('--keep must be an integer >= 1.');
    const retire = this.retireOld === true;
    if (this.dryRun) {
      const plan = await service.planKeyRotation(keep, retire);
      if (this.json) return this.#print({ dryRun: true, ...plan });
      this.logger.info('Rotation plan (dry-run — nothing changed):');
      this.logger.info(`  current signing key: ${plan.currentKid ?? '(none)'}`);
      this.logger.info(`  kept: ${plan.keptKids.join(', ')}`);
      this.logger.info(`  retired: ${plan.retiredKids.join(', ') || 'none'}`);
      return;
    }
    if (retire && !(await this.#confirm('Drop every old key now? Their tokens stop validating.'))) {
      return this.#fail('Cancelled (pass --force to skip the confirmation).');
    }
    const result = await service.rotateKeys(keep, retire, { actorId: cliActor() });
    if (this.json) return this.#print({ rotated: true, ...result });
    this.logger.success(`New signing key: kid=${result.newKid}.`);
    this.logger.info(`  published: ${result.keptKids.join(', ')}`);
    if (result.retiredKids.length) {
      this.logger.warning(
        `  retired (their tokens stop validating): ${result.retiredKids.join(', ')}`,
      );
    }
  }

  async #retire(service: any) {
    if (!this.kid) return this.#fail('authkit:key retire needs a kid.');
    if (!(await this.#confirm(`Retire key ${this.kid}? Tokens signed by it stop validating.`))) {
      return this.#fail('Cancelled (pass --force to skip the confirmation).');
    }
    try {
      const result = await service.retireKey(this.kid, { actorId: cliActor() });
      if (this.json) return this.#print(result);
      this.logger.success(`Key retired: ${this.kid}. Published: ${result.keptKids.join(', ')}`);
    } catch (error) {
      this.#fail((error as Error).message);
    }
  }
}
