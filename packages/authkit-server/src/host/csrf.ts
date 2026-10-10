/**
 * Helper de exceções de CSRF para as rotas machine-to-machine do AuthKit.
 *
 * Os endpoints do IdP (token/introspection/PAT) e o back-channel logout são
 * server-to-server (sem browser/token XSRF). Em vez de cada app reescrever a
 * checagem de URL no `config/shield.ts`, use este helper:
 *
 * ```ts
 * // config/shield.ts
 * import { authkitCsrfExceptions } from '@adonis-agora/authkit-server'
 * csrf: {
 *   enabled: true,
 *   exceptRoutes: (ctx) => authkitCsrfExceptions(ctx.request.url(), { mountPath: '/oidc' })
 *     || ctx.request.url().includes('/api'),
 * }
 * ```
 */
import { normalizePersonalAgentsPrefix } from '../agents/config.js';
import { normalizePoppyPrefix } from '../agents/poppy/config.js';
import { getAuthHostConfig } from './auth_host_config.js';

export interface AuthkitCsrfOptions {
  /** mountPath do IdP (mesmo de defineConfig/registerAuthHost). Default: `/oidc`. */
  mountPath?: string;
  /** Inclui a rota de back-channel logout do CLIENT (default: `/auth/backchannel-logout`). */
  backchannelLogoutPath?: string | false;
  /**
   * Prefixo de `personalAgents`: isenta os endpoints OAuth que os agentes chamam
   * (`{prefix}/oauth/*`). Default: o prefixo do config quando `personalAgents`
   * está ligado; nada quando não está. `false` desliga. A tela de
   * consentimento (`{prefix}/consent`) continua protegida.
   */
  personalAgentsPrefix?: string | false;
  /**
   * Prefixo do Poppy: isenta token/revoke/device authorization, o Mediated
   * Sign-In e a sessão de navegador (POST cross-site autenticado pela asserção).
   * Default: o do config. As telas `{prefix}/oauth/authorize` e `{prefix}/device`
   * continuam protegidas. `false` desliga.
   */
  poppyPrefix?: string | false;
}

/**
 * Retorna `true` quando `url` é uma rota AuthKit que deve ser ISENTA de CSRF
 * (machine-to-machine). Cobre o mountPath do IdP, a introspecção de PAT e a
 * rota de back-channel logout do client e os endpoints OAuth de personal agents.
 */
export function authkitCsrfExceptions(url: string, options: AuthkitCsrfOptions = {}): boolean {
  const mountPath = options.mountPath ?? '/oidc';
  const backchannel =
    options.backchannelLogoutPath === false
      ? null
      : (options.backchannelLogoutPath ?? '/auth/backchannel-logout');

  const agentsPrefix =
    options.personalAgentsPrefix === false
      ? undefined
      : options.personalAgentsPrefix !== undefined
        ? normalizePersonalAgentsPrefix(options.personalAgentsPrefix)
        : getAuthHostConfig()?.personalAgents?.prefix;
  const agentsOAuth = agentsPrefix ? `${agentsPrefix}/oauth/` : null;
  const poppyPrefix =
    options.poppyPrefix === false
      ? undefined
      : options.poppyPrefix !== undefined
        ? normalizePoppyPrefix(options.poppyPrefix)
        : getAuthHostConfig()?.personalAgents?.poppyPrefix;
  const path = url.split('?')[0];
  const poppyExempt =
    !!poppyPrefix &&
    (path === `${poppyPrefix}/oauth/token` ||
      path === `${poppyPrefix}/oauth/revoke` ||
      path === `${poppyPrefix}/oauth/device` ||
      path === `${poppyPrefix}/sign-in` ||
      path.startsWith(`${poppyPrefix}/sign-in/`) ||
      path === `${poppyPrefix}/browser-session`);

  return (
    url.includes(mountPath) ||
    url.includes('/authkit/pat') ||
    (backchannel !== null && url === backchannel) ||
    (agentsOAuth !== null && url.startsWith(agentsOAuth)) ||
    poppyExempt
  );
}
