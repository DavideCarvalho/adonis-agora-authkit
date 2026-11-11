/**
 * SÓ TESTES: módulos internos do `@adonis-agora/authkit-server` (controllers genéricos do console de
 * conta e do admin, o app bootado). Importados pelo BUILD dele, pelo caminho relativo do
 * monorepo: o Node resolve o pacote pelo realpath, então estes são os MESMOS módulos (e o mesmo
 * estado) que o `@adonis-agora/authkit-server` carrega — não uma segunda cópia. Rode o build do
 * authkit-server antes.
 */

export { setBootedApp } from '../../authkit-server/build/services/booted_app.js';
export { default as ConsolePersonalAgentsController } from '../../authkit-server/build/src/host/admin_console/console_personal_agents_controller.js';
export {
  resetAuthHostConfig,
  setAuthHostConfig,
} from '../../authkit-server/build/src/host/auth_host_config.js';
export { default as AccountAppsController } from '../../authkit-server/build/src/host/controllers/account_apps_controller.js';
export {
  SUDO_ACCOUNT_SESSION_KEY,
  SUDO_SESSION_KEY,
} from '../../authkit-server/build/src/host/sudo_mode.js';
