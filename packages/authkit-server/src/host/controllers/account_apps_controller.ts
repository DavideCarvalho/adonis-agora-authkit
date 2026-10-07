import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { displayNameFor } from '../../agents/agent_identity.js';
import { personalAgentsFor } from '../../agents/runtime.js';
import { accountPath } from '../account_paths.js';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { AdminSessionsService } from '../admin_sessions_service.js';
import { clientDisplayNames } from '../client_names.js';

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

    // O nome que o client registrou; sem ele, o clientId.
    const names = await clientDisplayNames(
      service,
      grantList.map((g) => g.clientId).filter((id): id is string => !!id),
    );
    const nameOf = (clientId?: string): string =>
      clientId ? (names.get(clientId) ?? clientId) : '';

    const revoked = ctx.session.flashMessages.get('appRevoked') as string | undefined;

    // Personal agents com delegação ativa (só quando a feature está ligada).
    const agentsRuntime = await personalAgentsFor(ctx);
    const agents = agentsRuntime?.delegation
      ? await Promise.all(
          (await agentsRuntime.delegation.listGrants(accountId)).map(async (g) => ({
            id: g.id,
            name: displayNameFor(
              (await agentsRuntime.config.resolveAgent(g.clientId)) ?? {
                issuer: g.clientId,
                jwksUri: '',
              },
            ),
            scopes: g.scopes,
          })),
        )
      : null;

    return render(ctx, 'account/apps', {
      csrfToken: ctx.request.csrfToken,
      supported,
      agents,
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

  /** POST /account/apps/agents/:grantId/revoke — revoga a delegação de um personal agent. */
  async revokeAgent(ctx: HttpContext) {
    const runtime = await personalAgentsFor(ctx);
    if (!runtime?.delegation) return ctx.response.notFound();
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const accountId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;
    const grantId = ctx.request.param('grantId');
    if (await runtime.delegation.revokeGrant(accountId, grantId)) {
      await cfg.audit?.record({
        type: 'agent.grant_revoked',
        accountId,
        ip: ctx.request.ip?.() ?? null,
        metadata: { grantId },
      });
    }
    ctx.session.flash('appRevoked', cfg.messages['account.apps.revoked'] ?? 'account.apps.revoked');
    return ctx.response.redirect(accountPath('apps'));
  }
}
