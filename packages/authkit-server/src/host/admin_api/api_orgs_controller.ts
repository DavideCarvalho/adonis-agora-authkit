import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import {
  orgAddMemberValidator,
  orgCreateValidator,
  orgInvitationValidator,
  orgMemberRoleValidator,
  orgUpdateValidator,
} from '../admin_validators.js';
import { authkitOrigin } from '../origin.js';
import { resolveRuntimeSettings } from '../runtime_settings.js';
import { AdminOrgsService } from './admin_orgs_service.js';
import { apiError, orgDetailDto, orgDto, orgInvitationDto } from './dto.js';

/** Lê a config + monta o actor `admin-api` para auditoria. */
async function ctxBits(ctx: HttpContext) {
  const service = await ctx.containerResolver.make('authkit.server');
  const cfg = service.config;
  const actor = { actorId: null, ip: ctx.request.ip?.() ?? null, source: 'admin-api' as const };
  return { service, cfg, actor };
}

/** Helper: 404 JSON quando organizations não é suportado. */
function notSupported(ctx: HttpContext) {
  return ctx.response.notFound(
    apiError('capability_unsupported', 'Organizations não é suportado nesta instalação.'),
  );
}

/**
 * CRUD de organizações da Admin REST API.
 * Todas as rotas ficam sob `/api/authkit/v1/organizations`.
 */
export default class ApiOrgsController {
  /** GET /organizations — lista todas as orgs com contagem de membros. */
  async index(ctx: HttpContext) {
    const { cfg } = await ctxBits(ctx);
    const svc = new AdminOrgsService(cfg);

    const result = await svc.listOrgs();
    if (!Array.isArray(result)) {
      if (result.reason === 'not_supported') return notSupported(ctx);
    }

    const orgs = result as Awaited<ReturnType<AdminOrgsService['listOrgs']>>;
    if (!Array.isArray(orgs)) return notSupported(ctx);

    return { data: orgs.map(orgDto) };
  }

  /** POST /organizations — cria uma org. Body: { name, slug, ownerAccountId, logoUrl? } */
  async store(ctx: HttpContext) {
    const { cfg, actor } = await ctxBits(ctx);
    const svc = new AdminOrgsService(cfg);

    const { name, slug, ownerAccountId, logoUrl } =
      await ctx.request.validateUsing(orgCreateValidator);

    const result = await svc.createOrg(
      { name, slug, logoUrl: logoUrl ?? null, ownerAccountId },
      actor,
    );

    if ('ok' in result && result.ok === false) {
      if (result.reason === 'not_supported') return notSupported(ctx);
      return ctx.response.conflict(apiError('slug_taken', 'Já existe uma org com este slug.'));
    }

    ctx.response.status(201);
    return orgDto(result as any);
  }

  /** GET /organizations/:id — obtém uma org com membros e convites. */
  async show(ctx: HttpContext) {
    const { cfg } = await ctxBits(ctx);
    const svc = new AdminOrgsService(cfg);
    const id = ctx.request.param('id');

    const result = await svc.getOrg(id);

    if ('ok' in result && result.ok === false) {
      if (result.reason === 'not_supported') return notSupported(ctx);
      return ctx.response.notFound(apiError('not_found', 'Organização não encontrada.'));
    }

    return orgDetailDto(result as any);
  }

  /** PATCH /organizations/:id — atualiza nome e/ou logo. */
  async update(ctx: HttpContext) {
    const { cfg, actor } = await ctxBits(ctx);
    const svc = new AdminOrgsService(cfg);
    const id = ctx.request.param('id');

    const { name, logoUrl } = await ctx.request.validateUsing(orgUpdateValidator);

    const patch: { name?: string; logoUrl?: string | null } = {};
    if (name !== undefined) patch.name = name;
    if (logoUrl !== undefined) patch.logoUrl = logoUrl;

    const result = await svc.updateOrg(id, patch, actor);

    if ('ok' in result && result.ok === false) {
      if (result.reason === 'not_supported') return notSupported(ctx);
      if (result.reason === 'not_found')
        return ctx.response.notFound(apiError('not_found', 'Organização não encontrada.'));
      return ctx.response.conflict(apiError('slug_taken', 'Já existe uma org com este slug.'));
    }

    return orgDto(result as any);
  }

  /** DELETE /organizations/:id */
  async destroy(ctx: HttpContext) {
    const { cfg, actor } = await ctxBits(ctx);
    const svc = new AdminOrgsService(cfg);
    const id = ctx.request.param('id');

    const result = await svc.deleteOrg(id, actor);

    if (!result.ok) {
      if (result.reason === 'not_supported') return notSupported(ctx);
      return ctx.response.notFound(apiError('not_found', 'Organização não encontrada.'));
    }

    return { id, deleted: true };
  }

  /** POST /organizations/:id/members — adiciona membro. Body: { accountId, role } */
  async addMember(ctx: HttpContext) {
    const { cfg, actor } = await ctxBits(ctx);
    const svc = new AdminOrgsService(cfg);
    const orgId = ctx.request.param('id');

    const { accountId, role } = await ctx.request.validateUsing(orgAddMemberValidator);

    const result = await svc.addMember(
      orgId,
      { accountId, role: role ?? 'member' },
      actor,
      await resolveRuntimeSettings(ctx),
    );

    if (!result.ok) {
      if (result.reason === 'not_supported') return notSupported(ctx);
      if (result.reason === 'not_found')
        return ctx.response.notFound(apiError('not_found', 'Organização não encontrada.'));
      if (result.reason === 'invalid_role')
        return ctx.response.unprocessableEntity(
          apiError('invalid_role', 'Role inválida — fora do catálogo da organização.'),
        );
      return ctx.response.notFound(apiError('account_not_found', 'Conta não encontrada.'));
    }

    ctx.response.status(201);
    return { orgId, accountId, role, added: true };
  }

  /** DELETE /organizations/:id/members/:accountId */
  async removeMember(ctx: HttpContext) {
    const { cfg, actor } = await ctxBits(ctx);
    const svc = new AdminOrgsService(cfg);
    const orgId = ctx.request.param('id');
    const accountId = ctx.request.param('accountId');

    const result = await svc.removeMember(orgId, accountId, actor);

    if (!result.ok) {
      if (result.reason === 'not_supported') return notSupported(ctx);
      if (result.reason === 'not_found')
        return ctx.response.notFound(apiError('not_found', 'Organização não encontrada.'));
      if (result.reason === 'last_owner')
        return ctx.response.conflict(
          apiError('last_owner', 'Não é possível remover o último owner.'),
        );
      return ctx.response.notFound(apiError('member_not_found', 'Membro não encontrado.'));
    }

    return { orgId, accountId, removed: true };
  }

  /** PATCH /organizations/:id/members/:accountId — troca o papel. Body: { role } */
  async updateMemberRole(ctx: HttpContext) {
    const { cfg, actor } = await ctxBits(ctx);
    const svc = new AdminOrgsService(cfg);
    const orgId = ctx.request.param('id');
    const accountId = ctx.request.param('accountId');
    const { role } = await ctx.request.validateUsing(orgMemberRoleValidator);

    const result = await svc.updateMemberRole(
      orgId,
      accountId,
      role,
      actor,
      await resolveRuntimeSettings(ctx),
    );

    if (!result.ok) {
      if (result.reason === 'not_supported') return notSupported(ctx);
      if (result.reason === 'not_found')
        return ctx.response.notFound(apiError('not_found', 'Organização não encontrada.'));
      if (result.reason === 'invalid_role')
        return ctx.response.unprocessableEntity(
          apiError('invalid_role', 'Role inválida — fora do catálogo da organização.'),
        );
      if (result.reason === 'last_owner')
        return ctx.response.conflict(
          apiError('last_owner', 'Não é possível rebaixar o último owner.'),
        );
      return ctx.response.notFound(apiError('member_not_found', 'Membro não encontrado.'));
    }

    return { orgId, accountId, role, updated: true };
  }

  /** POST /organizations/:id/invitations — cria convite. Body: { email, role } */
  async createInvitation(ctx: HttpContext) {
    const { cfg, actor } = await ctxBits(ctx);
    const svc = new AdminOrgsService(cfg);
    const orgId = ctx.request.param('id');

    const { email, role } = await ctx.request.validateUsing(orgInvitationValidator);

    const origin = authkitOrigin(cfg);
    const result = await svc.createInvitation(
      orgId,
      { email, role: role ?? 'member' },
      actor,
      origin,
      await resolveRuntimeSettings(ctx),
    );

    if (!result.ok) {
      if (result.reason === 'not_supported') return notSupported(ctx);
      if (result.reason === 'invalid_role')
        return ctx.response.unprocessableEntity(
          apiError('invalid_role', 'Role inválida — fora do catálogo da organização.'),
        );
      return ctx.response.notFound(apiError('not_found', 'Organização não encontrada.'));
    }

    ctx.response.status(201);
    return orgInvitationDto(result.invitation);
  }

  /** DELETE /organizations/:id/invitations/:invitationId */
  async revokeInvitation(ctx: HttpContext) {
    const { cfg, actor } = await ctxBits(ctx);
    const svc = new AdminOrgsService(cfg);
    const orgId = ctx.request.param('id');
    const invitationId = ctx.request.param('invitationId');

    const result = await svc.revokeInvitation(orgId, invitationId, actor);

    if (!result.ok) {
      if (result.reason === 'not_supported') return notSupported(ctx);
      if (result.reason === 'not_found')
        return ctx.response.notFound(apiError('not_found', 'Organização não encontrada.'));
      return ctx.response.notFound(apiError('invitation_not_found', 'Convite não encontrado.'));
    }

    return { orgId, invitationId, revoked: true };
  }
}
