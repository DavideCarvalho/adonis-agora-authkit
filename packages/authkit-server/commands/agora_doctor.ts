// agora-doctor command v1 — keep identical across libs
import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { executeAgoraDoctor } from '../src/doctor/agora_doctor.js';

export default class AgoraDoctor extends BaseCommand {
  static commandName = 'agora:doctor';
  static description =
    'Check the configuration of every installed @adonis-agora lib (exit 1 on errors, 2 if the doctor cannot run)';

  static help = [
    'Runs the health checks every installed @adonis-agora lib registered.',
    '',
    '  node ace agora:doctor                 human output',
    '  node ace agora:doctor --json --strict CI: one JSON object, fail on warnings too',
    '  node ace agora:doctor --deep          also checks that touch the database, Redis or network',
    '  node ace agora:doctor --no-boot       config and providers register() only, for a broken boot',
  ];

  // The doctor boots the app itself, so `--no-boot` can stop before providers' boot().
  static options: CommandOptions = { startApp: false };

  @flags.boolean({ description: 'Print one JSON object to stdout' })
  declare json: boolean;

  @flags.boolean({ description: 'Also run deep checks (database, Redis, network)' })
  declare deep: boolean;

  @flags.string({ description: 'Only these libs, comma separated (durable,payments)' })
  declare lib?: string;

  @flags.string({ description: 'Run one check by id (durable.verify-tenant)' })
  declare only?: string;

  @flags.boolean({ description: 'Exit 1 on warnings too' })
  declare strict: boolean;

  @flags.boolean({ description: 'Show skipped checks and every message' })
  declare verbose: boolean;

  @flags.boolean({
    description: 'Boot the app (default). --no-boot loads config and runs register() only',
    default: true,
    showNegatedVariantInHelp: true,
  })
  declare boot: boolean;

  async run() {
    const colors = this.colors;
    const tty = process.stdout.isTTY === true && !process.env.NO_COLOR;
    this.exitCode = await executeAgoraDoctor(
      this.app,
      {
        json: this.json,
        deep: this.deep,
        lib: this.lib,
        only: this.only,
        strict: this.strict,
        verbose: this.verbose,
        boot: this.boot,
      },
      {
        out: (line) => this.logger.log(line),
        err: (line) => this.logger.logError(line),
        symbols: process.stdout.isTTY === true,
        palette: tty
          ? {
              green: (t) => colors.green(t),
              yellow: (t) => colors.yellow(t),
              red: (t) => colors.red(t),
              dim: (t) => colors.dim(t),
              bold: (t) => colors.bold(t),
            }
          : undefined,
      },
    );
  }
}
