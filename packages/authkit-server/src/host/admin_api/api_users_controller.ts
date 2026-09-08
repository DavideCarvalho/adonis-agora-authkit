import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import type { AuthAccount } from '../../accounts/account_store.js';
import { ADMIN_LIST_HTTP_DEFAULT_SIZE, parseListPage, parseListSize } from '../../pagination.js';
import { AdminSessionsService } from '../admin_sessions_service.js';
import { adminUserCreateValidator, adminUserUpdateValidator } from '../admin_validators.js';
import { resolveRuntimeSettings } from '../runtime_settings.js';
import { enrichSessionsWithContext } from '../session_context.js';
import { AdminUsersService } from './admin_users_service.js';
import { apiError, grantDto, sessionDto, userDto } from './dto.js';

/**
 * Lê a config + monta o actor `admin-api` para auditoria. O `actorId` recebe o
 * id NÃO-SENSÍVEL da API key que autenticou (anexado pelo `adminApiGuard` em
 * `ctx.adminApiKeyId`) — assim a trilha REST registra QUAL key agiu (M9) sem
 * vazar o segredo. `null` apenas se a guard não anexou (defensivo).
 */
async function ctxBits(ctx: HttpContext) {
  const service = await ctx.containerResolver.make('authkit.server');
  const cfg = service.config;
  const actor = {
    actorId: ctx.adminApiKeyId ?? null,
    ip: ctx.request.ip?.() ?? null,
    source: 'admin-api' as const,
  };
  return { service, cfg, actor };
}

/**
 * Recurso de usuários da Admin REST API (R6). JSON puro (camelCase), erros no
 * envelope `{ error: { code, message } }`. Toda escrita audita com `actor: 'admin-api'`.
 */
export default class ApiUsersController {
  /** GET /users — `{ meta: { page, size, total }, data }`, com busca por e-mail. */
  async index(ctx: HttpContext) {
    const { cfg } = await ctxBits(ctx);
    const search = (ctx.request.input('search', '') as string).trim();
    const page = parseListPage(ctx.request.input('page'));
    const size = parseListSize(ctx.request.input('size'), ADMIN_LIST_HTTP_DEFAULT_SIZE);

    const result = await cfg.accountStore.listAccounts({ search, page, size });
    const users = new AdminUsersService(cfg);
    const data = await Promise.all(
      result.data.map(async (u: AuthAccount) => userDto(u, await users.isDisabled(u.id))),
    );
    return { meta: { page, size, total: result.total }, data };
  }

  /** GET /users/:id */
  async show(ctx: HttpContext) {
    const { cfg } = await ctxBits(ctx);
    const id = ctx.request.param('id');
    const account = await cfg.accountStore.findById(id);
    if (!account) return ctx.response.notFound(apiError('not_found', 'Usuário não encontrado.'));
    const disabled = await new AdminUsersService(cfg).isDisabled(id);
    return userDto(account, disabled);
  }

  /** POST /users — { email, name?, password? | invite?:true }. */
  async store(ctx: HttpContext) {
    const { cfg, actor } = await ctxBits(ctx);
    const { email, name, password, invite } =
      await ctx.request.validateUsing(adminUserCreateValidator);

    const users = new AdminUsersService(cfg);
    const result = await users.create(
      ctx,
      {
        email,
        name: name ?? null,
        password: password ?? null,
        invite: invite ?? false,
      },
      actor,
    );
    if (!result.ok) {
      if (result.reason === 'password_policy') {
        return ctx.response.badRequest(
          apiError('password_policy', cfg.messages[result.messageKey] ?? result.messageKey),
        );
      }
      return ctx.response.conflict(apiError('email_taken', 'Já existe uma conta com este e-mail.'));
    }
    ctx.response.status(201);
    return { ...userDto(result.account), invited: result.invited };
  }

  /** PATCH /users/:id — { globalRoles?, name?, avatarUrl? }. */
  async update(ctx: HttpContext) {
    const { cfg, actor } = await ctxBits(ctx);
    const id = ctx.request.param('id');
    const account = await cfg.accountStore.findById(id);
    if (!account) return ctx.response.notFound(apiError('not_found', 'Usuário não encontrado.'));

    const users = new AdminUsersService(cfg);
    const {
      globalRoles: roles,
      name,
      avatarUrl,
    } = await ctx.request.validateUsing(adminUserUpdateValidator);
    if (Array.isArray(roles)) {
      const normalized = Array.from(new Set(roles.map((r) => r.trim()).filter(Boolean)));

      // Proteções de escalonamento/lockout: último admin + auto-rebaixamento.
      // O actorId vem do id da API key (M9); self-demote só aplica se identificável.
      const guard = await users.guardGlobalRolesChange(id, normalized, actor.actorId);
      if (guard === 'last_admin') {
        return ctx.response.conflict(
          apiError(
            'last_admin',
            'Não é possível remover a última conta com a role de administrador.',
          ),
        );
      }
      if (guard === 'cannot_self_demote') {
        return ctx.response.conflict(
          apiError(
            'cannot_self_demote',
            'Você não pode remover a sua própria role de administrador.',
          ),
        );
      }

      // Valida contra o catálogo (mesmo caminho do console) — roles fora do
      // catálogo (e que o usuário não tinha) → 422.
      const settings = await resolveRuntimeSettings(ctx);
      const errorKey = await users.setGlobalRolesValidated(id, normalized, settings);
      if (errorKey) {
        return ctx.response
          .status(422)
          .send(apiError('invalid_role', cfg.messages[errorKey] ?? errorKey));
      }
    }

    if (name !== undefined || avatarUrl !== undefined) {
      const patch: { name?: string | null; avatarUrl?: string | null } = {};
      if (name !== undefined) patch.name = name;
      if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl;
      await users.updateProfile(id, patch);
    }

    const updated = await cfg.accountStore.findById(id);
    return userDto(updated!, await users.isDisabled(id));
  }

  /** DELETE /users/:id — deleção completa (cascade) da conta. */
  async destroy(ctx: HttpContext) {
    const { service, cfg, actor } = await ctxBits(ctx);
    const id = ctx.request.param('id');
    // OPT-IN durável: passa o enqueue (cascade async); senão delete() roda síncrono.
    const enqueue = cfg.accountLifecycle?.durable
      ? (await import('../durable/index.js')).enqueueDeletionVia(ctx.containerResolver)
      : undefined;
    const outcome = await new AdminUsersService(cfg).delete(service, id, actor, enqueue);
    if (!outcome.ok) {
      if (outcome.reason === 'not_found') {
        return ctx.response.notFound(apiError('not_found', 'Usuário não encontrado.'));
      }
      return ctx.response.conflict(
        apiError('capability_unsupported', 'O store de contas não suporta deletar usuários.'),
      );
    }
    // Modo durável: a deleção foi ENFILEIRADA (cascade async) — responde 202-style.
    if ('enqueued' in outcome) {
      return { id, deleted: true, enqueued: true, runId: outcome.runId };
    }
    return { id, deleted: true, ...outcome.result };
  }

  /** POST /users/:id/disable */
  async disable(ctx: HttpContext) {
    return this.#setStatus(ctx, true);
  }

  /** POST /users/:id/enable */
  async enable(ctx: HttpContext) {
    return this.#setStatus(ctx, false);
  }

  async #setStatus(ctx: HttpContext, disable: boolean) {
    const { cfg, actor } = await ctxBits(ctx);
    const id = ctx.request.param('id');
    const applied = await new AdminUsersService(cfg).setStatus(id, disable, actor);
    if (!applied) {
      return ctx.response.conflict(
        apiError('capability_unsupported', 'O store de contas não suporta habilitar/desabilitar.'),
      );
    }
    return { id, disabled: disable };
  }

  /** POST /users/:id/reset-password — envia o e-mail de reset. */
  async resetPassword(ctx: HttpContext) {
    const { cfg, actor } = await ctxBits(ctx);
    const id = ctx.request.param('id');
    const account = await new AdminUsersService(cfg).resetPassword(ctx, id, actor);
    if (!account) return ctx.response.notFound(apiError('not_found', 'Usuário não encontrado.'));
    return { id, sent: true };
  }

  /** GET /users/:id/sessions — sessões (enriquecidas com contexto) + grants ativos. */
  async sessions(ctx: HttpContext) {
    const { service, cfg } = await ctxBits(ctx);
    const id = ctx.request.param('id');
    const admin = new AdminSessionsService(service);
    const sessions = await enrichSessionsWithContext(cfg, id, await admin.listSessions(id));
    const grants = await admin.listGrants(id);
    return {
      canList: admin.canList,
      sessions: sessions.map(sessionDto),
      grants: grants.map(grantDto),
    };
  }

  /** POST /users/:id/revoke-sessions — revoga todas as sessões/grants. */
  async revokeSessions(ctx: HttpContext) {
    const { service, cfg, actor } = await ctxBits(ctx);
    const id = ctx.request.param('id');
    const result = await new AdminSessionsService(service).revokeAll(id);
    await cfg.audit?.record({
      type: 'session.revoked_all',
      accountId: id,
      actorId: actor.actorId,
      ip: actor.ip,
      metadata: { actor: actor.source, ...result },
    });
    return result;
  }
}
