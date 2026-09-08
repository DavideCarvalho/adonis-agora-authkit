import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { ADMIN_LIST_HTTP_DEFAULT_SIZE, parseListPage, parseListSize } from '../../pagination.js';
import { AdminSessionsService } from '../admin_sessions_service.js';
import { computeAdminStats } from '../admin_stats_service.js';
import { tokenVerifyValidator } from '../admin_validators.js';
import { apiError, auditDto } from './dto.js';
import { TokenVerifyService } from './token_verify_service.js';

/**
 * Endpoints utilitários da Admin REST API: log de auditoria (`GET /audit`) e
 * introspecção genérica de token (`POST /tokens/verify`).
 */
export default class ApiMiscController {
  /** GET /audit — listagem paginada (501 JSON quando o sink não consulta). */
  async audit(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const sink = cfg.audit;
    if (!sink || typeof sink.list !== 'function') {
      return ctx.response
        .status(501)
        .send(apiError('not_implemented', 'O sink de auditoria configurado não suporta consulta.'));
    }
    const page = parseListPage(ctx.request.input('page'));
    const size = parseListSize(ctx.request.input('size'), ADMIN_LIST_HTTP_DEFAULT_SIZE);
    const type = (ctx.request.input('type') as string | undefined)?.trim() || undefined;
    const subject = (ctx.request.input('subject') as string | undefined)?.trim() || undefined;

    const result = await sink.list({ page, size, type, subject });
    return { data: result.data.map(auditDto), total: result.total, page, size };
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
