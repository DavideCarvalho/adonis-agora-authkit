import { configProvider } from '@adonisjs/core';
import { IgnitorFactory } from '@adonisjs/core/factories';
import { test } from '@japa/runner';
import { authkitDoctorChecks, keystoreReadOnlyResult } from '../src/doctor/agora_checks.js';
import { runAgoraDoctor } from '../src/doctor/agora_doctor.js';
import { generateSigningJwk } from '../src/keys/keystore.js';
import { KeystoreCodec } from '../src/keys/keystore_codec.js';
import { KeystoreUnavailableError } from '../src/keys/keystore_read_only.js';

const BOOT_APP = new URL('./fixtures/boot_app/', import.meta.url);

async function bootedApp(authkit: unknown) {
  const app = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({ config: { app: { appKey: 'a'.repeat(32) }, authkit } })
    .create(BOOT_APP)
    .createApp('web');
  await app.init();
  await app.boot();
  return app;
}

async function runCheck(authkit: unknown) {
  const app = await bootedApp(authkit);
  const { report } = await runAgoraDoctor(app, authkitDoctorChecks(), {
    only: 'authkit.keystore-read-only',
  });
  return report.results[0]!;
}

/** A resolved config whose keystore lives in an in-memory vault. */
function configWith(blob: string | null, readOnly = true) {
  const store = { read: async () => blob, write: async () => {} };
  return configProvider.create(
    async () =>
      ({
        issuer: 'https://idp.test/oidc',
        mountPath: '/oidc',
        jwksConfig: { source: 'managed', store, encrypt: false, readOnly },
      }) as any,
  );
}

test.group('doctor | authkit.keystore-read-only', () => {
  test('ok when readOnly and the keystore reads', async ({ assert }) => {
    const blob = await new KeystoreCodec({ encrypt: false }).encode({
      keys: [await generateSigningJwk('RS256')],
    });
    const result = await runCheck(configWith(blob));
    assert.equal(result.status, 'ok');
    assert.match(result.message, /1 key/);
  });

  test('error when readOnly and the keystore row is missing', async ({ assert }) => {
    const result = await runCheck(configWith(null));
    assert.equal(result.status, 'error');
    assert.match(result.message, /empty/);
  });

  test('error when the config does not resolve because the keystore is missing', async ({
    assert,
  }) => {
    const result = await runCheck(
      configProvider.create(async () => {
        throw new KeystoreUnavailableError('missing');
      }),
    );
    assert.equal(result.status, 'error');
    assert.include(result.fix!, 'writes the keystore');
  });

  test('skipped on the writer instance', async ({ assert }) => {
    const result = await runCheck(configWith(null, false));
    assert.equal(result.status, 'skip');
  });

  test('result shapes', ({ assert }) => {
    assert.equal(keystoreReadOnlyResult(null, 2).status, 'ok');
    const unreadable = keystoreReadOnlyResult(new KeystoreUnavailableError('unreadable'));
    assert.equal(unreadable.status, 'error');
    assert.include(unreadable.fix!, 'crypto.keys');
  });
});
