import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from '@japa/runner';

test.group('oidc_session_controller.stub', () => {
  async function readStub() {
    // depois de `pnpm build`, os stubs são copiados para build/stubs
    const { stubsRoot } = await import('../build/stubs/main.js');
    return readFileSync(join(stubsRoot, 'controllers/oidc_session_controller.stub'), 'utf8');
  }

  test('callback instala a sessão via authkit.startSession, não session.put(sessionKey)', async ({
    assert,
  }) => {
    // O callback escrevia o token set cru (`ctx.session.put(cfg.sessionKey, tokenSet)`),
    // o que não limpa a credencial de impersonação parqueada pela sessão anterior no
    // mesmo cookie jar. `manager.startSession` faz essa limpeza. O stub não pode voltar
    // atrás: a escrita crua é a regressão que este teste pega.
    const stubContent = await readStub();
    assert.match(stubContent, /authkit\.startSession\(\s*ctx\s*,\s*tokenSet\s*\)/);
    assert.notMatch(stubContent, /session\.put\(\s*[^)]*sessionKey/);
  });

  test('logout encerra via authkit.endSession, não session.forget(sessionKey)', async ({
    assert,
  }) => {
    // `forget(sessionKey)` solto deixa o refresh token do ATOR parqueado no browser
    // depois do logout. `endSession` limpa token set E credencial parqueada.
    const stubContent = await readStub();
    assert.match(stubContent, /authkit\.endSession\(\s*ctx\s*\)/);
    assert.notMatch(stubContent, /session\.forget\(\s*[^)]*sessionKey/);
  });

  test('login/callback go through the manager (state, nonce, PKCE, id_token check)', async ({
    assert,
  }) => {
    const stubContent = await readStub();
    assert.match(stubContent, /createAuthorizationRequest\(/);
    assert.match(stubContent, /completeAuthorization\(/);
    assert.match(stubContent, /authkit_pkce/);
    // Hand-rolled exchange skips the id_token/nonce validation — must not come back.
    assert.notMatch(stubContent, /exchangeCode\(/);
  });

  test('gets the manager through the container, like first-party packages', async ({ assert }) => {
    const stubContent = await readStub();
    assert.match(stubContent, /@inject\(\)/);
    assert.match(stubContent, /protected authkit: AuthkitClientManager/);
    assert.notMatch(stubContent, /containerResolver\.make\('authkit\.client'\)/);
  });
});
