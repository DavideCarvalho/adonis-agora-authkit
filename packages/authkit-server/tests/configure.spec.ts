import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@japa/runner';

test.group('configure stubs', () => {
  test('stubsRoot resolve e os .stub existem no build', async ({ assert }) => {
    // depois de `pnpm build`, os stubs são copiados para build/stubs
    const { stubsRoot } = await import('../build/stubs/main.js');
    assert.isTrue(existsSync(join(stubsRoot, 'config/authkit.stub')));
    assert.isTrue(existsSync(join(stubsRoot, 'models/auth_user.stub')));
    assert.isTrue(existsSync(join(stubsRoot, 'migrations/create_auth_users_table.stub')));
  });

  test('migrations/create_auth_users_table.stub cria a tabela auth_users com as colunas que o model/mixins esperam (regressão)', async ({
    assert,
  }) => {
    // Nenhuma migration para `auth_users` era scaffoldada por `node ace configure`
    // (só o model era) — um host seguindo o getting-started ao pé da letra
    // quebrava no primeiro signup/login com "no such table: auth_users" (ou o
    // equivalente Postgres). As colunas abaixo têm que bater EXATAMENTE com
    // `stubs/models/auth_user.stub` + os dois mixins que ele compõe
    // (`withAuthUser`, `withCredentials`) — ver docs/account-store.mdx.
    const { stubsRoot } = await import('../build/stubs/main.js');
    const stubContent = readFileSync(
      join(stubsRoot, 'migrations/create_auth_users_table.stub'),
      'utf8',
    );
    assert.match(stubContent, /tableName = 'auth_users'/);
    // id: string, NÃO increments() — precisa aceitar o UUID do @beforeCreate.
    assert.match(stubContent, /table\.string\('id'\)\.notNullable\(\)\.primary\(\)/);
    assert.notMatch(stubContent, /increments\('id'\)/);
    // withAuthUser()
    assert.match(stubContent, /table\.string\('email'\)\.notNullable\(\)\.unique\(\)/);
    assert.match(stubContent, /table\.string\('password'\)\.notNullable\(\)/);
    assert.match(stubContent, /table\.json\('global_roles'\)/);
    // withCredentials()
    assert.match(stubContent, /table\.timestamp\('email_verified_at'/);
    assert.match(stubContent, /table\.string\('email_verification_token'\)\.nullable\(\)/);
    assert.match(stubContent, /table\.string\('password_reset_token'\)\.nullable\(\)/);
    assert.match(stubContent, /table\.timestamp\('password_reset_expires_at'/);
    // Coluna própria do model scaffoldado (não vem de mixin).
    assert.match(stubContent, /table\.string\('full_name'\)\.nullable\(\)/);
  });

  test('models/auth_user.stub gera um id real e tem a coluna fullName (regressão)', async ({
    assert,
  }) => {
    // Nem `withAuthUser()` nem `withCredentials()` declaram `id` ou o geram —
    // sem um hook @beforeCreate o Lucid insere NULL na coluna string `id` e o
    // model volta com o rowid interno do banco, tornando a conta inalcançável
    // pelo id real na request seguinte. A tela de signup embutida também
    // sempre coleta "Nome" e o Lucid store passa isso para
    // `AuthUser.create({ fullName, ... })` — sem a coluna, o primeiro signup
    // quebra. Ver packages/authkit-server/stubs/models/auth_user.stub.
    const { stubsRoot } = await import('../build/stubs/main.js');
    const stubContent = readFileSync(join(stubsRoot, 'models/auth_user.stub'), 'utf8');
    assert.match(stubContent, /@beforeCreate\(\)/);
    assert.match(stubContent, /\.id\s*=\s*randomUUID\(\)/);
    assert.match(stubContent, /declare fullName: string \| null/);
    // `@beforeCreate` alone is not enough: without this flag Lucid overwrites
    // the assigned UUID with the database's raw INSERT result (the internal
    // rowid) right after save — same failure mode as no hook at all. See
    // tests/e2e/scaffolded_auth_users_migration.spec.ts for the end-to-end
    // regression (this exact combination, migrated + inserted for real).
    assert.match(stubContent, /static selfAssignPrimaryKey = true/);
  });

  test('stubs React (páginas + auth_shell) existem no build', async ({ assert }) => {
    const { stubsRoot } = await import('../build/stubs/main.js');
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    assert.isTrue(existsSync(join(stubsRoot, 'ui/react/components/auth_shell.tsx')));
    assert.isTrue(existsSync(join(stubsRoot, 'ui/react/pages/login.tsx')));
    assert.isTrue(existsSync(join(stubsRoot, 'ui/react/pages/consent.tsx')));
    assert.isTrue(existsSync(join(stubsRoot, 'ui/react/pages/signup.tsx')));
    assert.isTrue(existsSync(join(stubsRoot, 'ui/react/pages/forgot.tsx')));
    assert.isTrue(existsSync(join(stubsRoot, 'ui/react/pages/reset.tsx')));
    assert.isTrue(existsSync(join(stubsRoot, 'ui/react/pages/account/login.tsx')));
    assert.isTrue(existsSync(join(stubsRoot, 'ui/react/pages/account/tokens.tsx')));
  });
});
