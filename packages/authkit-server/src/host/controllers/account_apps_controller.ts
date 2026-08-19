import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { accountPath } from '../account_paths.js';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { AdminSessionsService } from '../admin_sessions_service.js';

/**
 * Self-service de consentimento ("apps com acesso") no console de conta. Lista os
 * Grants da própria conta agrupados por client (resolvendo o nome do client da
 * config estática ou do payload do adapter) e permite revogar o acesso de um
 * client (destrói os grants + AT/RT daquele client). Degrada graciosamente quando
 * o adapter OIDC não enumera (`list`), espelhando o console admin.
 */
export default class AccountAppsController {
  /** GET /account/apps — lista os apps com acesso (grants) da conta logada. */
  async index(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const render = cfg.render!;

    const accountId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    const sessions = new AdminSessionsService(service);
    const supported = sessions.canList;
    const grantList = supported ? await sessions.listGrants(accountId) : [];

    // Resolve o nome amigável do client: clientId é o fallback (config estática não
    // carrega um display name).
    const nameOf = (clientId?: string): string => clientId ?? '';

    const revoked = ctx.session.flashMessages.get('appRevoked') as string | undefined;

    return render(ctx, 'account/apps', {
      csrfToken: ctx.request.csrfToken,
      supported,
      revoked: revoked ?? null,
      apps: grantList
        .filter((g) => !!g.clientId)
        .map((g) => ({
          clientId: g.clientId as string,
          name: nameOf(g.clientId),
          accessTokens: g.accessTokens,
          refreshTokens: g.refreshTokens,
        })),
    });
  }

  /** POST /account/apps/:clientId/revoke — revoga o acesso de um client. */
  async revoke(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const accountId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const clientId = ctx.request.param('clientId');

    const sessions = new AdminSessionsService(service);
    const result = await sessions.revokeClientGrants(accountId, clientId);

    await cfg.audit?.record({
      type: 'grant.revoked_by_user',
      accountId,
      clientId,
      ip: ctx.request.ip?.() ?? null,
      metadata: {
        grants: result.grants,
        accessTokens: result.accessTokens,
        refreshTokens: result.refreshTokens,
      },
    });

    ctx.session.flash('appRevoked', cfg.messages['account.apps.revoked'] ?? 'account.apps.revoked');
    return ctx.response.redirect(accountPath('apps'));
  }
}
