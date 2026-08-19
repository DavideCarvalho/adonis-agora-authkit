import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { apiError, grantDto, sessionDto } from '../admin_api/dto.js';
import { AdminSessionsService } from '../admin_sessions_service.js';
import { sessionAccountValidator } from '../admin_validators.js';
import { enrichSessionsWithContext } from '../session_context.js';

/**
 * Endpoints JSON de sessões/grants do console admin React.
 *
 * GET    {prefix}/api/sessions?accountId=      → lista sessões + grants de uma conta (ou global)
 * POST   {prefix}/api/sessions/revoke-all      → revoga todas as sessões de ?accountId=
 * GET    {prefix}/api/users/:id/sessions       → lista sessões + grants de um usuário específico
 * POST   {prefix}/api/users/:id/revoke-sessions → revoga todas as sessões de um usuário específico
 */
export default class ConsoleSessionsController {
  /**
   * Helper privado: lista sessões + grants de uma conta específica.
   * Retorna o shape UserSessionsResult: { supported, truncated, sessions, grants }.
   */
  private async listForAccount(ctx: HttpContext, accountId: string) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const adminSvc = new AdminSessionsService(service);

    if (!adminSvc.canList) {
      return { supported: false, sessions: [], grants: [] };
    }

    const account = await cfg.accountStore.findById(accountId);
    if (!account) return ctx.response.notFound(apiError('not_found', 'Usuário não encontrado.'));

    const rawSessions = await adminSvc.listSessions(accountId);
    const enriched = await enrichSessionsWithContext(cfg, accountId, rawSessions);
    const grants = await adminSvc.listGrants(accountId);

    return {
      supported: true,
      truncated: false,
      sessions: enriched.map(sessionDto),
      grants: grants.map(grantDto),
    };
  }

  /** GET {prefix}/api/sessions?accountId= */
  async index(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const accountId = (ctx.request.input('accountId', '') as string).trim();
    const adminSvc = new AdminSessionsService(service);

    if (!adminSvc.canList) {
      return { supported: false, sessions: [], grants: [] };
    }

    // Sem accountId → listagem global de todas as sessões ativas
    if (!accountId) {
      const { sessions: rawSessions, truncated } = await adminSvc.listAllSessions();
      return {
        supported: true,
        truncated,
        sessions: rawSessions.map(sessionDto),
        grants: [],
      };
    }

    // Com accountId → delega ao helper por-conta
    return this.listForAccount(ctx, accountId);
  }

  /** GET {prefix}/api/users/:id/sessions */
  async userSessions(ctx: HttpContext) {
    const accountId = (ctx.params.id as string).trim();
    if (!accountId) {
      return ctx.response.badRequest(apiError('invalid_request', 'O parâmetro id é obrigatório.'));
    }
    return this.listForAccount(ctx, accountId);
  }

  /** POST {prefix}/api/users/:id/revoke-sessions */
  async userRevokeSessions(ctx: HttpContext) {
    const accountId = (ctx.params.id as string).trim();
    if (!accountId) {
      return ctx.response.badRequest(apiError('invalid_request', 'O parâmetro id é obrigatório.'));
    }
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const actorId = (ctx.session?.get(ACCOUNT_SESSION_KEY) as string) ?? null;
    const ip = ctx.request.ip?.() ?? null;

    const sessions = new AdminSessionsService(service);
    const result = await sessions.revokeAll(accountId);

    await cfg.audit?.record({
      type: 'session.revoked_all',
      accountId,
      actorId,
      ip,
      metadata: {
        sessions: result.sessions,
        grants: result.grants,
        accessTokens: result.accessTokens,
        refreshTokens: result.refreshTokens,
        source: 'admin-console',
      },
    });

    return { ok: true, ...result };
  }

  /** POST {prefix}/api/sessions/revoke-all?accountId= */
  async revokeAll(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const actorId = (ctx.session?.get(ACCOUNT_SESSION_KEY) as string) ?? null;
    const ip = ctx.request.ip?.() ?? null;

    // accountId pode vir por query/body OU route param — Vine valida o valor já
    // coalescido (validate() aceita qualquer dado, não só request.all()).
    const { accountId } = await sessionAccountValidator.validate({
      accountId:
        (ctx.request.input('accountId') as string | undefined) ??
        (ctx.request.param('accountId') as string | undefined),
    });

    const sessions = new AdminSessionsService(service);
    const result = await sessions.revokeAll(accountId);

    await cfg.audit?.record({
      type: 'session.revoked_all',
      accountId,
      actorId,
      ip,
      metadata: {
        sessions: result.sessions,
        grants: result.grants,
        accessTokens: result.accessTokens,
        refreshTokens: result.refreshTokens,
        source: 'admin-console',
      },
    });

    return { ok: true, ...result };
  }
}
