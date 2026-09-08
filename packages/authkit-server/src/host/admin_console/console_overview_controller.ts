import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { LIST_FIRST_PAGE } from '../../pagination.js';
import { AdminSessionsService } from '../admin_sessions_service.js';
import { computeAdminStats } from '../admin_stats_service.js';

/**
 * GET {prefix}/api/overview
 *
 * Métricas-resumo do IdP para o dashboard do console React. Reutiliza
 * `computeAdminStats` (mesma fonte do console Edge) e adiciona:
 * - `clientsCount`   — número de clients na config
 * - `auditTotal`     — total de eventos de auditoria (0 quando sink não suporta)
 * - `recentEvents`   — últimos 5 eventos de auditoria ([] quando não suporta)
 */
export default class ConsoleOverviewController {
  async handle(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const sessions = new AdminSessionsService(service);
    const stats = await computeAdminStats(cfg, sessions);
    const clientsCount = cfg.clients.length;

    const recentResult =
      typeof cfg.audit?.list === 'function'
        ? await cfg.audit.list({ page: LIST_FIRST_PAGE, size: 5 })
        : null;

    return {
      usersTotal: stats.totalUsers,
      activeSessions: stats.activeSessions,
      mau: stats.mau,
      signInsTotal: stats.signInsTotal,
      signUpsTotal: stats.signUpsTotal,
      signInsPerDay: stats.signInsPerDay,
      signUpsPerDay: stats.signUpsPerDay,
      windowDays: stats.windowDays,
      auditSupported: stats.auditSupported,
      clientsCount,
      auditTotal: recentResult?.total ?? 0,
      recentEvents: (recentResult?.data ?? []).map((e: any) => ({
        id: e.id,
        type: e.type,
        accountId: e.accountId ?? null,
        email: e.email ?? null,
        actorId: e.actorId ?? null,
        ip: e.ip ?? null,
        createdAt: e.createdAt instanceof Date ? e.createdAt.toISOString() : (e.createdAt ?? null),
      })),
    };
  }
}
