import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { apiError } from '../admin_api/dto.js';
import { roleCreateValidator, roleUpdateValidator } from '../admin_validators.js';
import { resolveRuntimeSettings } from '../runtime_settings.js';
import {
  type RoleCatalogEntry,
  resolveEffectiveRolesCatalog,
  SETTING_KEYS,
} from '../runtime_toggles.js';

/** Regex de validação: nome de role — letras maiúsculas, dígitos e underscore. */
const ROLE_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** ADMIN é protegido: não pode ser removido. */
const PROTECTED_ROLE = 'ADMIN';

/**
 * Endpoints JSON do catálogo de roles do console admin React.
 *
 * GET    {prefix}/api/roles        → lista o catálogo
 * POST   {prefix}/api/roles        → criar nova role
 * PATCH  {prefix}/api/roles/:name  → editar descrição
 * DELETE {prefix}/api/roles/:name  → remover role (ADMIN protegido)
 *
 * 404 quando a tabela auth_settings não está disponível.
 */
export default class ConsoleRolesController {
  /** GET {prefix}/api/roles */
  async index(ctx: HttpContext) {
    const rs = await resolveRuntimeSettings(ctx);
    if (!rs)
      return ctx.response.notFound(
        apiError('capability_unsupported', 'Tabela auth_settings não disponível.'),
      );
    const { roles } = await resolveEffectiveRolesCatalog(rs);
    return { data: roles };
  }

  /** POST {prefix}/api/roles — { name, description? } */
  async store(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const actorId = (ctx.session?.get(ACCOUNT_SESSION_KEY) as string) ?? null;
    const ip = ctx.request.ip?.() ?? null;

    const validated = await ctx.request.validateUsing(roleCreateValidator);
    const name = validated.name.toUpperCase();
    const description = validated.description ?? '';

    // Formato (uppercase + regex) e mensagem custom continuam aqui — Vine só
    // garante presença/tipo; a regra de domínio do nome é específica do catálogo.
    if (!ROLE_NAME_RE.test(name)) {
      return ctx.response.badRequest(
        apiError(
          'invalid_name',
          cfg.messages['admin.roles.name_invalid'] ?? 'Nome de role inválido.',
        ),
      );
    }

    const rs = await resolveRuntimeSettings(ctx);
    if (!rs)
      return ctx.response.notFound(
        apiError('capability_unsupported', 'Tabela auth_settings não disponível.'),
      );

    const current = await resolveEffectiveRolesCatalog(rs);
    if (current.roles.some((r) => r.name.toUpperCase() === name)) {
      return ctx.response.conflict(
        apiError('name_taken', cfg.messages['admin.roles.name_taken'] ?? 'Nome de role já existe.'),
      );
    }

    const newEntry: RoleCatalogEntry = { name };
    if (description) newEntry.description = description;
    const updated = [...current.roles, newEntry].sort((a, b) => a.name.localeCompare(b.name));

    await rs.setSetting(SETTING_KEYS.ROLES_CATALOG, { roles: updated }, actorId);
    await cfg.audit?.record({
      type: 'roles_catalog.updated',
      actorId,
      ip,
      metadata: { action: 'create', role: name },
    });

    return { name, description: description || undefined };
  }

  /** PATCH {prefix}/api/roles/:name — { description? } */
  async update(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const actorId = (ctx.session?.get(ACCOUNT_SESSION_KEY) as string) ?? null;
    const ip = ctx.request.ip?.() ?? null;

    const roleName = decodeURIComponent(ctx.request.param('name') as string);
    const { description: rawDescription } = await ctx.request.validateUsing(roleUpdateValidator);
    const description = rawDescription ?? '';

    const rs = await resolveRuntimeSettings(ctx);
    if (!rs)
      return ctx.response.notFound(
        apiError('capability_unsupported', 'Tabela auth_settings não disponível.'),
      );

    const current = await resolveEffectiveRolesCatalog(rs);
    if (!current.roles.some((r) => r.name === roleName)) {
      return ctx.response.notFound(apiError('not_found', 'Role não encontrada.'));
    }

    const updatedRoles = current.roles.map((r) =>
      r.name === roleName ? { name: r.name, ...(description ? { description } : {}) } : r,
    );
    await rs.setSetting(SETTING_KEYS.ROLES_CATALOG, { roles: updatedRoles }, actorId);
    await cfg.audit?.record({
      type: 'roles_catalog.updated',
      actorId,
      ip,
      metadata: { action: 'edit', role: roleName },
    });

    const found = updatedRoles.find((r) => r.name === roleName)!;
    return found;
  }

  /** DELETE {prefix}/api/roles/:name */
  async destroy(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const actorId = (ctx.session?.get(ACCOUNT_SESSION_KEY) as string) ?? null;
    const ip = ctx.request.ip?.() ?? null;

    const roleName = decodeURIComponent(ctx.request.param('name') as string);

    if (roleName === PROTECTED_ROLE) {
      return ctx.response
        .status(409)
        .send(
          apiError(
            'protected',
            cfg.messages['admin.roles.admin_protected'] ?? 'A role ADMIN é protegida.',
          ),
        );
    }

    const rs = await resolveRuntimeSettings(ctx);
    if (!rs)
      return ctx.response.notFound(
        apiError('capability_unsupported', 'Tabela auth_settings não disponível.'),
      );

    const current = await resolveEffectiveRolesCatalog(rs);
    if (!current.roles.some((r) => r.name === roleName)) {
      return ctx.response.notFound(apiError('not_found', 'Role não encontrada.'));
    }

    const updatedRoles = current.roles.filter((r) => r.name !== roleName);
    if (!updatedRoles.some((r) => r.name === PROTECTED_ROLE)) {
      updatedRoles.unshift({
        name: PROTECTED_ROLE,
        description: 'Full access to the admin console',
      });
    }

    await rs.setSetting(SETTING_KEYS.ROLES_CATALOG, { roles: updatedRoles }, actorId);
    await cfg.audit?.record({
      type: 'roles_catalog.updated',
      actorId,
      ip,
      metadata: { action: 'delete', role: roleName },
    });

    return { ok: true, deleted: roleName };
  }
}
