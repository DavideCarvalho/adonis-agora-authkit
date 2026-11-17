import type { ApplicationService } from '@adonisjs/core/types';

/**
 * A {@link ApplicationService} BOOTADA, capturada por `AuthkitServerProvider.register()` — que o app
 * instancia com a SUA própria cópia bootada do app.
 *
 * Por que capturar aqui em vez de `import app from '@adonisjs/core/services/app'`: num install pnpm
 * (workspace / hoisted), este pacote pode resolver uma cópia FÍSICA de `@adonisjs/core` DIFERENTE da
 * que o `bin/server` bootou. `services/app` expõe o app por um binding de nível de módulo definido no
 * boot (`setApp`); numa cópia NÃO-bootada esse binding fica `undefined` — importar de lá devolve um
 * app indefinido (`Cannot read properties of undefined (reading 'booted')`). A instância que o
 * provider recebe é SEMPRE a bootada, então lê-la aqui é imune a splits de cópia / variantes de peer
 * do core — o mesmo hazard de dual-package que já corrigimos no `'lucid.db'`.
 */
let bootedApp: ApplicationService | undefined;

/** Registra o app bootado. Chamado uma vez pelo {@link AuthkitServerProvider} no `register()`. */
export function setBootedApp(app: ApplicationService): void {
  bootedApp = app;
}

/** O app bootado, ou `undefined` quando o provider não registrou (scripts, testes sem app). */
export function tryGetBootedApp(): ApplicationService | undefined {
  return bootedApp;
}

/**
 * O app bootado capturado pelo provider. Lança se lido antes do provider registrar — um sinal claro
 * de que `@adonis-agora/authkit-server/authkit_server_provider` está ausente dos providers do app.
 */
export function getBootedApp(): ApplicationService {
  if (!bootedApp) {
    throw new Error(
      '@adonis-agora/authkit-server: app acessado antes de AuthkitServerProvider registrar. Adicione "@adonis-agora/authkit-server/authkit_server_provider" aos providers do adonisrc.ts.',
    );
  }
  return bootedApp;
}
