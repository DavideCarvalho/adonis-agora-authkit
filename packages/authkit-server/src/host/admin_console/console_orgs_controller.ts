import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { AdminOrgsService } from '../admin_api/admin_orgs_service.js';
import { apiError, orgDetailDto, orgDto } from '../admin_api/dto.js';
import {
  orgAddMemberValidator,
  orgCreateValidator,
  orgInvitationValidator,
  orgMemberRoleValidator,
  orgUpdateValidator,
} from '../admin_validators.js';
import { authkitOrigin } from '../origin.js';
import type { SettingsCapability } from '../runtime_settings.js';
import { resolveRuntimeSettings } from '../runtime_settings.js';

/**
 * Endpoints JSON de organizações do console admin React.
 * 404 honesto quando o store não suporta organizações (`capability_unsupported`).
 *
 * GET    {prefix}/api/orgs                                → lista orgs com contagem de membros
 * POST   {prefix}/api/orgs                                → cria uma org
 * GET    {prefix}/api/orgs/:id                            → detalhe da org (membros + convites)
 * PATCH  {prefix}/api/orgs/:id                            → edita nome/slug/logo
 * DELETE {prefix}/api/orgs/:id                            → remove a org
 * POST   {prefix}/api/orgs/:id/members                    → adiciona membro (accountId + role)
 * DELETE {prefix}/api/orgs/:id/members/:accountId         → remove membro
 * PATCH  {prefix}/api/orgs/:id/members/:accountId         → altera role do membro
 * POST   {prefix}/api/orgs/:id/invitations                → cria convite (email + role)
 * DELETE {prefix}/api/orgs/:id/invitations/:invitationId  → revoga convite
 */
export default class ConsoleOrgsController {
  private async svc(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    return new AdminOrgsService(service.config);
  }

  private actor(ctx: HttpContext) {
    return {
      actorId: (ctx.session?.get(ACCOUNT_SESSION_KEY) as string) ?? null,
      ip: ctx.request.ip?.() ?? null,
      source: 'admin' as const,
    };
  }

  /** Resolve RuntimeSettings (fail-safe → null) para validação do catálogo de roles. */
  private async settings(ctx: HttpContext): Promise<SettingsCapability | null> {
    return resolveRuntimeSettings(ctx);
  }

  /** GET {prefix}/api/orgs */
  async index(ctx: HttpContext) {
    const svc = await this.svc(ctx);

    if (!svc.supported) {
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    const result = await svc.listOrgs();
    if (!Array.isArray(result)) {
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    return { data: result.map((o) => orgDto(o)) };
  }

  /** POST {prefix}/api/orgs */
  async store(ctx: HttpContext) {
    const svc = await this.svc(ctx);

    if (!svc.supported) {
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    const { name, slug, ownerAccountId, logoUrl } =
      await ctx.request.validateUsing(orgCreateValidator);

    const result = await svc.createOrg(
      { name, slug, ownerAccountId, logoUrl: logoUrl ?? null },
      this.actor(ctx),
    );

    if ('ok' in result && result.ok === false) {
      if (result.reason === 'slug_taken') {
        return ctx.response.unprocessableEntity(
          apiError('slug_taken', 'Este slug já está em uso.'),
        );
      }
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    return ctx.response.created(orgDto(result as any));
  }

  /** GET {prefix}/api/orgs/:id */
  async show(ctx: HttpContext) {
    const svc = await this.svc(ctx);

    if (!svc.supported) {
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    const id = ctx.request.param('id') as string;
    const result = await svc.getOrg(id);

    if ('ok' in result && result.ok === false) {
      if (result.reason === 'not_found') {
        return ctx.response.notFound(apiError('not_found', 'Organização não encontrada.'));
      }
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    return orgDetailDto(result as any);
  }

  /** PATCH {prefix}/api/orgs/:id */
  async update(ctx: HttpContext) {
    const svc = await this.svc(ctx);

    if (!svc.supported) {
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    const id = ctx.request.param('id') as string;
    const { name, logoUrl } = await ctx.request.validateUsing(orgUpdateValidator);
    const patch: { name?: string; logoUrl?: string | null } = {};
    if (name !== undefined) patch.name = name;
    if (logoUrl !== undefined) patch.logoUrl = logoUrl;

    const result = await svc.updateOrg(id, patch, this.actor(ctx));

    if ('ok' in result && result.ok === false) {
      if (result.reason === 'not_found') {
        return ctx.response.notFound(apiError('not_found', 'Organização não encontrada.'));
      }
      if (result.reason === 'slug_taken') {
        return ctx.response.unprocessableEntity(
          apiError('slug_taken', 'Este slug já está em uso.'),
        );
      }
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    return orgDto(result as any);
  }

  /** DELETE {prefix}/api/orgs/:id */
  async destroy(ctx: HttpContext) {
    const svc = await this.svc(ctx);

    if (!svc.supported) {
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    const id = ctx.request.param('id') as string;
    const result = await svc.deleteOrg(id, this.actor(ctx));

    if ('ok' in result && result.ok === false) {
      if (result.reason === 'not_found') {
        return ctx.response.notFound(apiError('not_found', 'Organização não encontrada.'));
      }
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    return { id, deleted: true };
  }

  /** POST {prefix}/api/orgs/:id/members */
  async addMember(ctx: HttpContext) {
    const svc = await this.svc(ctx);

    if (!svc.supported) {
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    const orgId = ctx.request.param('id') as string;
    const { accountId, role } = await ctx.request.validateUsing(orgAddMemberValidator);

    const result = await svc.addMember(
      orgId,
      { accountId, role: role ?? 'member' },
      this.actor(ctx),
      await this.settings(ctx),
    );

    if ('ok' in result && result.ok === false) {
      if (result.reason === 'not_found') {
        return ctx.response.notFound(apiError('not_found', 'Organização não encontrada.'));
      }
      if (result.reason === 'invalid_role') {
        return ctx.response.unprocessableEntity(
          apiError('invalid_role', 'Role inválida — fora do catálogo da organização.'),
        );
      }
      if (result.reason === 'account_not_found') {
        return ctx.response.notFound(apiError('account_not_found', 'Conta não encontrada.'));
      }
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    return { ok: true };
  }

  /** DELETE {prefix}/api/orgs/:id/members/:accountId */
  async removeMember(ctx: HttpContext) {
    const svc = await this.svc(ctx);

    if (!svc.supported) {
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    const orgId = ctx.request.param('id') as string;
    const accountId = ctx.request.param('accountId') as string;

    const result = await svc.removeMember(orgId, accountId, this.actor(ctx));

    if ('ok' in result && result.ok === false) {
      if (result.reason === 'not_found') {
        return ctx.response.notFound(apiError('not_found', 'Organização não encontrada.'));
      }
      if (result.reason === 'last_owner') {
        return ctx.response.unprocessableEntity(
          apiError('last_owner', 'Não é possível remover o último owner da organização.'),
        );
      }
      if (result.reason === 'member_not_found') {
        return ctx.response.notFound(apiError('member_not_found', 'Membro não encontrado.'));
      }
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    return { ok: true };
  }

  /** PATCH {prefix}/api/orgs/:id/members/:accountId */
  async updateMemberRole(ctx: HttpContext) {
    const svc = await this.svc(ctx);

    if (!svc.supported) {
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    const orgId = ctx.request.param('id') as string;
    const accountId = ctx.request.param('accountId') as string;
    const { role } = await ctx.request.validateUsing(orgMemberRoleValidator);

    const result = await svc.updateMemberRole(
      orgId,
      accountId,
      role,
      this.actor(ctx),
      await this.settings(ctx),
    );

    if ('ok' in result && result.ok === false) {
      if (result.reason === 'not_found') {
        return ctx.response.notFound(apiError('not_found', 'Organização não encontrada.'));
      }
      if (result.reason === 'invalid_role') {
        return ctx.response.unprocessableEntity(
          apiError('invalid_role', 'Role inválida — fora do catálogo da organização.'),
        );
      }
      if (result.reason === 'last_owner') {
        return ctx.response.unprocessableEntity(
          apiError('last_owner', 'Não é possível alterar o role do último owner.'),
        );
      }
      if (result.reason === 'member_not_found') {
        return ctx.response.notFound(apiError('member_not_found', 'Membro não encontrado.'));
      }
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    return { ok: true };
  }

  /** POST {prefix}/api/orgs/:id/invitations */
  async createInvitation(ctx: HttpContext) {
    const svc = await this.svc(ctx);

    if (!svc.supported) {
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    const orgId = ctx.request.param('id') as string;
    const { email, role } = await ctx.request.validateUsing(orgInvitationValidator);

    const service = await ctx.containerResolver.make('authkit.server');
    const origin = authkitOrigin(service.config);
    const result = await svc.createInvitation(
      orgId,
      { email, role: role ?? 'member' },
      this.actor(ctx),
      origin,
      await this.settings(ctx),
      ctx,
    );

    if ('ok' in result && result.ok === false) {
      if (result.reason === 'not_found') {
        return ctx.response.notFound(apiError('not_found', 'Organização não encontrada.'));
      }
      if (result.reason === 'invalid_role') {
        return ctx.response.unprocessableEntity(
          apiError('invalid_role', 'Role inválida — fora do catálogo da organização.'),
        );
      }
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    const ok = result as { ok: true; invitation: any; token: string };
    return ctx.response.created({ ok: true, invitation: ok.invitation });
  }

  /** DELETE {prefix}/api/orgs/:id/invitations/:invitationId */
  async revokeInvitation(ctx: HttpContext) {
    const svc = await this.svc(ctx);

    if (!svc.supported) {
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    const orgId = ctx.request.param('id') as string;
    const invitationId = ctx.request.param('invitationId') as string;

    const result = await svc.revokeInvitation(orgId, invitationId, this.actor(ctx));

    if ('ok' in result && result.ok === false) {
      if (result.reason === 'not_found') {
        return ctx.response.notFound(apiError('not_found', 'Organização não encontrada.'));
      }
      if (result.reason === 'invitation_not_found') {
        return ctx.response.notFound(apiError('invitation_not_found', 'Convite não encontrado.'));
      }
      return ctx.response.notFound(
        apiError('capability_unsupported', 'O store não suporta organizações.'),
      );
    }

    return { ok: true };
  }
}
