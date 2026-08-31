import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { configProvider } from '@adonisjs/core';
import { compose } from '@adonisjs/core/helpers';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import { DateTime } from 'luxon';
import { lucidAccountStore } from '../../src/accounts/lucid_account_store.js';
import { adapters, defineConfig } from '../../src/define_config.js';
import { AccountDeletionService } from '../../src/host/account_deletion_service.js';
import { AccountExportService } from '../../src/host/account_export_service.js';
import { withAuthUser } from '../../src/mixins/with_auth_user.js';
import { withCredentials } from '../../src/mixins/with_credentials.js';
import { OidcService } from '../../src/provider/oidc_service.js';
import { createTestDatabase } from '../bootstrap.js';

class Account extends compose(BaseModel, withAuthUser(), withCredentials()) {
  static table = 'users';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true }) declare id: string;
  @column() declare fullName: string | null;
  @column() declare avatarUrl: string | null;
  @beforeCreate()
  static assignId(row: Account) {
    if (!row.id) row.id = randomUUID();
  }
}

class Org extends BaseModel {
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

class OrgMember extends BaseModel {
  static table = 'auth_organization_members';
  static selfAssignPrimaryKey = true;
  @column({ isPrimary: true }) declare id: string;
  @column() declare organizationId: string;
  @column() declare accountId: string;
  @column() declare role: string;
  @column.dateTime({ autoCreate: true }) declare createdAt: DateTime;
}

class OrgInvitation extends BaseModel {
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

async function migrate(db: any) {
  BaseModel.useAdapter(db.modelAdapter());
  await db.connection().schema.createTable('authkit_oidc_payloads', (t: any) => {
    t.string('id').notNullable();
    t.string('model_name').notNullable();
    t.text('payload').notNullable();
    t.string('grant_id').nullable();
    t.string('user_code').nullable();
    t.string('uid').nullable();
    t.timestamp('expires_at').nullable();
    t.primary(['model_name', 'id']);
  });
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
  });
}

async function startService(port: number, db: any) {
  const issuer = `http://localhost:${port}`;
  const fakeApp = { container: { make: async () => db } } as any;
  const store = lucidAccountStore(Account, {
    organizationModels: { OrgModel: Org, MemberModel: OrgMember, InvitationModel: OrgInvitation },
  });
  const cfg = await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer,
      adapter: adapters.database({}),
      jwks: { source: 'managed', algorithm: 'RS256' },
      clients: [
        {
          clientId: 'c1',
          clientSecret: 's',
          redirectUris: [`${issuer}/cb`],
          grants: ['authorization_code'],
        },
      ],
      accountStore: store,
    }),
  );
  const service = new OidcService(cfg!, 'a'.repeat(32));
  const server: Server = createServer(service.callback);
  await new Promise<void>((r) => server.listen(port, r));
  return { service, cfg: cfg!, server, store };
}

test.group('AccountDeletionService — org cascade', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    await migrate(db);
    return async () => db.manager.closeAll();
  });

  test('deleção remove memberships e convites, org sobrevive se havia outro owner', async ({
    assert,
    cleanup,
  }) => {
    const { service, server, store } = await startService(9893, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const victim = await store.create({ email: 'victim@acme.test', password: 'pass12345678' });
    const owner2 = await store.create({ email: 'owner2@acme.test', password: 'pass12345678' });

    const org = await (store as any).createOrg({
      name: 'Acme',
      slug: 'acme',
      ownerAccountId: victim.id,
    });
    await (store as any).addOrgMember(org.id, owner2.id, 'owner'); // segundo owner
    await (store as any).createOrgInvitation({
      organizationId: org.id,
      email: victim.email,
      role: 'admin',
      invitedBy: owner2.id,
      ttlHours: 24,
    });

    const result = await new AccountDeletionService(service).delete(victim.id, {
      actorId: victim.id,
      ip: null,
      source: 'self',
    });
    assert.isTrue(result.ok);

    // Org ainda existe (tinha outro owner)
    const orgAfter = await (store as any).findOrgById(org.id);
    assert.isNotNull(orgAfter);

    // Memberships do victim removidas
    const membership = await (store as any).getOrgMembership(org.id, victim.id);
    assert.isNull(membership);
  });

  test('deleção remove membership mesmo sendo único owner — org fica sem owner (LGPD não bloqueia)', async ({
    assert,
    cleanup,
  }) => {
    const { service, server, store } = await startService(9894, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const soleOwner = await store.create({ email: 'sole@acme.test', password: 'pass12345678' });
    const orphanOrg = await (store as any).createOrg({
      name: 'Orphan',
      slug: 'orphan',
      ownerAccountId: soleOwner.id,
    });

    const result = await new AccountDeletionService(service).delete(soleOwner.id, {
      actorId: soleOwner.id,
      ip: null,
      source: 'self',
    });
    assert.isTrue(result.ok);

    // Org sobrevive mas sem membros
    const orgAfter = await (store as any).findOrgById(orphanOrg.id);
    assert.isNotNull(orgAfter);
    const members = await (store as any).listOrgMembers(orphanOrg.id);
    assert.lengthOf(members, 0);
  });
});

test.group('AccountExportService — org memberships', (group) => {
  let db: any;
  group.each.setup(async () => {
    db = createTestDatabase();
    await migrate(db);
    return async () => db.manager.closeAll();
  });

  test('export inclui organizations do usuário', async ({ assert, cleanup }) => {
    const { service, server, store } = await startService(9895, db);
    cleanup(() => new Promise<void>((r) => server.close(() => r())));

    const account = await store.create({ email: 'me@acme.test', password: 'pass12345678' });
    await (store as any).createOrg({ name: 'MyOrg', slug: 'myorg', ownerAccountId: account.id });

    const exported = await new AccountExportService(service).export(account.id);
    assert.isNotNull(exported);
    assert.property(exported, 'organizations');
    assert.isArray((exported as any).organizations);
    assert.lengthOf((exported as any).organizations, 1);
    assert.equal((exported as any).organizations[0].name, 'MyOrg');
    assert.equal((exported as any).organizations[0].role, 'owner');
  });
});
