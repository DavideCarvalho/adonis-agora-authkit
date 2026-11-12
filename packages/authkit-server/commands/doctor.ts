import { BaseCommand } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { type Finding, hasErrors, runAllChecks } from '../src/doctor/checks.js';
import { buildDoctorInput, managedSigningKeyAgeFinding } from '../src/doctor/doctor_input.js';

export default class AuthkitDoctor extends BaseCommand {
  static commandName = 'authkit:doctor';
  static description =
    'Valida a configuração do AuthKit no host e imprime achados (✅/⚠️/❌). Sai com código !=0 se houver erros.';

  static help = [
    'Roda uma bateria de checagens sobre a config `authkit` do host:',
    'issuer/mountPath, clients, accountStore + capacidades, session, shield,',
    'ally (social), rate-limit, admin, webauthn e jwks.',
  ];

  static options: CommandOptions = { startApp: true };

  async run() {
    // `buildDoctorInput` resolve o config provider de `config/authkit.ts` antes de inspecionar.
    let input: Awaited<ReturnType<typeof buildDoctorInput>>;
    try {
      input = await buildDoctorInput(this.app, this.logger);
    } catch (error) {
      this.logger.logError(`❌ config/authkit.ts falhou ao resolver: ${(error as Error).message}`);
      this.exitCode = 1;
      return;
    }

    const findings = runAllChecks(input);

    // Adiciona o finding de idade da chave de assinatura managed (best-effort).
    const keyAge = await managedSigningKeyAgeFinding(this.app, input.authkitConfig);
    if (keyAge) findings.push(keyAge);

    this.print(findings);

    if (hasErrors(findings)) {
      this.exitCode = 1;
    }
  }

  private print(findings: Finding[]) {
    const icon = (l: Finding['level']) => (l === 'ok' ? '✅' : l === 'warn' ? '⚠️ ' : '❌');
    this.logger.info('AuthKit doctor — checagem da configuração do host\n');
    for (const f of findings) {
      const line = `${icon(f.level)} ${f.message}`;
      if (f.level === 'error') this.logger.logError(line);
      else if (f.level === 'warn') this.logger.warning(line);
      else this.logger.success(line);
    }

    const errors = findings.filter((f) => f.level === 'error').length;
    const warns = findings.filter((f) => f.level === 'warn').length;
    this.logger.info(`\nResumo: ${errors} erro(s), ${warns} aviso(s).`);
  }
}
