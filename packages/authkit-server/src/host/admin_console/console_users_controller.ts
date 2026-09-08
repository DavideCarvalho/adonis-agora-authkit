import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { supportsAccountDeletion, supportsAccountStatus } from '../../accounts/account_store.js';
import { ADMIN_LIST_HTTP_DEFAULT_SIZE, parseListPage, parseListSize } from '../../pagination.js';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import { AdminUsersService } from '../admin_api/admin_users_service.js';
import { apiError, grantDto, sessionDto, userDto } from '../admin_api/dto.js';
import { AdminSessionsService } from '../admin_sessions_service.js';
import { adminUserCreateValidator, adminUserRolesValidator } from '../admin_validators.js';
import type { RuntimeSettings } from '../runtime_settings.js';
import { resolveRuntimeSettings } from '../runtime_settings.js';
import { resolveEffectiveRolesCatalog } from '../runtime_toggles.js';
import { enrichSessionsWithContext } from '../session_context.js';
import { requireSudo } from '../sudo_mode.js';

/**
 * Gate de sudo (M9) para ações destrutivas do console (delete user, disable,
 * reset-password): exige confirmação de identidade RECENTE do próprio admin
 * autenticado (mesma infra usada pelo self-service — `requireSudo` +
 * `/account/confirm`), não apenas a sessão de admin já autenticada.
 *
 * Difere do uso em telas HTML (`account_security_controller`): esta é uma API
 * JSON consumida pela SPA do console, então o resultado "sudo ausente" vira
 * 403 JSON em vez de seguir o redirect que `requireSudo` monta internamente
 * (mesmo padrão de `account_api_controller.ts`, que descarta aquele redirect e
 * responde o próprio 403).
 */
async function gateSudo(ctx: HttpContext): Promise<unknown | null> {
  const settings = await resolveRuntimeSettings(ctx);
  const result = await requireSudo(ctx, settings);
  if (result === true) return null;
  return ctx.response
    .status(403)
    .send(apiError('sudo_required', 'Identity confirmation required.'));
}

/**
 * Endpoints JSON de usuários do console admin React.
 *
 * GET  {prefix}/api/users?search=&page=&size=  → lista paginada + roles
 * GET  {prefix}/api/users/:id                     → detalhe + sessões + identidades + MFA status
 * POST {prefix}/api/users                         → criar usuário
 * PATCH {prefix}/api/users/:id/roles              → substituir roles globais
 * POST {prefix}/api/users/:id/disable             → desabilitar conta
 * POST {prefix}/api/users/:id/enable              → reabilitar conta
 * POST {prefix}/api/users/:id/reset-password      → emitir token de reset + enviar e-mail
 * DELETE {prefix}/api/users/:id                   → deleção completa (cascade)
 *
 * Todos os mutating endpoints retornam 403 sem sessão/role (adminGuard upstream).
 * CSRF: o `adminGuard` não aplica CSRF por si só — o shield do AdonisJS protege
 * automaticamente POST/PATCH/DELETE; o shell injeta `csrfToken` na SPA.
 */
export default class ConsoleUsersController {
  /** GET {prefix}/api/users */
  async index(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;

    const search = (ctx.request.input('search', '') as string).trim();
    const page = parseListPage(ctx.request.input('page'));
    const size = parseListSize(ctx.request.input('size'), ADMIN_LIST_HTTP_DEFAULT_SIZE);

    const result = await cfg.accountStore.listAccounts({
      search,
      page,
      size,
    });
    const users = new AdminUsersService(cfg);

    const data = await Promise.all(
      result.data.map(async (u: any) => userDto(u, await users.isDisabled(u.id))),
    );

    return { data, total: result.total, page, size };
  }

  /** GET {prefix}/api/users/:id */
  async show(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const id = ctx.request.param('id') as string;

    const account = await cfg.accountStore.findById(id);
    if (!account) return ctx.response.notFound(apiError('not_found', 'Usuário não encontrado.'));

    const users = new AdminUsersService(cfg);
    const disabled = await users.isDisabled(id);

    // Sessões ativas (degradam quando adapter não enumera).
    const sessions = new AdminSessionsService(service);
    const rawSessions = sessions.canList ? await sessions.listSessions(id) : [];
    const enriched = await enrichSessionsWithContext(cfg, id, rawSessions);
    const grants = sessions.canList ? await sessions.listGrants(id) : [];

    // Catálogo de roles (fail-safe).
    let catalogRoles: { name: string; description?: string }[] = [];
    try {
      const rs = await resolveRuntimeSettings(ctx);
      if (rs) {
        const catalog = await resolveEffectiveRolesCatalog(rs);
        catalogRoles = catalog.roles;
      }
    } catch {
      // fail-safe
    }

    return {
      ...userDto(account, disabled),
      sessionsSupported: sessions.canList,
      sessions: enriched.map(sessionDto),
      grants: grants.map(grantDto),
      statusSupported: supportsAccountStatus(cfg.accountStore),
      deletionSupported: supportsAccountDeletion(cfg.accountStore),
      catalogRoles,
    };
  }

  /** POST {prefix}/api/users */
  async store(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const actorId = (ctx.session?.get(ACCOUNT_SESSION_KEY) as string) ?? null;
    const ip = ctx.request.ip?.() ?? null;

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
      { actorId, ip, source: 'admin' },
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

  /** PATCH {prefix}/api/users/:id/roles */
  async updateRoles(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const id = ctx.request.param('id') as string;

    const account = await cfg.accountStore.findById(id);
    if (!account) return ctx.response.notFound(apiError('not_found', 'Usuário não encontrado.'));

    const actorId = (ctx.session?.get(ACCOUNT_SESSION_KEY) as string) ?? null;

    const { roles: rolesInput } = await ctx.request.validateUsing(adminUserRolesValidator);
    const roles = Array.from(new Set((rolesInput ?? []).map((r) => r.trim()).filter(Boolean)));

    const users = new AdminUsersService(cfg);

    // Proteções de escalonamento/lockout: último admin + auto-rebaixamento.
    const guard = await users.guardGlobalRolesChange(id, roles, actorId);
    if (guard === 'last_admin') {
      return ctx.response
        .status(409)
        .send(
          apiError(
            'last_admin',
            'Não é possível remover a última conta com a role de administrador.',
          ),
        );
    }
    if (guard === 'cannot_self_demote') {
      return ctx.response
        .status(409)
        .send(
          apiError(
            'cannot_self_demote',
            'Você não pode remover a sua própria role de administrador.',
          ),
        );
    }

    // Resolve RuntimeSettings para validação contra catálogo (fail-safe).
    const runtimeSettings: RuntimeSettings | null = await resolveRuntimeSettings(ctx);

    const errorKey = await users.setGlobalRolesValidated(id, roles, runtimeSettings);
    if (errorKey) {
      return ctx.response.badRequest(apiError('invalid_role', cfg.messages[errorKey] ?? errorKey));
    }

    const updated = await cfg.accountStore.findById(id);
    const disabled = await users.isDisabled(id);
    return userDto(updated!, disabled);
  }

  /** POST {prefix}/api/users/:id/disable */
  async disable(ctx: HttpContext) {
    // Sudo (M9): desabilitar uma conta é destrutivo o bastante para exigir
    // reconfirmação — mas `enable()` (reverter) não passa por aqui de propósito.
    const denied = await gateSudo(ctx);
    if (denied) return denied;
    return this.#setStatus(ctx, true);
  }

  /** POST {prefix}/api/users/:id/enable */
  async enable(ctx: HttpContext) {
    return this.#setStatus(ctx, false);
  }

  async #setStatus(ctx: HttpContext, disable: boolean) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const actorId = (ctx.session?.get(ACCOUNT_SESSION_KEY) as string) ?? null;
    const ip = ctx.request.ip?.() ?? null;
    const id = ctx.request.param('id') as string;

    const account = await cfg.accountStore.findById(id);
    if (!account) return ctx.response.notFound(apiError('not_found', 'Usuário não encontrado.'));

    const users = new AdminUsersService(cfg);
    const applied = await users.setStatus(id, disable, {
      actorId,
      ip,
      source: 'admin',
    });
    if (!applied) {
      return ctx.response
        .status(409)
        .send(
          apiError('capability_unsupported', 'O store não suporta habilitar/desabilitar contas.'),
        );
    }
    const updated = await cfg.accountStore.findById(id);
    const disabled = await users.isDisabled(id);
    return userDto(updated!, disabled);
  }

  /** POST {prefix}/api/users/:id/reset-password */
  async resetPassword(ctx: HttpContext) {
    // Sudo (M9): dispara um e-mail de reset em nome do admin — reconfirmação
    // recente antes de agir.
    const denied = await gateSudo(ctx);
    if (denied) return denied;

    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const actorId = (ctx.session?.get(ACCOUNT_SESSION_KEY) as string) ?? null;
    const ip = ctx.request.ip?.() ?? null;
    const id = ctx.request.param('id') as string;

    const users = new AdminUsersService(cfg);
    const account = await users.resetPassword(ctx, id, {
      actorId,
      ip,
      source: 'admin',
    });
    if (!account) return ctx.response.notFound(apiError('not_found', 'Usuário não encontrado.'));

    return { ok: true, email: account.email };
  }

  /** DELETE {prefix}/api/users/:id */
  async destroy(ctx: HttpContext) {
    // Sudo (M9): deleção é irreversível (cascade) — a ação destrutiva por
    // excelência que o audit apontou sem gate nenhum.
    const denied = await gateSudo(ctx);
    if (denied) return denied;

    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const actorId = (ctx.session?.get(ACCOUNT_SESSION_KEY) as string) ?? null;
    const ip = ctx.request.ip?.() ?? null;
    const id = ctx.request.param('id') as string;

    const users = new AdminUsersService(cfg);
    // OPT-IN durável: passa o enqueue (cascade async); senão delete() roda síncrono.
    const enqueue = cfg.accountLifecycle?.durable
      ? (await import('../durable/index.js')).enqueueDeletionVia(ctx.containerResolver)
      : undefined;
    const outcome = await users.delete(service, id, { actorId, ip, source: 'admin' }, enqueue);

    if (!outcome.ok) {
      if (outcome.reason === 'not_found') {
        return ctx.response.notFound(apiError('not_found', 'Usuário não encontrado.'));
      }
      return ctx.response
        .status(409)
        .send(apiError('capability_unsupported', 'O store não suporta deleção de contas.'));
    }

    return { ok: true, deleted: id };
  }
}
