import { createHash, randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import type {
  OrganizationsCapability,
  OrgInvitation,
  OrgMember,
  OrgSummary,
} from '../account_store.js';

/**
 * Contexto mínimo para o builder de organizations. Recebe os três models direto
 * (já construídos pelo lucidAccountStore após o hasTable probing).
 */
export interface OrgStoreContext {
  OrgModel: any;
  MemberModel: any;
  InvitationModel: any;
  /** Mapa accountId → email, para validar aceitação de convite. */
  findAccountEmail: (accountId: string) => Promise<string | null>;
}

function toOrgSummary(row: any): OrgSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    logoUrl: row.logoUrl ?? null,
    metadata: row.metadata ?? null,
    createdAt: toDateStr(row.createdAt),
  };
}

function toDateStr(val: any): string {
  if (!val) return new Date().toISOString();
  if (typeof val === 'object' && 'toISO' in val)
    return (val as any).toISO() ?? new Date().toISOString();
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

function toDateStrOrNull(val: any): string | null {
  if (!val) return null;
  if (typeof val === 'object' && 'toISO' in val) return (val as any).toISO() ?? null;
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

function toOrgInvitation(row: any): OrgInvitation {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    role: row.role,
    invitedBy: row.invitedBy,
    expiresAt: toDateStr(row.expiresAt),
    acceptedAt: toDateStrOrNull(row.acceptedAt),
    createdAt: toDateStr(row.createdAt),
  };
}

/** Conta os owners ativos de uma org. */
async function countOwners(MemberModel: any, orgId: string): Promise<number> {
  const result = await MemberModel.query()
    .where('organization_id', orgId)
    .where('role', 'owner')
    .count('* as total');
  return Number(result[0]?.$extras?.total ?? 0);
}

export function buildOrganizations(ctx: OrgStoreContext): OrganizationsCapability {
  const { OrgModel, MemberModel, InvitationModel, findAccountEmail } = ctx;

  return {
    async createOrg(input) {
      const { randomUUID } = await import('node:crypto');
      const org = await OrgModel.create({
        id: randomUUID(),
        name: input.name,
        slug: input.slug,
        logoUrl: input.logoUrl ?? null,
        metadata: input.metadata ?? null,
      });
      // Cria a membership do owner automaticamente
      await MemberModel.create({
        id: randomUUID(),
        organizationId: org.id,
        accountId: input.ownerAccountId,
        role: 'owner',
      });
      return toOrgSummary(org);
    },

    async findOrgById(orgId) {
      const row = await OrgModel.find(orgId);
      return row ? toOrgSummary(row) : null;
    },

    async findOrgBySlug(slug) {
      const row = await OrgModel.query().where('slug', slug).first();
      return row ? toOrgSummary(row) : null;
    },

    async listOrgsForAccount(accountId) {
      const memberships = await MemberModel.query().where('account_id', accountId);
      const result: Array<OrgSummary & { role: string }> = [];
      for (const m of memberships) {
        const org = await OrgModel.find(m.organizationId);
        if (org) result.push({ ...toOrgSummary(org), role: m.role });
      }
      return result;
    },

    async updateOrg(orgId, patch) {
      const row = await OrgModel.find(orgId);
      if (!row) return null;
      if (patch.name !== undefined) row.name = patch.name;
      if (patch.logoUrl !== undefined) row.logoUrl = patch.logoUrl;
      if (patch.metadata !== undefined) row.metadata = patch.metadata;
      await row.save();
      return toOrgSummary(row);
    },

    async deleteOrg(orgId) {
      const row = await OrgModel.find(orgId);
      if (!row) return false;
      await MemberModel.query().where('organization_id', orgId).delete();
      await InvitationModel.query().where('organization_id', orgId).delete();
      await row.delete();
      return true;
    },

    async listOrgMembers(orgId) {
      const rows = await MemberModel.query().where('organization_id', orgId);
      return rows.map(
        (r: any): OrgMember => ({
          accountId: r.accountId,
          email: null, // o caller enriquece com findById se necessário
          role: r.role,
          joinedAt: toDateStr(r.createdAt),
        }),
      );
    },

    async addOrgMember(orgId, accountId, role) {
      const { randomUUID } = await import('node:crypto');
      // Upsert: se já existe, atualiza a role
      const existing = await MemberModel.query()
        .where('organization_id', orgId)
        .where('account_id', accountId)
        .first();
      if (existing) {
        existing.role = role;
        await existing.save();
      } else {
        await MemberModel.create({ id: randomUUID(), organizationId: orgId, accountId, role });
      }
    },

    async removeOrgMember(orgId, accountId) {
      const row = await MemberModel.query()
        .where('organization_id', orgId)
        .where('account_id', accountId)
        .first();
      if (!row) return { ok: false, reason: 'not_found' as const };
      // Invariante: org deve ter sempre >= 1 owner
      if (row.role === 'owner') {
        const ownerCount = await countOwners(MemberModel, orgId);
        if (ownerCount <= 1) return { ok: false, reason: 'last_owner' as const };
      }
      await row.delete();
      return { ok: true };
    },

    async updateOrgMemberRole(orgId, accountId, newRole) {
      const row = await MemberModel.query()
        .where('organization_id', orgId)
        .where('account_id', accountId)
        .first();
      if (!row) return { ok: false, reason: 'not_found' as const };
      // Invariante: não rebaixa o último owner
      if (row.role === 'owner' && newRole !== 'owner') {
        const ownerCount = await countOwners(MemberModel, orgId);
        if (ownerCount <= 1) return { ok: false, reason: 'last_owner' as const };
      }
      row.role = newRole;
      await row.save();
      return { ok: true };
    },

    async getOrgMembership(orgId, accountId) {
      const row = await MemberModel.query()
        .where('organization_id', orgId)
        .where('account_id', accountId)
        .first();
      return row ? { role: row.role } : null;
    },

    async createOrgInvitation(input) {
      const { randomUUID } = await import('node:crypto');
      const token = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const expiresAt = DateTime.now().plus({ hours: input.ttlHours });
      const inv = await InvitationModel.create({
        id: randomUUID(),
        organizationId: input.organizationId,
        email: input.email,
        role: input.role,
        tokenHash,
        invitedBy: input.invitedBy,
        expiresAt,
        acceptedAt: null,
      });
      return { invitation: toOrgInvitation(inv), token };
    },

    async findInvitationByTokenHash(tokenHash) {
      const row = await InvitationModel.query().where('token_hash', tokenHash).first();
      return row ? toOrgInvitation(row) : null;
    },

    async listPendingInvitationsForOrg(orgId) {
      const rows = await InvitationModel.query()
        .where('organization_id', orgId)
        .whereNull('accepted_at');
      return rows.map(toOrgInvitation);
    },

    async listPendingInvitationsForEmail(email) {
      const rows = await InvitationModel.query().where('email', email).whereNull('accepted_at');
      return rows.map(toOrgInvitation);
    },

    async acceptInvitation(invitationId, accountId) {
      const inv = await InvitationModel.find(invitationId);
      if (!inv) return { ok: false, reason: 'not_found' as const };
      // Verifica expiração (expiresAt pode ser DateTime Luxon, Date, ou string do SQLite)
      let expiresMs: number;
      const rawExpiry = inv.expiresAt;
      if (rawExpiry && typeof rawExpiry === 'object' && 'toMillis' in rawExpiry) {
        expiresMs = (rawExpiry as any).toMillis();
      } else if (rawExpiry instanceof Date) {
        expiresMs = rawExpiry.getTime();
      } else if (rawExpiry) {
        // SQLite may return "YYYY-MM-DD HH:MM:SS" without T/Z
        const normalized =
          String(rawExpiry).replace(' ', 'T') + (String(rawExpiry).includes('Z') ? '' : 'Z');
        expiresMs = new Date(normalized).getTime();
      } else {
        expiresMs = 0;
      }
      if (Number.isNaN(expiresMs) || expiresMs < Date.now())
        return { ok: false, reason: 'expired' as const };
      // Verifica e-mail
      const accountEmail = await findAccountEmail(accountId);
      if (!accountEmail || accountEmail.toLowerCase() !== inv.email.toLowerCase()) {
        return { ok: false, reason: 'email_mismatch' as const };
      }
      // Verifica se já é membro
      const existing = await MemberModel.query()
        .where('organization_id', inv.organizationId)
        .where('account_id', accountId)
        .first();
      if (existing) {
        // Já membro: marca aceito mesmo assim (idempotência)
        inv.acceptedAt = DateTime.now();
        await inv.save();
        return { ok: true };
      }
      // Cria membership + marca accepted_at
      const { randomUUID } = await import('node:crypto');
      await MemberModel.create({
        id: randomUUID(),
        organizationId: inv.organizationId,
        accountId,
        role: inv.role,
      });
      inv.acceptedAt = DateTime.now();
      await inv.save();
      return { ok: true };
    },

    async revokeInvitation(organizationId, invitationId) {
      // Escopado por org: exige que o convite pertença à org informada antes de
      // deletar. Sem esse filtro, um owner/admin de qualquer org revogaria
      // convites de outra org sabendo apenas o invitationId (IDOR cross-org).
      const inv = await InvitationModel.query()
        .where('id', invitationId)
        .where('organization_id', organizationId)
        .first();
      if (!inv) return false;
      await inv.delete();
      return true;
    },

    async removeAccountFromAllOrgs(accountId) {
      // Memberships: remove todas, mesmo se for único owner (LGPD não pode bloquear)
      const memberships = await MemberModel.query().where('account_id', accountId);
      for (const m of memberships) {
        await m.delete();
      }
      // Convites (pendentes) para o e-mail da conta
      const email = await findAccountEmail(accountId);
      let invCount = 0;
      if (email) {
        const invitations = await InvitationModel.query()
          .where('email', email)
          .whereNull('accepted_at');
        for (const inv of invitations) {
          await inv.delete();
          invCount++;
        }
      }
      return { memberships: memberships.length, invitations: invCount };
    },
  };
}
