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
 *     || ctx.request.url().startsWith('/api/'),
 * }
 * ```
 */
import { normalizePersonalAgentsPrefix } from '../agents/config.js';
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
   * Isenta os `csrfExemptPaths` das `personalAgents.extensions` do config. Default: true.
   * `false` desliga.
   */
  personalAgentExtensions?: boolean;
}

/** `path` é `prefix` ou fica debaixo dele (`prefix/...`) — nunca um substring solto. */
function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** O pathname de `url`: sem query/hash, aceitando também uma URL absoluta. */
function pathnameOf(url: string): string {
  let path = url;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      // Segue com a string crua: o match ancorado abaixo simplesmente não casa.
    }
  }
  return path.split(/[?#]/, 1)[0] ?? '';
}

/**
 * Retorna `true` quando `url` é uma rota AuthKit que deve ser ISENTA de CSRF
 * (machine-to-machine). Cobre o mountPath do IdP, a introspecção de PAT e a
 * rota de back-channel logout do client e os endpoints OAuth de personal agents.
 *
 * O match é ANCORADO no pathname: `/oidc` e `/oidc/...` casam, mas `/foo/oidc/x`,
 * `/oidc-admin` ou `/x?next=/oidc` não. A query string é ignorada.
 */
export function authkitCsrfExceptions(url: string, options: AuthkitCsrfOptions = {}): boolean {
  const mountPath = (options.mountPath ?? '/oidc').replace(/\/+$/, '');
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
  const path = pathnameOf(url);
  const extensionExempt =
    options.personalAgentExtensions !== false &&
    (getAuthHostConfig()?.personalAgents?.extensions ?? []).some((e) =>
      e.csrfExemptPaths?.includes(path),
    );

  return (
    (mountPath !== '' && underPrefix(path, mountPath)) ||
    underPrefix(path, '/authkit/pat') ||
    (backchannel !== null && path === backchannel) ||
    (agentsOAuth !== null && path.startsWith(agentsOAuth)) ||
    extensionExempt
  );
}
