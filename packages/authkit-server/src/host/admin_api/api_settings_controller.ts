import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { isSettingLocked, lockedSettingKeys, SettingLockedError } from '../config_locks.js';
import { resolveRuntimeSettings } from '../runtime_settings.js';
import { apiError, settingDto } from './dto.js';

/** 423 Locked: a setting foi travada via defineConfig (não editável em runtime). */
function lockedResponse(ctx: HttpContext, err: SettingLockedError) {
  return ctx.response
    .status(423)
    .send(apiError('setting_locked', err.message, { key: err.key, lockedBy: 'config' }));
}

/** Helper: 404 JSON when settings capability is not available (table absent). */
function notSupported(ctx: HttpContext) {
  return ctx.response.notFound(
    apiError(
      'capability_unsupported',
      'Runtime settings não é suportado nesta instalação (tabela auth_settings ausente).',
    ),
  );
}

/** Extrai organizationId do query string. null = global. */
function resolveOrgId(ctx: HttpContext): string | null {
  const qs = ctx.request.qs() as Record<string, string | undefined>;
  if ('organizationId' in qs) {
    const v = qs.organizationId;
    return v?.trim() ? v.trim() : null;
  }
  return null;
}

/**
 * CRUD de runtime settings da Admin REST API.
 * Todas as rotas ficam sob `/api/authkit/v1/settings`.
 * Retorna 404 (`capability_unsupported`) quando a tabela `auth_settings` não existe.
 *
 * Suporte a escopo por org via query param `?organizationId=`:
 *   GET  /settings?organizationId={id}  → lista settings da org
 *   PUT  /settings/:key?organizationId= → upsert no escopo da org
 *   DEL  /settings/:key?organizationId= → remove no escopo da org
 *
 * Keys org-scopáveis: `organizations_policy`, `roles_catalog`.
 */
export default class ApiSettingsController {
  /** GET /settings — lista settings (global por padrão, ou da org via ?organizationId=). */
  async index(ctx: HttpContext) {
    const svc = await resolveRuntimeSettings(ctx);
    if (!svc) return notSupported(ctx);
    // Probe table presence before returning list.
    const tablePresent = await svc.isTablePresent();
    if (!tablePresent) return notSupported(ctx);
    const orgId = resolveOrgId(ctx);
    const rows = await svc.listSettings(orgId);
    // `locked` lista TODAS as keys travadas por config (mesmo as sem row em auth_settings,
    // pois config-only não persiste row). A UI usa isto p/ desabilitar + avisar.
    return { data: rows.map(settingDto), locked: lockedSettingKeys() };
  }

  /** GET /settings/:key — obtém uma setting por key (global ou org). */
  async show(ctx: HttpContext) {
    const key = ctx.request.param('key') as string;
    const svc = await resolveRuntimeSettings(ctx);
    if (!svc) return notSupported(ctx);
    const tablePresent = await svc.isTablePresent();
    if (!tablePresent) return notSupported(ctx);
    const orgId = resolveOrgId(ctx);
    const value = await svc.getSetting(key, orgId);
    if (value === null) {
      return ctx.response.notFound(apiError('not_found', 'Setting não encontrada.'));
    }
    return settingDto({ key, organizationId: orgId, value, updatedAt: null, updatedBy: null });
  }

  /** PUT /settings/:key — cria ou atualiza uma setting. Body: { value: any } */
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

    // Travada via defineConfig → 423 antes de qualquer escrita.
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
      metadata: { key, value: body.value, organizationId: orgId },
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

  /** DELETE /settings/:key */
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
      metadata: { key, action: 'deleted', organizationId: orgId },
    });

    return { key, organizationId: orgId, deleted: true };
  }
}
