import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@japa/runner';

test.group('configure stubs', () => {
  test('stubsRoot resolve e os .stub existem no build', async ({ assert }) => {
    // depois de `pnpm build`, os stubs são copiados para build/stubs
    const { stubsRoot } = await import('../build/stubs/main.js');
    assert.isTrue(existsSync(join(stubsRoot, 'config/authkit.stub')));
    assert.isTrue(existsSync(join(stubsRoot, 'models/auth_user.stub')));
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
