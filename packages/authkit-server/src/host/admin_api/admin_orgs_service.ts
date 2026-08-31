import type { HttpContext } from '@adonisjs/core/http';
import type { OrgInvitation, OrgMember, OrgSummary } from '../../accounts/account_store.js';
import { supportsOrganizations } from '../../accounts/account_store.js';
import type { ResolvedServerConfig } from '../../define_config.js';
import { accountPath } from '../account_paths.js';
import { sendOrgInvitationEmail } from '../default_mailer.js';
import type { SettingsCapability } from '../runtime_settings.js';
import { isRoleInCatalog, resolveRoleCatalogList } from '../runtime_toggles.js';
import type { AdminActor } from './admin_users_service.js';

export interface OrgWithMemberCount extends OrgSummary {
  memberCount: number;
}

export interface OrgDetail extends OrgSummary {
  members: OrgMember[];
  pendingInvitations: OrgInvitation[];
}

export interface CreateOrgInput {
  name: string;
  slug: string;
  logoUrl?: string | null;
  /** accountId do owner inicial da org. */
  ownerAccountId: string;
}

export interface UpdateOrgInput {
  name?: string;
  logoUrl?: string | null;
}

export interface AddMemberInput {
  accountId: string;
  role: string;
}

export interface CreateInvitationInput {
  email: string;
  role: string;
}

export type OrgNotSupportedResult = { ok: false; reason: 'not_supported' };
export type OrgNotFoundResult = { ok: false; reason: 'not_found' };
export type LastOwnerResult = { ok: false; reason: 'last_owner' };
export type InvalidRoleResult = { ok: false; reason: 'invalid_role' };

/**
 * Lógica de gestão de organizações compartilhada entre o console admin (HTML)
 * e a Admin REST API (JSON). Usada pelos `AdminOrgsController` e `ApiOrgsController`.
 * Todos os métodos de escrita auditam com o `actor` informado.
 */
export class AdminOrgsService {
  constructor(private cfg: ResolvedServerConfig) {}

  get supported() {
    return supportsOrganizations(this.cfg.accountStore);
  }

  /**
   * Resolve o catálogo efetivo de roles de org (runtime settings → config →
   * defaults da lib), garantindo sempre a presença de `owner`. Fail-safe: sem
   * `settings`, usa o catálogo do config estático (`cfg.organizations`).
   */
  async resolveRoleCatalog(
    settings: SettingsCapability | null,
    orgId?: string | null,
  ): Promise<string[]> {
    return resolveRoleCatalogList(settings, this.orgPolicyConfigDefaults(), orgId);
  }

  /** Defaults estáticos de policy de org derivados do config do host. */
  private orgPolicyConfigDefaults() {
    return {
      roles: this.cfg.organizations.roles,
      allowSelfCreate: this.cfg.organizations.allowSelfCreate,
      invitationTtlHours: this.cfg.organizations.invitationTtlHours,
    };
  }

  /**
   * Valida um `role` de org contra o catálogo efetivo. Retorna `true` quando o
   * role faz parte do catálogo. H4: bloqueia roles fora do catálogo (incluindo
   * roles arbitrárias e, quando não catalogadas, `owner`).
   *
   * Delega ao helper PURO `isRoleInCatalog` de `runtime_toggles` — mesmo ponto de
   * verdade usado pelo caminho member-facing (`account_orgs_controller`).
   */
  async isRoleInCatalog(
    role: string,
    settings: SettingsCapability | null,
    orgId?: string | null,
  ): Promise<boolean> {
    return isRoleInCatalog(role, settings, this.orgPolicyConfigDefaults(), orgId);
  }

  /** Lista todas as orgs com contagem de membros. */
  async listOrgs(): Promise<OrgWithMemberCount[] | OrgNotSupportedResult> {
    const store = this.cfg.accountStore;
    if (!supportsOrganizations(store)) return { ok: false, reason: 'not_supported' };

    // O store não tem listAllOrgs — acumulamos via memberships de todas as contas.
    // Para admin, fazemos um listAccounts full e coletamos todas as orgs únicas.
    // Mais eficiente: usa a tabela de organizations diretamente pelo listOrgMembers
    // mas o store não expõe listAllOrgs. Usamos hack: listAccounts com limit alto,
    // coletamos orgs via listOrgsForAccount por conta.
    // Para evitar N+1 excessivo, usamos uma abordagem "seen" de IDs.
    const seen = new Map<string, OrgWithMemberCount>();
    let page = 1;
    const limit = 100;
    while (true) {
      const result = await store.listAccounts({ page, limit });
      for (const account of result.data) {
        const orgs = await store.listOrgsForAccount(account.id);
        for (const org of orgs) {
          if (!seen.has(org.id)) {
            // Conta membros
            const members = await store.listOrgMembers!(org.id);
            seen.set(org.id, { ...org, memberCount: members.length });
          }
        }
      }
      if (result.data.length < limit) break;
      page++;
    }
    return Array.from(seen.values());
  }

  /** Obtém uma org pelo id, com membros e convites pendentes. */
  async getOrg(orgId: string): Promise<OrgDetail | OrgNotSupportedResult | OrgNotFoundResult> {
    const store = this.cfg.accountStore;
    if (!supportsOrganizations(store)) return { ok: false, reason: 'not_supported' };

    const org = await store.findOrgById!(orgId);
    if (!org) return { ok: false, reason: 'not_found' };

    const [members, pendingInvitations] = await Promise.all([
      store.listOrgMembers!(orgId),
      store.listPendingInvitationsForOrg!(orgId),
    ]);

    // Enriquece membros com e-mail da conta
    const enrichedMembers = await Promise.all(
      members.map(async (m) => {
        const account = await store.findById(m.accountId);
        return { ...m, email: account?.email ?? null };
      }),
    );

    return { ...org, members: enrichedMembers, pendingInvitations };
  }

  /** Cria uma org. */
  async createOrg(
    input: CreateOrgInput,
    actor: AdminActor,
  ): Promise<OrgSummary | OrgNotSupportedResult | { ok: false; reason: 'slug_taken' }> {
    const store = this.cfg.accountStore;
    if (!supportsOrganizations(store)) return { ok: false, reason: 'not_supported' };

    try {
      const org = await store.createOrg!({
        name: input.name,
        slug: input.slug,
        logoUrl: input.logoUrl ?? null,
        ownerAccountId: input.ownerAccountId,
      });

      await this.cfg.audit?.record({
        type: 'organization.created',
        accountId: input.ownerAccountId,
        actorId: actor.actorId,
        ip: actor.ip,
        orgId: org.id,
        metadata: { slug: org.slug, ...(actor.source ? { actor: actor.source } : {}) },
      });

      return org;
    } catch {
      return { ok: false, reason: 'slug_taken' };
    }
  }

  /** Atualiza nome/logo de uma org. */
  async updateOrg(
    orgId: string,
    patch: UpdateOrgInput,
    actor: AdminActor,
  ): Promise<
    OrgSummary | OrgNotSupportedResult | OrgNotFoundResult | { ok: false; reason: 'slug_taken' }
  > {
    const store = this.cfg.accountStore;
    if (!supportsOrganizations(store)) return { ok: false, reason: 'not_supported' };

    const existing = await store.findOrgById!(orgId);
    if (!existing) return { ok: false, reason: 'not_found' };

    try {
      const updated = await store.updateOrg!(orgId, {
        name: patch.name,
        logoUrl: patch.logoUrl,
      });

      if (!updated) return { ok: false, reason: 'not_found' };

      await this.cfg.audit?.record({
        type: 'organization.updated',
        actorId: actor.actorId,
        ip: actor.ip,
        orgId,
        metadata: { orgId, ...(actor.source ? { actor: actor.source } : {}) },
      });

      return updated;
    } catch {
      return { ok: false, reason: 'slug_taken' };
    }
  }

  /** Deleta uma org e todos os seus dados (membros + convites). */
  async deleteOrg(
    orgId: string,
    actor: AdminActor,
  ): Promise<{ ok: true } | OrgNotSupportedResult | OrgNotFoundResult> {
    const store = this.cfg.accountStore;
    if (!supportsOrganizations(store)) return { ok: false, reason: 'not_supported' };

    const existing = await store.findOrgById!(orgId);
    if (!existing) return { ok: false, reason: 'not_found' };

    await store.deleteOrg!(orgId);

    await this.cfg.audit?.record({
      type: 'organization.deleted',
      actorId: actor.actorId,
      ip: actor.ip,
      orgId,
      metadata: { orgId, slug: existing.slug, ...(actor.source ? { actor: actor.source } : {}) },
    });

    return { ok: true };
  }

  /** Adiciona um membro a uma org. */
  async addMember(
    orgId: string,
    input: AddMemberInput,
    actor: AdminActor,
    settings: SettingsCapability | null = null,
  ): Promise<
    | { ok: true }
    | OrgNotSupportedResult
    | OrgNotFoundResult
    | InvalidRoleResult
    | { ok: false; reason: 'account_not_found' }
  > {
    const store = this.cfg.accountStore;
    if (!supportsOrganizations(store)) return { ok: false, reason: 'not_supported' };

    const org = await store.findOrgById!(orgId);
    if (!org) return { ok: false, reason: 'not_found' };

    // H4: valida o role contra o catálogo efetivo (runtime → config → defaults).
    if (!(await this.isRoleInCatalog(input.role, settings, orgId))) {
      return { ok: false, reason: 'invalid_role' };
    }

    const account = await store.findById(input.accountId);
    if (!account) return { ok: false, reason: 'account_not_found' };

    await store.addOrgMember!(orgId, input.accountId, input.role);

    await this.cfg.audit?.record({
      type: 'organization.member_added',
      actorId: actor.actorId,
      ip: actor.ip,
      orgId,
      metadata: {
        orgId,
        accountId: input.accountId,
        role: input.role,
        ...(actor.source ? { actor: actor.source } : {}),
      },
    });

    return { ok: true };
  }

  /** Remove um membro de uma org. Respeita invariante last_owner. */
  async removeMember(
    orgId: string,
    accountId: string,
    actor: AdminActor,
  ): Promise<
    | { ok: true }
    | OrgNotSupportedResult
    | OrgNotFoundResult
    | LastOwnerResult
    | { ok: false; reason: 'member_not_found' }
  > {
    const store = this.cfg.accountStore;
    if (!supportsOrganizations(store)) return { ok: false, reason: 'not_supported' };

    const org = await store.findOrgById!(orgId);
    if (!org) return { ok: false, reason: 'not_found' };

    const result = await store.removeOrgMember!(orgId, accountId);
    if (!result.ok) {
      if (result.reason === 'last_owner') return { ok: false, reason: 'last_owner' };
      return { ok: false, reason: 'member_not_found' };
    }

    await this.cfg.audit?.record({
      type: 'organization.member_removed',
      actorId: actor.actorId,
      ip: actor.ip,
      orgId,
      metadata: {
        orgId,
        targetAccountId: accountId,
        ...(actor.source ? { actor: actor.source } : {}),
      },
    });

    return { ok: true };
  }

  /** Troca o papel de um membro. Respeita invariante last_owner. */
  async updateMemberRole(
    orgId: string,
    accountId: string,
    newRole: string,
    actor: AdminActor,
    settings: SettingsCapability | null = null,
  ): Promise<
    | { ok: true }
    | OrgNotSupportedResult
    | OrgNotFoundResult
    | LastOwnerResult
    | InvalidRoleResult
    | { ok: false; reason: 'member_not_found' }
  > {
    const store = this.cfg.accountStore;
    if (!supportsOrganizations(store)) return { ok: false, reason: 'not_supported' };

    const org = await store.findOrgById!(orgId);
    if (!org) return { ok: false, reason: 'not_found' };

    // H4: valida o role-alvo contra o catálogo efetivo antes de promover/rebaixar.
    if (!(await this.isRoleInCatalog(newRole, settings, orgId))) {
      return { ok: false, reason: 'invalid_role' };
    }

    const result = await store.updateOrgMemberRole!(orgId, accountId, newRole);
    if (!result.ok) {
      if (result.reason === 'last_owner') return { ok: false, reason: 'last_owner' };
      return { ok: false, reason: 'member_not_found' };
    }

    await this.cfg.audit?.record({
      type: 'organization.member_role_changed',
      actorId: actor.actorId,
      ip: actor.ip,
      orgId,
      metadata: {
        orgId,
        targetAccountId: accountId,
        newRole,
        ...(actor.source ? { actor: actor.source } : {}),
      },
    });

    return { ok: true };
  }

  /**
   * Cria um convite por e-mail. Dispara o mail hook quando configurado.
   *
   * `ctx` is optional only for back-compat with callers that have no request in
   * hand; when given (both HTTP call sites do), the library default invitation
   * email is sent whenever the host defines no `mail.onOrgInvitation` hook.
   */
  async createInvitation(
    orgId: string,
    input: CreateInvitationInput,
    actor: AdminActor,
    origin: string,
    settings: SettingsCapability | null = null,
    ctx?: HttpContext,
  ): Promise<
    | { ok: true; invitation: OrgInvitation; token: string }
    | OrgNotSupportedResult
    | OrgNotFoundResult
    | InvalidRoleResult
  > {
    const store = this.cfg.accountStore;
    if (!supportsOrganizations(store)) return { ok: false, reason: 'not_supported' };

    const org = await store.findOrgById!(orgId);
    if (!org) return { ok: false, reason: 'not_found' };

    // H4: valida o role do convite contra o catálogo efetivo.
    if (!(await this.isRoleInCatalog(input.role, settings, orgId))) {
      return { ok: false, reason: 'invalid_role' };
    }

    const { invitation, token } = await store.createOrgInvitation!({
      organizationId: orgId,
      email: input.email,
      role: input.role,
      invitedBy: actor.actorId ?? 'admin',
      ttlHours: this.cfg.organizations.invitationTtlHours,
    });

    // Sends the invitation email (best-effort). The host hook wins when present;
    // otherwise the host-kit sends its own branded/translated email, like every
    // other email of the library. Delivery NEVER breaks invitation creation.
    try {
      const acceptUrl = `${origin}${accountPath('orgs')}/invitations/${token}/accept`;
      const payload = {
        email: input.email,
        invitationId: invitation.id,
        orgName: org.name,
        orgSlug: org.slug,
        role: input.role,
        acceptUrl,
        token,
      };
      if (this.cfg.mail?.onOrgInvitation) {
        await this.cfg.mail.onOrgInvitation(payload);
      } else if (ctx) {
        await sendOrgInvitationEmail(ctx, payload);
      }
    } catch {
      // best-effort
    }

    await this.cfg.audit?.record({
      type: 'organization.invitation_sent',
      actorId: actor.actorId,
      ip: actor.ip,
      orgId,
      metadata: {
        orgId,
        email: input.email,
        role: input.role,
        ...(actor.source ? { actor: actor.source } : {}),
      },
    });

    return { ok: true, invitation, token };
  }

  /** Revoga um convite. */
  async revokeInvitation(
    orgId: string,
    invitationId: string,
    actor: AdminActor,
  ): Promise<
    | { ok: true }
    | OrgNotSupportedResult
    | OrgNotFoundResult
    | { ok: false; reason: 'invitation_not_found' }
  > {
    const store = this.cfg.accountStore;
    if (!supportsOrganizations(store)) return { ok: false, reason: 'not_supported' };

    const org = await store.findOrgById!(orgId);
    if (!org) return { ok: false, reason: 'not_found' };

    // Escopado por org: o convite só é revogado se pertencer a esta org —
    // mesmo no Admin API global, evita revogar convite de outra org por id.
    const revoked = await store.revokeInvitation!(orgId, invitationId);
    if (!revoked) return { ok: false, reason: 'invitation_not_found' };

    await this.cfg.audit?.record({
      type: 'organization.invitation_revoked',
      actorId: actor.actorId,
      ip: actor.ip,
      orgId,
      metadata: {
        orgId,
        invitationId,
        ...(actor.source ? { actor: actor.source } : {}),
      },
    });

    return { ok: true };
  }
}
