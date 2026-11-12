// agora-doctor command v1 — keep identical across libs
// Every @adonis-agora lib ships this command; whichever copy Ace loads last wins, and they all
// behave the same. Change it in @adonis-agora/durable first.

import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import {
  AgoraDoctorUsageError,
  discoverDoctorChecks,
  readDoctorChecks,
  renderAgoraDoctor,
  runAgoraDoctor,
} from '../src/doctor/agora_doctor.js';

/**
 * `node ace agora:doctor`: one health check for every installed `@adonis-agora` lib. Exit code `0`
 * when nothing is an error (`--strict`: nor a warning), `1` otherwise, `2` when the doctor itself
 * cannot run.
 */
export default class AgoraDoctor extends BaseCommand {
  static override commandName = 'agora:doctor';
  static override description = 'Check the configuration of every installed @adonis-agora lib';
  // The app is booted by `run()` itself, so `--no-boot` can skip it.
  static override options: CommandOptions = { startApp: false };

  /** A `<lib>:doctor` alias sets this to pre-filter its lib. */
  protected presetLib: string | undefined = undefined;

  @flags.boolean({ description: 'Print one JSON object to stdout' })
  declare json: boolean;

  @flags.string({ description: 'Only these libs, comma separated (durable,payments)' })
  declare lib?: string;

  @flags.boolean({ description: 'Also run checks that touch the database, Redis or the network' })
  declare deep: boolean;

  @flags.string({ description: 'Run one check by id' })
  declare only?: string;

  @flags.boolean({ description: 'Fail (exit 1) on warnings too' })
  declare strict: boolean;

  @flags.boolean({ description: 'Show skipped checks and every message' })
  declare verbose: boolean;

  @flags.boolean({
    description: 'Boot the app first; --no-boot checks the config only (when boot itself fails)',
    default: true,
    showNegatedVariantInHelp: true,
  })
  declare boot: boolean;

  override async run(): Promise<void> {
    const err = (line: string) => process.stderr.write(`${line}\n`);
    try {
      let checks: Awaited<ReturnType<typeof readDoctorChecks>>;
      if (this.boot === false) {
        checks = (await discoverDoctorChecks(this.app)).filter((check) => check.cost !== 'deep');
      } else {
        if (!this.app.isReady) {
          await this.app.boot();
          await this.app.start(() => {});
        }
        checks = await readDoctorChecks(this.app.container);
      }
      const libs = (this.lib ?? this.presetLib)
        ?.split(',')
        .map((name) => name.trim())
        .filter(Boolean);
      const { report, exitCode } = await runAgoraDoctor(this.app, checks, {
        ...(libs ? { libs } : {}),
        ...(this.only ? { only: this.only } : {}),
        deep: this.deep === true && this.boot !== false,
        strict: this.strict === true,
      });
      if (this.json) {
        process.stdout.write(`${JSON.stringify(report)}\n`);
      } else {
        const fancy = process.stdout.isTTY === true && !process.env.NO_COLOR;
        const c = this.colors;
        process.stdout.write(
          renderAgoraDoctor(report, {
            verbose: this.verbose === true,
            fancy,
            paint: {
              green: (t) => c.green(t),
              yellow: (t) => c.yellow(t),
              red: (t) => c.red(t),
              dim: (t) => c.dim(t),
              bold: (t) => c.bold(t),
            },
          }),
        );
      }
      this.exitCode = exitCode;
    } catch (error) {
      if (!(error instanceof AgoraDoctorUsageError)) throw error;
      err(`agora:doctor: ${error.message}`);
      this.exitCode = 2;
    }
  }
}
