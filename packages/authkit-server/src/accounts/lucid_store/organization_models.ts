import { BaseModel, column } from '@adonisjs/lucid/orm';
import type { DateTime } from 'luxon';

/**
 * Models default das três tabelas de organizations.
 *
 * Estas tabelas são LIB-OWNED: quem as cria e evolui é o `ensureAuthkitSchema`
 * (ver `TABLES` em `src/schema/ensure.ts`). Exigir que cada host reescrevesse
 * este mapeamento à mão rendia duas coisas ruins — boilerplate sem nenhuma
 * decisão do host, e drift silencioso: uma coluna nova nestas tabelas chega
 * pelo `autoManage` sem que o model escrito à mão no host saiba dela, e o
 * sintoma aparece longe da causa.
 *
 * Use com `organizationModels: true` em {@link lucidAccountStore}. O caminho
 * explícito (`{ OrgModel, MemberModel, InvitationModel }`) continua valendo como
 * escape hatch — é para quem guarda as tabelas de auth numa conexão/schema
 * próprios (`static connection = 'auth'`), que estes defaults não declaram.
 *
 * Não crie migration para estas tabelas: elas são criadas/atualizadas pelo
 * `schema.autoManage` do authkit.
 */
export class AuthOrganization extends BaseModel {
  static table = 'auth_organizations';

  /** Os ids são sempre fornecidos pelo builder (randomUUID) — nunca pelo banco. */
  static selfAssignPrimaryKey = true;

  @column({ isPrimary: true })
  declare id: string;

  @column()
  declare name: string;

  @column()
  declare slug: string;

  @column()
  declare logoUrl: string | null;

  /**
   * Coluna `json`. O contrato público (`OrgSummary.metadata`) já é
   * `Record<string, unknown> | null`, e é o que o builder grava/lê — declarar o
   * mesmo aqui mantém o model alinhado ao que a lib promete.
   */
  @column()
  declare metadata: Record<string, unknown> | null;

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime | null;

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null;
}

export class AuthOrganizationMember extends BaseModel {
  static table = 'auth_organization_members';

  static selfAssignPrimaryKey = true;

  @column({ isPrimary: true })
  declare id: string;

  @column()
  declare organizationId: string;

  @column()
  declare accountId: string;

  @column()
  declare role: string;

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime | null;

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null;
}

export class AuthOrganizationInvitation extends BaseModel {
  static table = 'auth_organization_invitations';

  static selfAssignPrimaryKey = true;

  @column({ isPrimary: true })
  declare id: string;

  @column()
  declare organizationId: string;

  @column()
  declare email: string;

  @column()
  declare role: string;

  @column()
  declare tokenHash: string;

  @column()
  declare invitedBy: string;

  @column.dateTime()
  declare expiresAt: DateTime;

  @column.dateTime()
  declare acceptedAt: DateTime | null;

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime | null;

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null;
}

/** O trio que {@link lucidAccountStore} aceita em `organizationModels: true`. */
export const defaultOrganizationModels = {
  OrgModel: AuthOrganization,
  MemberModel: AuthOrganizationMember,
  InvitationModel: AuthOrganizationInvitation,
} as const;
