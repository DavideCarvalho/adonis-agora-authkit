import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';
import { ctxAuth } from '../host/ctx_auth.js';

export interface RequireOrgMiddlewareOptions {
  /**
   * Para onde mandar quem não tem org ativa. Default: `/account/orgs` — a tela
   * de seleção que o host-kit do authkit-server já serve.
   */
  redirectTo?: string;
  /**
   * `web` (default) redireciona para {@link redirectTo}; `api` responde 403 com
   * um corpo JSON — rotas de API não têm para onde redirecionar.
   */
  mode?: 'web' | 'api';
  /**
   * Restringe às orgs listadas. Útil para rotas que só existem dentro de um
   * conjunto conhecido de tenants. Ausente → qualquer org ativa serve.
   */
  oneOf?: string[];
}

/**
 * Exige que a sessão tenha uma **organização ativa** (claim `org_id`, exposta
 * como `identity.orgId`).
 *
 * Existe porque num app multi-tenant "estar autenticado" e "estar dentro de um
 * tenant" são coisas diferentes: sem esta barreira, uma request de um usuário
 * logado mas sem org ativa chega no controller com `tenantId` indefinido, e daí
 * o escopo por tenant do `@adonis-agora/authz` cai no escopo GLOBAL — que é o
 * pior lugar para se cair por acidente. Fail-closed: sem sessão ou sem org, não
 * passa.
 *
 * Registre como named middleware e encadeie DEPOIS do de auth:
 *
 * ```ts title="start/kernel.ts"
 * export const middleware = router.named({
 *   auth: () => import('@adonis-agora/authkit-client/auth_middleware'),
 *   requireOrg: () => import('@adonis-agora/authkit-client/require_org_middleware'),
 * })
 * ```
 *
 * ```ts title="start/routes.ts"
 * router.group(() => { … }).use([middleware.auth(), middleware.requireOrg()])
 * router.group(() => { … }).use([middleware.auth(), middleware.requireOrg({ mode: 'api' })])
 * ```
 */
export default class RequireOrgMiddleware {
  async handle(ctx: HttpContext, next: NextFn, options: RequireOrgMiddlewareOptions = {}) {
    const identity = await ctxAuth(ctx).getIdentity();
    const orgId = identity?.orgId ?? null;

    const allowed = orgId !== null && (!options.oneOf || options.oneOf.includes(orgId));
    if (allowed) return next();

    if (options.mode === 'api') {
      return ctx.response.abort(
        { error: 'no_active_organization', message: 'This route requires an active organization.' },
        403,
      );
    }
    return ctx.response.redirect(options.redirectTo ?? '/account/orgs');
  }
}
