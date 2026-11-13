import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { AdminSessionsService } from '../admin_sessions_service.js';
import { computeAdminStats } from '../admin_stats_service.js';
import { tokenVerifyValidator } from '../admin_validators.js';
import { listAuditPage, withListQuery } from '../list_api.js';
import { apiError, auditDto } from './dto.js';
import { TokenVerifyService } from './token_verify_service.js';

/**
 * Endpoints utilitários da Admin REST API: log de auditoria (`GET /audit`) e
 * introspecção genérica de token (`POST /tokens/verify`).
 */
export default class ApiMiscController {
  /**
   * GET /audit — newest first, `?filter[type]=&filter[subject]=&after=&before=&first=&last=` →
   * `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }` (501 JSON when the sink
   * cannot be queried).
   */
  async audit(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const sink = cfg.audit;
    if (!sink || typeof sink.list !== 'function') {
      return ctx.response
        .status(501)
        .send(apiError('not_implemented', 'O sink de auditoria configurado não suporta consulta.'));
    }
    return withListQuery(ctx, async () => {
      const page = await listAuditPage(sink, ctx.request.qs());
      return { ...page, data: page.data.map(auditDto) };
    });
  }

  /** GET /stats — métricas-resumo do IdP (totais + MAU + séries de 30 dias). */
  async stats(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const sessions = new AdminSessionsService(service);
    return computeAdminStats(cfg, sessions);
  }

  /** POST /tokens/verify — { token } → resultado de introspecção (PAT ou opaque AT). */
  async verify(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const { token } = await ctx.request.validateUsing(tokenVerifyValidator);
    const verifier = new TokenVerifyService(cfg, service.provider);
    return verifier.verify(token);
  }
}
