import '../augmentations.js';
import type { HttpContext } from '@adonisjs/core/http';
import { supportsOrganizations } from '../../accounts/account_store.js';
import { getAccountLoginUrl } from '../account_login_url.js';
import { accountPath } from '../account_paths.js';
import { ACCOUNT_SESSION_KEY } from '../account_session_key.js';
import {
  ACTIVE_ORG_COOKIE,
  ACTIVE_ORG_COOKIE_TTL,
  encodeActiveOrgCookie,
} from '../active_org_cookie.js';
import { sendOrgInvitationEmail } from '../default_mailer.js';
import { authkitOrigin } from '../origin.js';
import { resolveRuntimeSettings } from '../runtime_settings.js';
import { isRoleInCatalog } from '../runtime_toggles.js';

/**
 * Console de conta — Organizations. Server-rendered, padrão dos outros controllers
 * de conta (account_tokens_controller, account_security_controller, etc.).
 *
 * Rotas montadas em register_auth_host quando supportsOrganizations(store) — capability-probed.
 * O guard `accountGuard` (já existente) protege todas as rotas de /account/* abaixo.
 */
export default class AccountOrgsController {
  async index(ctx: HttpContext) {
    const { session, response, request } = ctx;
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;
    const messages = cfg.messages;

    if (!supportsOrganizations(store)) {
      return cfg.render
        ? cfg.render(ctx, 'account/orgs', { supported: false, messages })
        : response.notFound();
    }

    const accountId = session.get(ACCOUNT_SESSION_KEY) as string;
    const account = await store.findById(accountId);
    if (!account) return response.redirect(getAccountLoginUrl());

    const orgs = await store.listOrgsForAccount(accountId);
    const pendingInvitations = await store.listPendingInvitationsForEmail!(account.email);

    // Enriquece convites com o nome da org
    const invitationsWithOrg = await Promise.all(
      pendingInvitations.map(async (inv) => {
        const org = await store.findOrgById!(inv.organizationId);
        return { ...inv, orgName: org?.name ?? inv.organizationId };
      }),
    );

    // Detecta org ativa do cookie
    const activeOrgRaw = request.cookie(ACTIVE_ORG_COOKIE);
    const activeOrgId = activeOrgRaw ? activeOrgRaw.split('\t')[0] : null;

    // Para cada org onde o user é owner/admin, carrega membros
    const orgsWithMembers = await Promise.all(
      orgs.map(async (org) => {
        const canManage = org.role === 'owner' || org.role === 'admin';
        const members = canManage ? await store.listOrgMembers!(org.id) : [];
        return { ...org, members, canManage, isActive: org.id === activeOrgId };
      }),
    );

    const props = {
      supported: true,
      orgs: orgsWithMembers,
      pendingInvitations: invitationsWithOrg,
      allowSelfCreate: cfg.organizations.allowSelfCreate,
      availableRoles: cfg.organizations.roles,
      messages,
    };

    return cfg.render ? cfg.render(ctx, 'account/orgs', props) : response.notFound();
  }

  /** POST /account/orgs — criar nova org (requer allowSelfCreate). */
  async store(ctx: HttpContext) {
    const { session, response, request } = ctx;
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;
    const accountId = session.get(ACCOUNT_SESSION_KEY) as string;

    if (!supportsOrganizations(store) || !cfg.organizations.allowSelfCreate) {
      return response.forbidden();
    }

    const name = request.input('name', '').trim();
    const slug = request.input('slug', '').trim();
    if (!name || !slug) return response.redirect(accountPath('orgs'));

    try {
      await store.createOrg!({ name, slug, ownerAccountId: accountId });
      await cfg.audit?.record({ type: 'organization.created', accountId, metadata: { slug } });
    } catch {
      // slug duplicado ou outro erro — redireciona sem mensagem de erro específica
    }
    return response.redirect(accountPath('orgs'));
  }

  /** POST /account/orgs/:id/activate — define org ativa (valida membership). */
  async activate(ctx: HttpContext) {
    const { session, response, params } = ctx;
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;
    const accountId = session.get(ACCOUNT_SESSION_KEY) as string;

    if (!supportsOrganizations(store)) return response.forbidden();

    const orgId = params.id;
    const membership = await store.getOrgMembership!(orgId, accountId);
    if (!membership) return response.redirect(accountPath('orgs'));

    const org = await store.findOrgById!(orgId);
    if (!org) return response.redirect(accountPath('orgs'));

    // Grava cookie de org ativa
    const cookieValue = encodeActiveOrgCookie({
      orgId,
      orgSlug: org.slug,
      orgRole: membership.role,
    });
    ctx.response.cookie(ACTIVE_ORG_COOKIE, cookieValue, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: ACTIVE_ORG_COOKIE_TTL,
      secure: ctx.request.secure(),
      path: '/',
    });

    await cfg.audit?.record({
      type: 'organization.switched',
      accountId,
      metadata: { orgId, orgSlug: org.slug },
    });
    return response.redirect(accountPath('orgs'));
  }

  /** POST /account/orgs/deactivate — remove org ativa. */
  async deactivate(ctx: HttpContext) {
    const { session, response } = ctx;
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const accountId = session.get(ACCOUNT_SESSION_KEY) as string;

    ctx.response.clearCookie(ACTIVE_ORG_COOKIE, { path: '/' });
    await cfg.audit?.record({ type: 'organization.deactivated', accountId });
    return response.redirect(accountPath('orgs'));
  }

  /** POST /account/orgs/:id/leave — sai da org (verifica last_owner). */
  async leave(ctx: HttpContext) {
    const { session, response, params } = ctx;
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;
    const accountId = session.get(ACCOUNT_SESSION_KEY) as string;

    if (!supportsOrganizations(store)) return response.forbidden();

    const result = await store.removeOrgMember!(params.id, accountId);
    if (result.ok) {
      await cfg.audit?.record({
        type: 'organization.member_removed',
        accountId,
        metadata: { orgId: params.id, self: true },
      });
    }
    return response.redirect(accountPath('orgs'));
  }

  /** POST /account/orgs/:id/invite — convida membro por e-mail. */
  async invite(ctx: HttpContext) {
    const { session, response, params, request } = ctx;
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;
    const accountId = session.get(ACCOUNT_SESSION_KEY) as string;

    if (!supportsOrganizations(store)) return response.forbidden();

    // Verifica que o invitador é owner ou admin
    const membership = await store.getOrgMembership!(params.id, accountId);
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      return response.forbidden();
    }

    const email = request.input('email', '').trim();
    const role = request.input('role', 'member').trim();
    if (!email) return response.redirect(accountPath('orgs'));

    // H4: valida o role contra o catálogo efetivo de roles da org (runtime →
    // config → defaults). Role fora do catálogo é rejeitada (não cria convite).
    // Usa o helper PURO `isRoleInCatalog` (mesmo ponto de verdade do caminho admin).
    const settings = await resolveRuntimeSettings(ctx);
    const roleValid = await isRoleInCatalog(
      role,
      settings,
      {
        roles: cfg.organizations.roles,
        allowSelfCreate: cfg.organizations.allowSelfCreate,
        invitationTtlHours: cfg.organizations.invitationTtlHours,
      },
      params.id,
    );
    if (!roleValid) {
      return response.unprocessableEntity({
        error: { code: 'invalid_role', message: 'Role inválida.' },
      });
    }

    // H4: no fluxo member-facing, só um OWNER pode conceder a role `owner`.
    // Um admin (não-owner) tentando convidar como `owner` é escalonamento.
    if (role === 'owner' && membership.role !== 'owner') {
      return response.forbidden();
    }

    const { invitation, token } = await store.createOrgInvitation!({
      organizationId: params.id,
      email,
      role,
      invitedBy: accountId,
      ttlHours: cfg.organizations.invitationTtlHours,
    });

    // Sends the invitation email (best-effort). The host hook wins when present;
    // otherwise the host-kit sends its own branded/translated email, like every
    // other email of the library. Delivery NEVER breaks invitation creation.
    try {
      const org = await store.findOrgById!(params.id);
      const acceptUrl = `${authkitOrigin(cfg)}${accountPath('orgs')}/invitations/${token}/accept`;
      const payload = {
        email,
        invitationId: invitation.id,
        orgName: org?.name ?? params.id,
        orgSlug: org?.slug ?? params.id,
        role,
        acceptUrl,
        token,
      };
      if (cfg.mail?.onOrgInvitation) {
        await cfg.mail.onOrgInvitation(payload);
      } else {
        await sendOrgInvitationEmail(ctx, payload);
      }
    } catch {
      // best-effort
    }

    await cfg.audit?.record({
      type: 'organization.invitation_sent',
      accountId,
      metadata: { orgId: params.id, email, role },
    });
    return response.redirect(accountPath('orgs'));
  }

  /** GET /account/orgs/invitations/:token/accept — mostra tela de aceite. */
  async showAcceptInvitation(ctx: HttpContext) {
    const { session, response, params } = ctx;
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;
    const { createHash } = await import('node:crypto');

    if (!supportsOrganizations(store)) return response.notFound();

    const accountId = session.get(ACCOUNT_SESSION_KEY) as string | undefined;
    if (!accountId) {
      // Não logado: redireciona para login (configurável) com return URL
      const loginUrl = getAccountLoginUrl();
      const returnTo = encodeURIComponent(
        `${accountPath('orgs')}/invitations/${params.token}/accept`,
      );
      const sep = loginUrl.includes('?') ? '&' : '?';
      return response.redirect(`${loginUrl}${sep}returnTo=${returnTo}`);
    }

    const tokenHash = createHash('sha256').update(params.token).digest('hex');
    const invitation = await store.findInvitationByTokenHash!(tokenHash);

    const props = {
      invitation,
      token: params.token,
      messages: cfg.messages,
    };

    return cfg.render
      ? cfg.render(ctx, 'account/orgs', { ...props, subview: 'accept-invitation' })
      : response.notFound();
  }

  /** POST /account/orgs/invitations/:token/accept — processa aceite. */
  async acceptInvitation(ctx: HttpContext) {
    const { session, response, params } = ctx;
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;
    const { createHash } = await import('node:crypto');

    if (!supportsOrganizations(store)) return response.notFound();

    const accountId = session.get(ACCOUNT_SESSION_KEY) as string | undefined;
    if (!accountId) return response.redirect(getAccountLoginUrl());

    const tokenHash = createHash('sha256').update(params.token).digest('hex');
    const invitation = await store.findInvitationByTokenHash!(tokenHash);
    if (!invitation) return response.redirect(accountPath('orgs'));

    const result = await store.acceptInvitation!(invitation.id, accountId);
    if (result.ok) {
      await cfg.audit?.record({
        type: 'organization.invitation_accepted',
        accountId,
        metadata: { orgId: invitation.organizationId, invitationId: invitation.id },
      });
    }
    return response.redirect(accountPath('orgs'));
  }

  /** POST /account/orgs/:id/members/:accountId/remove */
  async removeMember(ctx: HttpContext) {
    const { session, response, params } = ctx;
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;
    const actorId = session.get(ACCOUNT_SESSION_KEY) as string;

    if (!supportsOrganizations(store)) return response.forbidden();

    const actorMembership = await store.getOrgMembership!(params.id, actorId);
    if (
      !actorMembership ||
      (actorMembership.role !== 'owner' && actorMembership.role !== 'admin')
    ) {
      return response.forbidden();
    }

    const result = await store.removeOrgMember!(params.id, params.accountId);
    if (result.ok) {
      await cfg.audit?.record({
        type: 'organization.member_removed',
        actorId,
        metadata: { orgId: params.id, targetAccountId: params.accountId },
      });
    }
    return response.redirect(accountPath('orgs'));
  }

  /** POST /account/orgs/:id/invitations/:invId/revoke */
  async revokeInvitation(ctx: HttpContext) {
    const { session, response, params } = ctx;
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;
    const actorId = session.get(ACCOUNT_SESSION_KEY) as string;

    if (!supportsOrganizations(store)) return response.forbidden();

    const actorMembership = await store.getOrgMembership!(params.id, actorId);
    if (
      !actorMembership ||
      (actorMembership.role !== 'owner' && actorMembership.role !== 'admin')
    ) {
      return response.forbidden();
    }

    // Escopado por org (params.id já validado acima): impede IDOR cross-org.
    await store.revokeInvitation!(params.id, params.invId);
    await cfg.audit?.record({
      type: 'organization.invitation_revoked',
      actorId,
      metadata: { orgId: params.id, invitationId: params.invId },
    });
    return response.redirect(accountPath('orgs'));
  }

  // ──────────────────────────────────────────────────────────────────────────
  // JSON endpoints — consumed by @adonis-agora/authkit-react hooks.
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * GET /account/orgs/json — lista as orgs do usuário logado com papel + se ativa.
   * Usado pelo hook `useOrganizations()`.
   */
  async listJson(ctx: HttpContext) {
    const { session, response, request } = ctx;
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;

    if (!supportsOrganizations(store)) return { supported: false, orgs: [], activeOrgId: null };

    const accountId = session.get(ACCOUNT_SESSION_KEY) as string;
    if (!accountId) return response.unauthorized({ message: 'Not authenticated.' });

    const orgs = await store.listOrgsForAccount(accountId);

    const activeOrgRaw = request.cookie(ACTIVE_ORG_COOKIE);
    const activeOrgId = activeOrgRaw ? activeOrgRaw.split('\t')[0] : null;

    return {
      supported: true,
      activeOrgId,
      orgs: orgs.map((org) => ({
        id: org.id,
        name: org.name,
        slug: org.slug,
        logoUrl: org.logoUrl ?? null,
        role: org.role,
        isActive: org.id === activeOrgId,
      })),
    };
  }

  /**
   * GET /account/orgs/:id/json — detalhes da org ativa (para uso pelo hook `useOrganization()`).
   * Só retorna se o usuário é membro.
   */
  async showJson(ctx: HttpContext) {
    const { session, response, params } = ctx;
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;

    if (!supportsOrganizations(store)) return response.notFound({ message: 'Not supported.' });

    const accountId = session.get(ACCOUNT_SESSION_KEY) as string;
    if (!accountId) return response.unauthorized({ message: 'Not authenticated.' });

    const membership = await store.getOrgMembership!(params.id, accountId);
    if (!membership)
      return response.notFound({ message: 'Organization not found or not a member.' });

    const org = await store.findOrgById!(params.id);
    if (!org) return response.notFound({ message: 'Organization not found.' });

    const canManage = membership.role === 'owner' || membership.role === 'admin';
    const members = canManage ? await store.listOrgMembers!(params.id) : [];
    const enrichedMembers = await Promise.all(
      members.map(async (m) => {
        const account = await store.findById(m.accountId);
        return {
          accountId: m.accountId,
          email: account?.email ?? null,
          role: m.role,
          joinedAt: m.joinedAt,
        };
      }),
    );

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      logoUrl: org.logoUrl ?? null,
      role: membership.role,
      canManage,
      members: enrichedMembers,
    };
  }

  /**
   * GET /account/orgs/invitations/json — lista convites pendentes pro e-mail do usuário logado.
   * Usado pelo hook `useOrgInvitations()`.
   */
  async listInvitationsJson(ctx: HttpContext) {
    const { session, response } = ctx;
    const service = await ctx.containerResolver.make('authkit.server');
    const cfg = service.config;
    const store = cfg.accountStore;

    if (!supportsOrganizations(store)) return { invitations: [] };

    const accountId = session.get(ACCOUNT_SESSION_KEY) as string;
    if (!accountId) return response.unauthorized({ message: 'Not authenticated.' });

    const account = await store.findById(accountId);
    if (!account) return response.unauthorized({ message: 'Not authenticated.' });

    const invitations = await store.listPendingInvitationsForEmail!(account.email);
    const enriched = await Promise.all(
      invitations.map(async (inv) => {
        const org = await store.findOrgById!(inv.organizationId);
        return {
          id: inv.id,
          organizationId: inv.organizationId,
          orgName: org?.name ?? inv.organizationId,
          orgSlug: org?.slug ?? inv.organizationId,
          email: inv.email,
          role: inv.role,
          expiresAt: inv.expiresAt,
          createdAt: inv.createdAt,
        };
      }),
    );

    return { invitations: enriched };
  }
}
