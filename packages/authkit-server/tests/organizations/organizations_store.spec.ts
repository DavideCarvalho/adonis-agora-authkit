import { randomUUID } from 'node:crypto';
import { compose } from '@adonisjs/core/helpers';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import { DateTime } from 'luxon';
import { supportsOrganizations } from '../../src/accounts/account_store.js';
import { lucidAccountStore } from '../../src/accounts/lucid_account_store.js';
import { withAuthUser } from '../../src/mixins/with_auth_user.js';
import { withCredentials } from '../../src/mixins/with_credentials.js';
import { createTestDatabase } from '../bootstrap.js';

class TestAccount extends compose(BaseModel, withAuthUser(), withCredentials()) {
  static table = 'users';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true }) declare id: string;
  @column() declare fullName: string | null;
  @column() declare avatarUrl: string | null;
  @beforeCreate()
  static assignId(row: TestAccount) {
    if (!row.id) row.id = randomUUID();
  }
}

class TestOrg extends BaseModel {
  static table = 'auth_organizations';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true }) declare id: string;
  @column() declare name: string;
  @column() declare slug: string;
  @column() declare logoUrl: string | null;
  @column() declare metadata: string | null;
  @column.dateTime({ autoCreate: true }) declare createdAt: DateTime;
  @column.dateTime({ autoCreate: true, autoUpdate: true }) declare updatedAt: DateTime;
}

class TestOrgMember extends BaseModel {
  static table = 'auth_organization_members';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true }) declare id: string;
  @column() declare organizationId: string;
  @column() declare accountId: string;
  @column() declare role: string;
  @column.dateTime({ autoCreate: true }) declare createdAt: DateTime;
}

class TestOrgInvitation extends BaseModel {
  static table = 'auth_organization_invitations';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true }) declare id: string;
  @column() declare organizationId: string;
  @column() declare email: string;
  @column() declare role: string;
  @column() declare tokenHash: string;
  @column() declare invitedBy: string;
  @column.dateTime() declare expiresAt: DateTime;
  @column.dateTime() declare acceptedAt: DateTime | null;
  @column.dateTime({ autoCreate: true }) declare createdAt: DateTime;
}

async function migrateWithOrgs(db: any) {
  BaseModel.useAdapter(db.modelAdapter());
  await db.connection().schema.createTable('users', (t: any) => {
    t.string('id').primary();
    t.string('email').notNullable();
    t.string('password').notNullable();
    t.string('full_name').nullable();
    t.string('avatar_url').nullable();
    t.text('global_roles').nullable();
    t.timestamp('email_verified_at').nullable();
    t.string('email_verification_token').nullable();
    t.string('password_reset_token').nullable();
    t.timestamp('password_reset_expires_at').nullable();
  });
  await db.connection().schema.createTable('auth_organizations', (t: any) => {
    t.string('id').primary();
    t.string('name').notNullable();
    t.string('slug').notNullable().unique();
    t.string('logo_url').nullable();
    t.text('metadata').nullable();
    t.timestamp('created_at').nullable();
    t.timestamp('updated_at').nullable();
  });
  await db.connection().schema.createTable('auth_organization_members', (t: any) => {
    t.string('id').primary();
    t.string('organization_id').notNullable();
    t.string('account_id').notNullable();
    t.string('role').notNullable();
    t.timestamp('created_at').nullable();
    /* a tabela real (TABLES em src/schema/ensure.ts) tem updated_at; sem ele
     * aqui o fixture mente sobre o schema e os models default — que são fiéis à
     * tabela real — quebram no INSERT. */
    t.timestamp('updated_at').nullable();
    t.unique(['organization_id', 'account_id']);
  });
  await db.connection().schema.createTable('auth_organization_invitations', (t: any) => {
    t.string('id').primary();
    t.string('organization_id').notNullable();
    t.string('email').notNullable();
    t.string('role').notNullable();
    t.string('token_hash').notNullable();
    t.string('invited_by').notNullable();
    t.timestamp('expires_at').notNullable();
    t.timestamp('accepted_at').nullable();
    t.timestamp('created_at').nullable();
    /* idem: updated_at existe na tabela real */
    t.timestamp('updated_at').nullable();
  });
}

async function migrateWithoutOrgs(db: any) {
  BaseModel.useAdapter(db.modelAdapter());
  await db.connection().schema.createTable('users', (t: any) => {
    t.string('id').primary();
    t.string('email').notNullable();
    t.string('password').notNullable();
    t.text('global_roles').nullable();
    t.timestamp('email_verified_at').nullable();
    t.string('email_verification_token').nullable();
    t.string('password_reset_token').nullable();
    t.timestamp('password_reset_expires_at').nullable();
  });
}

test.group('OrganizationsCapability — capability probing', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    return async () => db.manager.closeAll();
  });

  test('sem tabelas org → supportsOrganizations retorna false', async ({ assert }) => {
    await migrateWithoutOrgs(db);
    const store = lucidAccountStore(TestAccount, {});
    assert.isFalse(supportsOrganizations(store));
    assert.isUndefined((store as any).createOrg);
  });

  test('com tabelas org → supportsOrganizations retorna true', async ({ assert }) => {
    await migrateWithOrgs(db);
    const store = lucidAccountStore(TestAccount, {
      organizationModels: {
        OrgModel: TestOrg,
        MemberModel: TestOrgMember,
        InvitationModel: TestOrgInvitation,
      },
    });
    assert.isTrue(supportsOrganizations(store));
    assert.isFunction((store as any).createOrg);
  });
});

test.group('OrganizationsCapability — models default da lib', (group) => {
  let db: any;

  group.each.setup(async () => {
    db = createTestDatabase();
    return async () => db.manager.closeAll();
  });

  test('organizationModels: true liga a capability com os defaults, sem model no host', async ({
    assert,
  }) => {
    await migrateWithOrgs(db);
    const store = lucidAccountStore(TestAccount, { organizationModels: true }) as any;

    assert.isTrue(supportsOrganizations(store));
    assert.isFunction(store.createOrg);

    /* de ponta a ponta contra as tabelas reais — não só o type guard.
     * `metadata` fica fora daqui de propósito: o fixture cria a coluna como
     * `text` (sqlite) e o valor tipado é objeto — em Postgres a coluna é `json`
     * e o round-trip funciona (validado à parte, contra PG). */
    const account = await store.create({ email: 'owner@defaults.test', password: 'pass12345678' });
    const org = await store.createOrg({
      name: 'Defaults Corp',
      slug: 'defaults',
      ownerAccountId: account.id,
    });

    assert.equal(org.slug, 'defaults');
    assert.equal(org.logoUrl, null);

    assert.equal((await store.findOrgBySlug('defaults'))?.id, org.id);
    assert.equal((await store.getOrgMembership(org.id, account.id))?.role, 'owner');
    assert.lengthOf(await store.listOrgsForAccount(account.id), 1);
  });

  test('models default sem as tabelas → capability ligada e erro ALTO no uso', async ({
    assert,
  }) => {
    /**
     * Consequência de desenho, documentada de propósito: a capability depende de
     * `organizationModels`, não de as tabelas existirem. Quem liga os defaults num
     * banco sem as tabelas (host com `schema.autoManage: false` que não migrou)
     * recebe erro na primeira chamada — barulhento, que é o que queremos; o
     * silêncio era o problema do opt-in ausente.
     */
    await migrateWithoutOrgs(db);
    const store = lucidAccountStore(TestAccount, { organizationModels: true }) as any;

    assert.isTrue(supportsOrganizations(store));
    await assert.rejects(() => store.createOrg({ name: 'X', slug: 'x', ownerAccountId: 'a1' }));
  });

  test('caminho explícito continua funcionando (escape hatch)', async ({ assert }) => {
    await migrateWithOrgs(db);
    const store = lucidAccountStore(TestAccount, {
      organizationModels: {
        OrgModel: TestOrg,
        MemberModel: TestOrgMember,
        InvitationModel: TestOrgInvitation,
      },
    }) as any;

    assert.isTrue(supportsOrganizations(store));
    const account = await store.create({ email: 'owner@explicit.test', password: 'pass12345678' });
    const org = await store.createOrg({
      name: 'Explicit',
      slug: 'explicit',
      ownerAccountId: account.id,
    });
    assert.equal(org.slug, 'explicit');
  });
});

test.group('OrganizationsCapability — CRUD de org', (group) => {
  let db: any;
  let store: any;
  let account: any;

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrateWithOrgs(db);
    store = lucidAccountStore(TestAccount, {
      organizationModels: {
        OrgModel: TestOrg,
        MemberModel: TestOrgMember,
        InvitationModel: TestOrgInvitation,
      },
    });
    account = await store.create({ email: 'owner@acme.test', password: 'pass12345678' });
    return async () => db.manager.closeAll();
  });

  test('createOrg cria org + membership owner para ownerAccountId', async ({ assert }) => {
    const org = await store.createOrg({
      name: 'Acme Corp',
      slug: 'acme',
      ownerAccountId: account.id,
    });
    assert.equal(org.name, 'Acme Corp');
    assert.equal(org.slug, 'acme');
    const membership = await store.getOrgMembership(org.id, account.id);
    assert.equal(membership?.role, 'owner');
  });

  test('createOrg falha com slug duplicado', async ({ assert }) => {
    await store.createOrg({ name: 'Acme', slug: 'dupe', ownerAccountId: account.id });
    await assert.rejects(() =>
      store.createOrg({ name: 'Acme2', slug: 'dupe', ownerAccountId: account.id }),
    );
  });

  test('findOrgById e findOrgBySlug retornam org ou null', async ({ assert }) => {
    const org = await store.createOrg({ name: 'X', slug: 'x-slug', ownerAccountId: account.id });
    assert.equal((await store.findOrgById(org.id))?.slug, 'x-slug');
    assert.equal((await store.findOrgBySlug('x-slug'))?.id, org.id);
    assert.isNull(await store.findOrgById('ghost'));
    assert.isNull(await store.findOrgBySlug('ghost'));
  });

  test('listOrgsForAccount retorna orgs com role', async ({ assert }) => {
    await store.createOrg({ name: 'A', slug: 'a-org', ownerAccountId: account.id });
    await store.createOrg({ name: 'B', slug: 'b-org', ownerAccountId: account.id });
    const orgs = await store.listOrgsForAccount(account.id);
    assert.lengthOf(orgs, 2);
    assert.isTrue(orgs.every((o: any) => o.role === 'owner'));
  });

  test('updateOrg atualiza campos', async ({ assert }) => {
    const org = await store.createOrg({ name: 'Old', slug: 'old', ownerAccountId: account.id });
    const updated = await store.updateOrg(org.id, { name: 'New' });
    assert.equal(updated?.name, 'New');
  });

  test('deleteOrg remove org', async ({ assert }) => {
    const org = await store.createOrg({ name: 'Del', slug: 'del', ownerAccountId: account.id });
    assert.isTrue(await store.deleteOrg(org.id));
    assert.isNull(await store.findOrgById(org.id));
  });
});

test.group('OrganizationsCapability — membership invariantes', (group) => {
  let db: any;
  let store: any;
  let owner: any;
  let org: any;

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrateWithOrgs(db);
    store = lucidAccountStore(TestAccount, {
      organizationModels: {
        OrgModel: TestOrg,
        MemberModel: TestOrgMember,
        InvitationModel: TestOrgInvitation,
      },
    });
    owner = await store.create({ email: 'owner@acme.test', password: 'pass12345678' });
    org = await store.createOrg({ name: 'Acme', slug: 'acme', ownerAccountId: owner.id });
    return async () => db.manager.closeAll();
  });

  test('addOrgMember adiciona um segundo membro', async ({ assert }) => {
    const member = await store.create({ email: 'member@acme.test', password: 'pass12345678' });
    await store.addOrgMember(org.id, member.id, 'member');
    const members = await store.listOrgMembers(org.id);
    assert.lengthOf(members, 2);
  });

  test('addOrgMember é idempotente (unique constraint)', async ({ assert }) => {
    const member = await store.create({ email: 'm2@acme.test', password: 'pass12345678' });
    await store.addOrgMember(org.id, member.id, 'member');
    // Segunda chamada com mesma key não deve lançar (upsert)
    await store.addOrgMember(org.id, member.id, 'admin');
    const m = await store.getOrgMembership(org.id, member.id);
    assert.equal(m?.role, 'admin'); // role atualizada
  });

  test('último owner não pode ser removido', async ({ assert }) => {
    const result = await store.removeOrgMember(org.id, owner.id);
    assert.isFalse(result.ok);
    assert.equal(result.reason, 'last_owner');
  });

  test('último owner não pode ser rebaixado', async ({ assert }) => {
    const result = await store.updateOrgMemberRole(org.id, owner.id, 'member');
    assert.isFalse(result.ok);
    assert.equal(result.reason, 'last_owner');
  });

  test('owner pode ser removido se há outro owner', async ({ assert }) => {
    const owner2 = await store.create({ email: 'owner2@acme.test', password: 'pass12345678' });
    await store.addOrgMember(org.id, owner2.id, 'owner');
    const result = await store.removeOrgMember(org.id, owner.id);
    assert.isTrue(result.ok);
  });

  test('removeOrgMember retorna not_found para membro inexistente', async ({ assert }) => {
    const result = await store.removeOrgMember(org.id, 'ghost-id');
    assert.isFalse(result.ok);
    assert.equal(result.reason, 'not_found');
  });
});

test.group('OrganizationsCapability — convites', (group) => {
  let db: any;
  let store: any;
  let owner: any;
  let org: any;

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrateWithOrgs(db);
    store = lucidAccountStore(TestAccount, {
      organizationModels: {
        OrgModel: TestOrg,
        MemberModel: TestOrgMember,
        InvitationModel: TestOrgInvitation,
      },
    });
    owner = await store.create({ email: 'owner@acme.test', password: 'pass12345678' });
    org = await store.createOrg({ name: 'Acme', slug: 'acme', ownerAccountId: owner.id });
    return async () => db.manager.closeAll();
  });

  test('createOrgInvitation guarda hash no banco, retorna token plaintext', async ({ assert }) => {
    const { invitation, token } = await store.createOrgInvitation({
      organizationId: org.id,
      email: 'invite@example.com',
      role: 'member',
      invitedBy: owner.id,
      ttlHours: 24,
    });
    assert.isString(token);
    assert.isTrue(token.length > 20);
    // Hash no banco != token plaintext
    const row = await db
      .connection()
      .from('auth_organization_invitations')
      .where('id', invitation.id)
      .first();
    assert.notEqual(row.token_hash, token);
    // Mas findInvitationByTokenHash acha pelo hash
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(token).digest('hex');
    const found = await store.findInvitationByTokenHash(hash);
    assert.equal(found?.id, invitation.id);
  });

  test('aceitação de convite: cria membership, marca accepted_at', async ({ assert }) => {
    const { invitation } = await store.createOrgInvitation({
      organizationId: org.id,
      email: 'newmember@example.com',
      role: 'member',
      invitedBy: owner.id,
      ttlHours: 24,
    });
    const newMember = await store.create({
      email: 'newmember@example.com',
      password: 'pass12345678',
    });
    const result = await store.acceptInvitation(invitation.id, newMember.id);
    assert.isTrue(result.ok);
    const m = await store.getOrgMembership(org.id, newMember.id);
    assert.equal(m?.role, 'member');
    // accepted_at foi marcado
    const row = await db
      .connection()
      .from('auth_organization_invitations')
      .where('id', invitation.id)
      .first();
    assert.isNotNull(row.accepted_at);
  });

  test('aceitação rejeita se e-mail da conta não bate com o convite', async ({ assert }) => {
    const { invitation } = await store.createOrgInvitation({
      organizationId: org.id,
      email: 'specific@example.com',
      role: 'member',
      invitedBy: owner.id,
      ttlHours: 24,
    });
    const wrongAccount = await store.create({
      email: 'wrong@example.com',
      password: 'pass12345678',
    });
    const result = await store.acceptInvitation(invitation.id, wrongAccount.id);
    assert.isFalse(result.ok);
    assert.equal(result.reason, 'email_mismatch');
  });

  test('aceitação rejeita convite expirado', async ({ assert }) => {
    // Cria convite com ttlHours negativo para garantir expiração imediata
    const { invitation } = await store.createOrgInvitation({
      organizationId: org.id,
      email: 'exp@example.com',
      role: 'member',
      invitedBy: owner.id,
      ttlHours: -24, // expirado há 24 horas
    });
    const acc = await store.create({ email: 'exp@example.com', password: 'pass12345678' });
    const result = await store.acceptInvitation(invitation.id, acc.id);
    assert.isFalse(result.ok);
    assert.equal(result.reason, 'expired');
  });

  test('revokeInvitation marca convite como inexistente', async ({ assert }) => {
    const { invitation } = await store.createOrgInvitation({
      organizationId: org.id,
      email: 'rev@example.com',
      role: 'member',
      invitedBy: owner.id,
      ttlHours: 24,
    });
    assert.isTrue(await store.revokeInvitation(org.id, invitation.id));
    assert.isFalse(await store.revokeInvitation(org.id, invitation.id)); // já não existe
  });

  test('revokeInvitation é escopado por org: org A não revoga convite da org B (IDOR)', async ({
    assert,
  }) => {
    // Org B com seu próprio owner e convite pendente.
    const ownerB = await store.create({ email: 'ownerb@acme.test', password: 'pass12345678' });
    const orgB = await store.createOrg({ name: 'Beta', slug: 'beta', ownerAccountId: ownerB.id });
    const { invitation: invB } = await store.createOrgInvitation({
      organizationId: orgB.id,
      email: 'victim@example.com',
      role: 'member',
      invitedBy: ownerB.id,
      ttlHours: 24,
    });

    // Owner da org A tenta revogar o convite da org B passando o orgId da org A.
    const result = await store.revokeInvitation(org.id, invB.id);
    assert.isFalse(result, 'não deve deletar convite de outra org (not-found)');

    // Convite da org B continua existindo.
    const pendingB = await store.listPendingInvitationsForOrg(orgB.id);
    assert.lengthOf(pendingB, 1);
    assert.equal(pendingB[0].id, invB.id);

    // Owner da org B revoga o próprio convite → ok.
    assert.isTrue(await store.revokeInvitation(orgB.id, invB.id));
    assert.lengthOf(await store.listPendingInvitationsForOrg(orgB.id), 0);
  });

  test('listPendingInvitationsForOrg retorna apenas pendentes (sem accepted_at)', async ({
    assert,
  }) => {
    const { invitation: inv1 } = await store.createOrgInvitation({
      organizationId: org.id,
      email: 'p1@example.com',
      role: 'member',
      invitedBy: owner.id,
      ttlHours: 24,
    });
    await store.createOrgInvitation({
      organizationId: org.id,
      email: 'p2@example.com',
      role: 'member',
      invitedBy: owner.id,
      ttlHours: 24,
    });
    // Aceita o primeiro
    const acc = await store.create({ email: 'p1@example.com', password: 'pass12345678' });
    await store.acceptInvitation(inv1.id, acc.id);
    const pending = await store.listPendingInvitationsForOrg(org.id);
    assert.lengthOf(pending, 1);
    assert.equal(pending[0].email, 'p2@example.com');
  });
});

test.group('OrganizationsCapability — removeAccountFromAllOrgs (cascade LGPD)', (group) => {
  let db: any;
  let store: any;

  group.each.setup(async () => {
    db = createTestDatabase();
    await migrateWithOrgs(db);
    store = lucidAccountStore(TestAccount, {
      organizationModels: {
        OrgModel: TestOrg,
        MemberModel: TestOrgMember,
        InvitationModel: TestOrgInvitation,
      },
    });
    return async () => db.manager.closeAll();
  });

  test('removeAccountFromAllOrgs limpa memberships e convites do account', async ({ assert }) => {
    const owner = await store.create({ email: 'own@acme.test', password: 'pass12345678' });
    const target = await store.create({ email: 'target@acme.test', password: 'pass12345678' });
    const org1 = await store.createOrg({ name: 'O1', slug: 'o1', ownerAccountId: owner.id });
    const org2 = await store.createOrg({ name: 'O2', slug: 'o2', ownerAccountId: owner.id });
    // Adiciona target como membro
    await store.addOrgMember(org1.id, target.id, 'member');
    await store.addOrgMember(org2.id, target.id, 'admin');
    // Cria convite para o target
    await store.createOrgInvitation({
      organizationId: org1.id,
      email: target.email,
      role: 'member',
      invitedBy: owner.id,
      ttlHours: 24,
    });
    const result = await store.removeAccountFromAllOrgs(target.id);
    assert.equal(result.memberships, 2);
    assert.equal(result.invitations, 1);
    assert.isNull(await store.getOrgMembership(org1.id, target.id));
    assert.isNull(await store.getOrgMembership(org2.id, target.id));
  });

  test('quando account é único owner, a org NÃO é deletada — fica sem owner (auditado)', async ({
    assert,
  }) => {
    const soleOwner = await store.create({ email: 'sole@acme.test', password: 'pass12345678' });
    const org = await store.createOrg({
      name: 'Orphan',
      slug: 'orphan',
      ownerAccountId: soleOwner.id,
    });
    const result = await store.removeAccountFromAllOrgs(soleOwner.id);
    assert.equal(result.memberships, 1);
    // Org ainda existe (não bloqueou LGPD)
    assert.isNotNull(await store.findOrgById(org.id));
    // Mas não tem mais owners
    const members = await store.listOrgMembers(org.id);
    assert.lengthOf(members, 0);
  });
});
