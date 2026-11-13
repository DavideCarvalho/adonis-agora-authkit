import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { apiError, auditDto } from '../admin_api/dto.js';
import { listAuditPage, withListQuery } from '../list_api.js';

/**
 * Endpoints JSON do log de auditoria do console admin React.
 *
 * GET {prefix}/api/audit?filter[type]=&filter[subject]=&after=&before=&first=&last=
 *   → `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`, newest first
 *
 * 404 honesto (`capability_unsupported`) quando o sink não suporta consulta.
 */
export default class ConsoleAuditController {
  async index(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const sink = cfg.audit;
    if (!sink || typeof sink.list !== 'function') {
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O sink de auditoria configurado não suporta consulta.'),
      );
    }

    return withListQuery(ctx, async () => {
      const page = await listAuditPage(sink, ctx.request.qs());
      return { ...page, data: page.data.map(auditDto) };
    });
  }
}
