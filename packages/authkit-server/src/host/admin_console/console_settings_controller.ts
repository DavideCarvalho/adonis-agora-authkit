import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { apiError, settingDto } from '../admin_api/dto.js';
import { isSettingLocked, lockedSettingKeys, SettingLockedError } from '../config_locks.js';
import { resolveRuntimeSettings } from '../runtime_settings.js';

/** 423 Locked: setting travada via defineConfig. */
function lockedResponse(ctx: HttpContext, err: SettingLockedError) {
  return ctx.response
    .status(423)
    .send(apiError('setting_locked', err.message, { key: err.key, lockedBy: 'config' }));
}

function notSupported(ctx: HttpContext) {
  return ctx.response.notFound(
    apiError(
      'capability_unsupported',
      'Runtime settings não é suportado nesta instalação (tabela auth_settings ausente).',
    ),
  );
}

/** Extrai organizationId do query string. undefined = não foi passado (usa global null). */
function resolveOrgId(ctx: HttpContext): string | null {
  const qs = ctx.request.qs() as Record<string, string | undefined>;
  if ('organizationId' in qs) {
    const v = qs.organizationId;
    return v?.trim() ? v.trim() : null;
  }
  return null;
}

/**
 * Endpoints JSON de runtime settings do console admin React.
 *
 * GET    {prefix}/api/settings                       → lista settings globais
 * GET    {prefix}/api/settings?organizationId={id}   → lista settings da org
 * PUT    {prefix}/api/settings/:key                  → upsert de setting global
 * PUT    {prefix}/api/settings/:key?organizationId=  → upsert de setting org-scoped
 * DELETE {prefix}/api/settings/:key                  → remover setting global
 * DELETE {prefix}/api/settings/:key?organizationId=  → remover setting org-scoped
 *
 * 404 honesto (`capability_unsupported`) quando a tabela auth_settings está ausente.
 *
 * Keys org-scopáveis: `organizations_policy`, `roles_catalog`.
 */
export default class ConsoleSettingsController {
  /** GET {prefix}/api/settings */
  async index(ctx: HttpContext) {
    const svc = await resolveRuntimeSettings(ctx);
    if (!svc) return notSupported(ctx);
    const tablePresent = await svc.isTablePresent();
    if (!tablePresent) return notSupported(ctx);
    const orgId = resolveOrgId(ctx);
    const rows = await svc.listSettings(orgId);
    return { data: rows.map(settingDto), locked: lockedSettingKeys() };
  }

  /** PUT {prefix}/api/settings/:key — body: { value: any } */
  async upsert(ctx: HttpContext) {
    const key = ctx.request.param('key') as string;
    const body = ctx.request.body() as { value?: unknown };
    if (!body || !('value' in body)) {
      return ctx.response.badRequest(apiError('invalid_request', 'O campo `value` é obrigatório.'));
    }

    const svc = await resolveRuntimeSettings(ctx);
    if (!svc) return notSupported(ctx);
    const tablePresent = await svc.isTablePresent();
    if (!tablePresent) return notSupported(ctx);

    if (isSettingLocked(key)) return lockedResponse(ctx, new SettingLockedError(key));

    const orgId = resolveOrgId(ctx);

    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    try {
      await svc.setSetting(key, body.value, null, orgId);
    } catch (err) {
      if (err instanceof SettingLockedError) return lockedResponse(ctx, err);
      throw err;
    }
    await cfg.audit?.record({
      type: 'settings.updated',
      actorId: null,
      ip: ctx.request.ip?.() ?? null,
      metadata: { key, value: body.value, source: 'admin-console', organizationId: orgId },
    });

    const saved = await svc.getSetting(key, orgId);
    return settingDto({
      key,
      organizationId: orgId,
      value: saved,
      updatedAt: new Date(),
      updatedBy: null,
    });
  }

  /** DELETE {prefix}/api/settings/:key */
  async destroy(ctx: HttpContext) {
    const key = ctx.request.param('key') as string;

    const svc = await resolveRuntimeSettings(ctx);
    if (!svc) return notSupported(ctx);
    const tablePresent = await svc.isTablePresent();
    if (!tablePresent) return notSupported(ctx);

    if (isSettingLocked(key)) return lockedResponse(ctx, new SettingLockedError(key));

    const orgId = resolveOrgId(ctx);

    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    try {
      await svc.deleteSetting(key, orgId);
    } catch (err) {
      if (err instanceof SettingLockedError) return lockedResponse(ctx, err);
      throw err;
    }
    await cfg.audit?.record({
      type: 'settings.updated',
      actorId: null,
      ip: ctx.request.ip?.() ?? null,
      metadata: { key, action: 'deleted', source: 'admin-console', organizationId: orgId },
    });

    return { key, organizationId: orgId, deleted: true };
  }
}
