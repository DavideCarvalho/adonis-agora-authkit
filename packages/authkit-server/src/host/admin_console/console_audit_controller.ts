import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { ADMIN_LIST_HTTP_DEFAULT_SIZE, parseListPage, parseListSize } from '../../pagination.js';
import { apiError, auditDto } from '../admin_api/dto.js';

/**
 * Endpoints JSON do log de auditoria do console admin React.
 *
 * GET {prefix}/api/audit?type=&page=&size=  → `{ meta: { page, size, total }, data }`
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

    const page = parseListPage(ctx.request.input('page'));
    const size = parseListSize(ctx.request.input('size'), ADMIN_LIST_HTTP_DEFAULT_SIZE);
    const type = (ctx.request.input('type') as string | undefined)?.trim() || undefined;
    const subject = (ctx.request.input('subject') as string | undefined)?.trim() || undefined;

    const result = await sink.list({ page, size, type, subject });
    return { meta: { page, size, total: result.total }, data: result.data.map(auditDto) };
  }
}
