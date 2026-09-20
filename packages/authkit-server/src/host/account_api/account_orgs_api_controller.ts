/**
 * Account Self-Service JSON API — ESCRITA de organizações
 *
 * Espelho JSON dos POSTs de formulário do `AccountOrgsController`, para hosts
 * que desenham as próprias telas de organização dentro do shell do produto e
 * não querem mandar o usuário ao console `/account/orgs`.
 *
 * Mapa de rotas (todas sob o `accountGuard`; as mutantes sob o CSRF do shield
 * do host — nenhuma delas entra em `authkitCsrfExceptions`):
 *   POST   /account/api/orgs                                → criar org (allowSelfCreate)
 *   POST   /account/api/orgs/deactivate                     → limpar a org ativa
 *   POST   /account/api/orgs/invitations/:token/accept      → aceitar convite
 *   POST   /account/api/orgs/:id/activate                   → definir org ativa
 *   POST   /account/api/orgs/:id/leave                      → sair da org
 *   POST   /account/api/orgs/:id/invitations                → convidar por e-mail
 *   DELETE /account/api/orgs/:id/invitations/:invId         → revogar convite
 *   PATCH  /account/api/orgs/:id/members/:accountId         → trocar papel
 *   DELETE /account/api/orgs/:id/members/:accountId         → remover membro
 *
 * O que este controller NÃO afrouxa em relação ao formulário:
 *
 *   - **Escopo por conta.** O ator é sempre `session[ACCOUNT_SESSION_KEY]`;
 *     nenhum handler aceita um id de ator vindo do corpo.
 *   - **Papel na org.** Convidar, revogar convite, remover membro e trocar
 *     papel exigem membership `owner`/`admin` NA ORG DO PATH — a mesma checagem
 *     do form, que é o que impede o IDOR cross-org.
 *   - **Escalonamento.** Só um `owner` concede o papel `owner`; um admin
 *     tentando isso leva 403, igual ao form.
 *   - **Catálogo de papéis.** O papel passa pelo `isRoleInCatalog` (runtime →
 *     config → defaults), o MESMO helper puro do form e do caminho admin.
 *
 * O que muda de propósito: a resposta. Onde o form redireciona para
 * `/account/orgs` (com ou sem flash), aqui sai JSON — `{ error: { code,
 * message } }` com o status certo, para a tela do host poder reagir.
 *
 * Sudo: o console HTML NÃO exige sudo em nenhuma operação de org, e este
 * espelho segue igual. Exigir aqui o que o form não exige seria divergência na
 * outra direção — e a decisão de qual superfície é sensível pertence a uma
 * mudança de política, não a um espelho de formato.
 *
 * Política EFETIVA, não o config estático. `allowSelfCreate`, o catálogo de
 * papéis e o TTL do convite saem do MESMO módulo que o console HTML usa
 * (`host/org_policy.ts`: setting da org → setting global → config → default da
 * lib). Ler só o config estático daria uma superfície que diverge da outra na
 * primeira vez que um admin mexesse na setting — e divergência entre o form e
 * o espelho é exatamente o bug que este controller não pode ter.
 */

import { createHash } from 'node:crypto';
import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { supportsOrganizations } from '../../accounts/account_store.js';
import { accountPath } from '../account_paths.js';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import {
  ACTIVE_ORG_COOKIE,
  ACTIVE_ORG_COOKIE_TTL,
  encodeActiveOrgCookie,
} from '../active_org_cookie.js';
import { sendOrgInvitationEmail } from '../default_mailer.js';
// Política efetiva: o MESMO módulo que o console HTML usa. Duas cópias da
// resolução são como o espelho JSON acabaria mais frouxo que o formulário.
import { effectiveOrgPolicy, orgPolicyDefaults } from '../org_policy.js';
import { authkitOrigin } from '../origin.js';
import { resolveRuntimeSettings } from '../runtime_settings.js';
import { isRoleInCatalog } from '../runtime_toggles.js';

/** Erro JSON padrão — mesmo envelope do `account_api_controller`. */
function apiErr(code: string, message: string) {
  return { error: { code, message } };
}

/** Papéis que podem administrar uma org no fluxo member-facing. */
const MANAGER_ROLES = new Set(['owner', 'admin']);

/** Contexto resolvido de um handler: config + store com orgs + a conta da sessão. */
interface OrgsApiContext {
  cfg: any;
  store: any;
  accountId: string;
}

export default class AccountOrgsApiController {
  // ─── POST /account/api/orgs ──────────────────────────────────────────────

  /** Criar uma org. Exige `allowSelfCreate` na política efetiva. */
  async createOrg(ctx: HttpContext) {
    const c = await this.#context(ctx);
    if (!c) return;

    const policy = await effectiveOrgPolicy(ctx, c.cfg);
    if (!policy.allowSelfCreate) {
      return ctx.response.forbidden(
        apiErr('self_create_disabled', 'Organization self-service creation is off.'),
      );
    }

    const name = String(ctx.request.input('name', '') ?? '').trim();
    const slug = String(ctx.request.input('slug', '') ?? '').trim();
    if (!name || !slug) {
      return ctx.response.badRequest(
        apiErr('invalid_input', 'Both `name` and `slug` are required.'),
      );
    }

    let org: { id: string; name: string; slug: string; logoUrl?: string | null };
    try {
      org = await c.store.createOrg({ name, slug, ownerAccountId: c.accountId });
    } catch {
      // O form engole o erro e redireciona; aqui a tela do host precisa poder
      // dizer "esse slug já existe" em vez de recarregar sem explicação.
      return ctx.response.conflict(apiErr('slug_taken', 'Slug already in use.'));
    }

    await c.cfg.audit?.record({
      type: 'organization.created',
      accountId: c.accountId,
      orgId: org.id,
      metadata: { slug },
    });

    ctx.response.status(201);
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      logoUrl: org.logoUrl ?? null,
      role: 'owner',
    };
  }

  // ─── POST /account/api/orgs/:id/activate ────────────────────────────────

  /** Define a org ativa (cookie `authkit_active_org`). Valida membership. */
  async activateOrg(ctx: HttpContext) {
    const c = await this.#context(ctx);
    if (!c) return;

    const orgId = String(ctx.request.param('id'));
    const membership = await c.store.getOrgMembership(orgId, c.accountId);
    // Não-membro e org inexistente respondem IGUAL (404 sem detalhe): distinguir
    // as duas vazaria a existência de orgs de terceiros.
    if (!membership) {
      return ctx.response.notFound(apiErr('not_found', 'Organization not found or not a member.'));
    }
    const org = await c.store.findOrgById(orgId);
    if (!org) {
      return ctx.response.notFound(apiErr('not_found', 'Organization not found or not a member.'));
    }

    ctx.response.cookie(
      ACTIVE_ORG_COOKIE,
      encodeActiveOrgCookie({ orgId, orgSlug: org.slug, orgRole: membership.role }),
      {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: ACTIVE_ORG_COOKIE_TTL,
        secure: ctx.request.secure(),
        path: '/',
      },
    );

    await c.cfg.audit?.record({
      type: 'organization.switched',
      accountId: c.accountId,
      orgId,
      metadata: { orgId, orgSlug: org.slug },
    });

    return { ok: true, activeOrgId: orgId, slug: org.slug, role: membership.role };
  }

  // ─── POST /account/api/orgs/deactivate ──────────────────────────────────

  /** Limpa a org ativa. Não depende de membership (só apaga o cookie). */
  async deactivateOrg(ctx: HttpContext) {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const accountId = ctx.session.get(ACCOUNT_SESSION_KEY) as string;

    ctx.response.clearCookie(ACTIVE_ORG_COOKIE, { path: '/' });
    await cfg.audit?.record({ type: 'organization.deactivated', accountId });
    return { ok: true, activeOrgId: null };
  }

  // ─── POST /account/api/orgs/:id/leave ───────────────────────────────────

  /** Sai da org. O store recusa o último owner (`reason: 'last_owner'`). */
  async leaveOrg(ctx: HttpContext) {
    const c = await this.#context(ctx);
    if (!c) return;

    const orgId = String(ctx.request.param('id'));
    const result = await c.store.removeOrgMember(orgId, c.accountId);
    if (!result.ok) {
      if (result.reason === 'last_owner') {
        return ctx.response
          .status(409)
          .send(apiErr('last_owner', 'The last owner cannot leave the organization.'));
      }
      return ctx.response.notFound(apiErr('not_found', 'Membership not found.'));
    }

    await c.cfg.audit?.record({
      type: 'organization.member_removed',
      accountId: c.accountId,
      orgId,
      metadata: { orgId, self: true },
    });
    return { ok: true, orgId };
  }

  // ─── POST /account/api/orgs/:id/invitations ─────────────────────────────

  /** Convida alguém por e-mail. Exige owner/admin; papel validado no catálogo. */
  async inviteMember(ctx: HttpContext) {
    const c = await this.#context(ctx);
    if (!c) return;

    const orgId = String(ctx.request.param('id'));
    const membership = await this.#requireManager(ctx, c.store, orgId, c.accountId);
    if (!membership) return;

    const email = String(ctx.request.input('email', '') ?? '').trim();
    const role = String(ctx.request.input('role', 'member') ?? 'member').trim();
    if (!email) {
      return ctx.response.badRequest(apiErr('invalid_input', '`email` is required.'));
    }

    const settings = await resolveRuntimeSettings(ctx);
    if (!(await isRoleInCatalog(role, settings, orgPolicyDefaults(c.cfg), orgId))) {
      return ctx.response.unprocessableEntity(apiErr('invalid_role', 'Role inválida.'));
    }
    // Só um OWNER concede `owner` — um admin tentando isso é escalonamento.
    if (role === 'owner' && membership.role !== 'owner') {
      return ctx.response.forbidden(apiErr('forbidden', 'Only an owner can grant the owner role.'));
    }

    const policy = await effectiveOrgPolicy(ctx, c.cfg, orgId);
    const { invitation, token } = await c.store.createOrgInvitation({
      organizationId: orgId,
      email,
      role,
      invitedBy: c.accountId,
      ttlHours: policy.invitationTtlHours,
    });

    // Entrega best-effort, igual ao form: um e-mail que não sai NÃO desfaz o
    // convite (ele continua aceitável pela lista de convites do convidado).
    try {
      const org = await c.store.findOrgById(orgId);
      const acceptUrl = `${authkitOrigin(c.cfg)}${accountPath('orgs')}/invitations/${token}/accept`;
      const payload = {
        email,
        invitationId: invitation.id,
        orgName: org?.name ?? orgId,
        orgSlug: org?.slug ?? orgId,
        role,
        acceptUrl,
        token,
      };
      if (c.cfg.mail?.onOrgInvitation) await c.cfg.mail.onOrgInvitation(payload);
      else await sendOrgInvitationEmail(ctx, payload);
    } catch {
      /* best-effort */
    }

    await c.cfg.audit?.record({
      type: 'organization.invitation_sent',
      accountId: c.accountId,
      orgId,
      metadata: { orgId, email, role },
    });

    ctx.response.status(201);
    return {
      id: invitation.id,
      organizationId: orgId,
      email: invitation.email ?? email,
      role,
      expiresAt: invitation.expiresAt ?? null,
      createdAt: invitation.createdAt ?? null,
      // O TOKEN NÃO VOLTA. Ele é a credencial de aceite e viaja por e-mail; um
      // admin que o lesse na resposta entraria na org como o convidado.
    };
  }

  // ─── DELETE /account/api/orgs/:id/invitations/:invId ────────────────────

  /** Revoga um convite pendente. Escopado por org (anti-IDOR), como o form. */
  async revokeInvitation(ctx: HttpContext) {
    const c = await this.#context(ctx);
    if (!c) return;

    const orgId = String(ctx.request.param('id'));
    const invId = String(ctx.request.param('invId'));
    const membership = await this.#requireManager(ctx, c.store, orgId, c.accountId);
    if (!membership) return;

    const revoked = await c.store.revokeInvitation(orgId, invId);
    if (!revoked) {
      return ctx.response.notFound(
        apiErr('not_found', 'Invitation not found in this organization.'),
      );
    }

    await c.cfg.audit?.record({
      type: 'organization.invitation_revoked',
      actorId: c.accountId,
      orgId,
      metadata: { orgId, invitationId: invId },
    });
    return { ok: true, revoked: invId };
  }

  // ─── DELETE /account/api/orgs/:id/members/:accountId ────────────────────

  /** Remove um membro. Exige owner/admin na org. */
  async removeMember(ctx: HttpContext) {
    const c = await this.#context(ctx);
    if (!c) return;

    const orgId = String(ctx.request.param('id'));
    const targetId = String(ctx.request.param('accountId'));
    const membership = await this.#requireManager(ctx, c.store, orgId, c.accountId);
    if (!membership) return;

    const result = await c.store.removeOrgMember(orgId, targetId);
    if (!result.ok) {
      if (result.reason === 'last_owner') {
        return ctx.response
          .status(409)
          .send(apiErr('last_owner', 'The last owner cannot be removed.'));
      }
      return ctx.response.notFound(apiErr('not_found', 'Member not found in this organization.'));
    }

    await c.cfg.audit?.record({
      type: 'organization.member_removed',
      actorId: c.accountId,
      orgId,
      metadata: { orgId, targetAccountId: targetId },
    });
    return { ok: true, orgId, accountId: targetId };
  }

  // ─── PATCH /account/api/orgs/:id/members/:accountId ─────────────────────

  /**
   * Troca o papel de um membro.
   *
   * Não existe equivalente member-facing em formulário (o console HTML só
   * troca papel pelo caminho ADMIN). As regras vieram, então, da interseção
   * das duas superfícies que já existem: o guard de owner/admin + catálogo de
   * papéis do `invite` member-facing, e a checagem de `last_owner` do
   * `AdminOrgsService.updateMemberRole`. Conceder `owner` continua privativo
   * de um owner.
   */
  async updateMemberRole(ctx: HttpContext) {
    const c = await this.#context(ctx);
    if (!c) return;

    const orgId = String(ctx.request.param('id'));
    const targetId = String(ctx.request.param('accountId'));
    const membership = await this.#requireManager(ctx, c.store, orgId, c.accountId);
    if (!membership) return;

    const role = String(ctx.request.input('role', '') ?? '').trim();
    if (!role) {
      return ctx.response.badRequest(apiErr('invalid_input', '`role` is required.'));
    }

    const settings = await resolveRuntimeSettings(ctx);
    if (!(await isRoleInCatalog(role, settings, orgPolicyDefaults(c.cfg), orgId))) {
      return ctx.response.unprocessableEntity(apiErr('invalid_role', 'Role inválida.'));
    }
    if (role === 'owner' && membership.role !== 'owner') {
      return ctx.response.forbidden(apiErr('forbidden', 'Only an owner can grant the owner role.'));
    }

    const result = await c.store.updateOrgMemberRole(orgId, targetId, role);
    if (!result.ok) {
      if (result.reason === 'last_owner') {
        return ctx.response
          .status(409)
          .send(apiErr('last_owner', 'The last owner cannot be demoted.'));
      }
      return ctx.response.notFound(apiErr('not_found', 'Member not found in this organization.'));
    }

    await c.cfg.audit?.record({
      type: 'organization.member_role_updated',
      actorId: c.accountId,
      orgId,
      metadata: { orgId, targetAccountId: targetId, role },
    });
    return { ok: true, orgId, accountId: targetId, role };
  }

  // ─── POST /account/api/orgs/invitations/:token/accept ───────────────────

  /**
   * Aceita um convite pelo token do e-mail.
   *
   * Diferente do form (montado FORA do guard para tratar o não-autenticado com
   * um redirect para o login), esta rota vive DENTRO do `accountGuard`: uma
   * tela SPA já está logada, e a resposta a um visitante anônimo aqui teria de
   * ser 401 em JSON, não uma navegação.
   */
  async acceptInvitation(ctx: HttpContext) {
    const c = await this.#context(ctx);
    if (!c) return;

    const token = String(ctx.request.param('token') ?? '');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const invitation = await c.store.findInvitationByTokenHash(tokenHash);
    if (!invitation) {
      return ctx.response.notFound(apiErr('not_found', 'Invitation not found.'));
    }

    const result = await c.store.acceptInvitation(invitation.id, c.accountId);
    if (!result.ok) {
      // Os motivos vêm do store e são os MESMOS que o form recebe (e descarta
      // no redirect): o caminho JSON só deixa de escondê-los.
      const status =
        result.reason === 'expired' ? 410 : result.reason === 'email_mismatch' ? 403 : 409;
      return ctx.response
        .status(status)
        .send(apiErr(result.reason ?? 'accept_failed', 'Invitation could not be accepted.'));
    }

    await c.cfg.audit?.record({
      type: 'organization.invitation_accepted',
      accountId: c.accountId,
      orgId: invitation.organizationId,
      metadata: { orgId: invitation.organizationId, invitationId: invitation.id },
    });
    return { ok: true, organizationId: invitation.organizationId, role: invitation.role };
  }

  // ─── Internos ───────────────────────────────────────────────────────────

  /**
   * Resolve config + store (com orgs) + a conta da sessão. Quando o
   * pré-requisito falha, JÁ RESPONDE e devolve `null` — o caller só precisa de
   * `if (!c) return`.
   */
  async #context(ctx: HttpContext): Promise<OrgsApiContext | null> {
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;

    if (!supportsOrganizations(store)) {
      ctx.response.notFound(apiErr('not_supported', 'Organizations not supported.'));
      return null;
    }
    const accountId = ctx.session.get(ACCOUNT_SESSION_KEY) as string | undefined;
    if (!accountId) {
      ctx.response.unauthorized(apiErr('unauthorized', 'Not authenticated.'));
      return null;
    }
    return { cfg, store, accountId };
  }

  /**
   * Exige que o ator seja owner/admin NA ORG DO PATH. Responde 403 e devolve
   * `null` quando não é.
   *
   * 403 e não 404: as duas negativas — "é membro sem poder" e "não é membro" —
   * saem com o MESMO status, então a resposta não diz a um estranho se a org
   * existe. Saber que lhe falta papel numa org da qual já é membro não lhe
   * conta nada novo.
   */
  async #requireManager(ctx: HttpContext, store: any, orgId: string, actorId: string) {
    const membership = await store.getOrgMembership(orgId, actorId);
    if (!membership || !MANAGER_ROLES.has(membership.role)) {
      ctx.response.forbidden(apiErr('forbidden', 'Owner or admin role required.'));
      return null;
    }
    return membership as { role: string };
  }
}
