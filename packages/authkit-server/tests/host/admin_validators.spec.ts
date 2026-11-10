import { test } from '@japa/runner';
import { clientInputValidator } from '../../src/host/admin_validators.js';

/**
 * Validadores de input de client OIDC — cobre os fixes de segurança:
 *  - M10: `grantTypes` restritos a uma allowlist (bloqueia `implicit`).
 *  - L10: `redirectUris`/`postLogoutRedirectUris`/`backchannelLogoutUri` precisam
 *         ser URIs absolutas http/https.
 */
test.group('clientInputValidator (security: M10 grants allowlist + L10 URLs)', () => {
  // ── M10 — allowlist de grant_types ────────────────────────────────────────
  test('aceita grants da allowlist (authorization_code, refresh_token, client_credentials, token-exchange)', async ({
    assert,
  }) => {
    const out = await clientInputValidator.validate({
      redirectUris: ['https://app1/cb'],
      grantTypes: [
        'authorization_code',
        'refresh_token',
        'client_credentials',
        'urn:ietf:params:oauth:grant-type:token-exchange',
      ],
    });
    assert.deepEqual(out.grantTypes, [
      'authorization_code',
      'refresh_token',
      'client_credentials',
      'urn:ietf:params:oauth:grant-type:token-exchange',
    ]);
  });

  test('REJEITA grant_type implicit', async ({ assert }) => {
    await assert.rejects(() =>
      clientInputValidator.validate({
        redirectUris: ['https://app1/cb'],
        grantTypes: ['authorization_code', 'implicit'],
      }),
    );
  });

  test('REJEITA grant_type desconhecido (fora da allowlist)', async ({ assert }) => {
    await assert.rejects(() =>
      clientInputValidator.validate({
        redirectUris: ['https://app1/cb'],
        grantTypes: ['password'],
      }),
    );
  });

  // ── L10 — validação de URLs ───────────────────────────────────────────────
  test('aceita redirect_uri http/https absoluto (incl. localhost / host single-label)', async ({
    assert,
  }) => {
    const out = await clientInputValidator.validate({
      redirectUris: ['https://app1/cb', 'http://localhost:3000/cb'],
      postLogoutRedirectUris: ['https://app1/'],
    });
    assert.deepEqual(out.redirectUris, ['https://app1/cb', 'http://localhost:3000/cb']);
  });

  test('REJEITA redirect_uri não-URL', async ({ assert }) => {
    await assert.rejects(() => clientInputValidator.validate({ redirectUris: ['not-a-url'] }));
  });

  test('REJEITA redirect_uri relativo (sem protocolo)', async ({ assert }) => {
    await assert.rejects(() =>
      clientInputValidator.validate({ redirectUris: ['/oauth/callback'] }),
    );
  });

  test('REJEITA esquema perigoso (javascript:)', async ({ assert }) => {
    await assert.rejects(() =>
      clientInputValidator.validate({ redirectUris: ['javascript:alert(1)'] }),
    );
  });

  test('REJEITA postLogoutRedirectUri não-URL', async ({ assert }) => {
    await assert.rejects(() =>
      clientInputValidator.validate({
        redirectUris: ['https://app1/cb'],
        postLogoutRedirectUris: ['foo bar'],
      }),
    );
  });

  test('REJEITA backchannelLogoutUri não-URL', async ({ assert }) => {
    await assert.rejects(() =>
      clientInputValidator.validate({
        redirectUris: ['https://app1/cb'],
        backchannelLogoutUri: 'nope',
      }),
    );
  });

  test('aceita backchannelLogoutUri https válido', async ({ assert }) => {
    const out = await clientInputValidator.validate({
      redirectUris: ['https://app1/cb'],
      backchannelLogoutUri: 'https://app1/auth/backchannel-logout',
    });
    assert.equal(out.backchannelLogoutUri, 'https://app1/auth/backchannel-logout');
  });
});
