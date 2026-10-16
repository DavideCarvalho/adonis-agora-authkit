import { BaseModel } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import { defaultOrganizationModels } from '../../src/accounts/lucid_store/organization_models.js';
import { ensureAuthkitSchema } from '../../src/schema/ensure.js';
import { createTestDatabase } from '../bootstrap.js';

/**
 * Guarda contra o drift da #199: os models default de organizations e as tabelas
 * que o `ensureAuthkitSchema` cria são duas definições do MESMO schema. Uma coluna
 * nova em `TABLES` sem o `@column` correspondente (ou o contrário) não quebra o
 * boot — o `autoManage` aplica a coluna, o model simplesmente não a lê nem grava,
 * e o sintoma aparece longe da causa. Este teste compara as duas definições
 * contra o banco real, para a divergência falhar AQUI.
 */
test.group('organizations — models default x tabelas do ensureAuthkitSchema', (group) => {
  let db: ReturnType<typeof createTestDatabase>;

  group.each.setup(() => {
    db = createTestDatabase();
    BaseModel.useAdapter(db.modelAdapter());
    return () => db.manager.closeAll();
  });

  for (const [key, Model] of Object.entries(defaultOrganizationModels)) {
    test(`${key} (${Model.table}) mapeia exatamente as colunas da tabela`, async ({ assert }) => {
      await ensureAuthkitSchema(db);
      Model.boot();

      const tableColumns = Object.keys(
        await db.connection().getWriteClient()(Model.table).columnInfo(),
      );
      const modelColumns = [...Model.$columnsDefinitions.values()].map((c) => c.columnName);

      assert.sameMembers(
        modelColumns,
        tableColumns,
        `${Model.name} divergiu de ${Model.table} em src/schema/ensure.ts`,
      );
    });
  }

  test('o trio default aponta para as três tabelas de organizations da lib', ({ assert }) => {
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(defaultOrganizationModels).map(([key, Model]) => [key, Model.table]),
      ),
      {
        OrgModel: 'auth_organizations',
        MemberModel: 'auth_organization_members',
        InvitationModel: 'auth_organization_invitations',
      },
    );
  });
});
