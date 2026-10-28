import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from '@japa/runner';

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

/**
 * `@simplewebauthn/server` (~4.5 MB of heap, ~290 modules) is loaded on the
 * first passkey ceremony, not when the package is imported: most processes
 * (workers, ace, apps without passkeys) never run one. Checked in a fresh
 * process, because the test runner itself has long since loaded it.
 */
async function loadsSimpleWebauthn(entry: string): Promise<boolean> {
  const script = `
    import { registerHooks } from 'node:module';
    let loaded = false;
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier.startsWith('@simplewebauthn/server')) loaded = true;
        return next(specifier, context);
      },
    });
    await import(${JSON.stringify(entry)});
    process.stdout.write(JSON.stringify({ loaded }));
  `;
  const { stdout } = await run(
    process.execPath,
    ['--import=@poppinss/ts-exec', '--input-type=module', '-e', script],
    { cwd: packageRoot },
  );
  return (JSON.parse(stdout) as { loaded: boolean }).loaded;
}

test.group('@simplewebauthn/server is loaded lazily', () => {
  test('importing the package entry does not load it', async ({ assert }) => {
    assert.isFalse(await loadsSimpleWebauthn('./index.ts'));
  }).timeout(60_000);

  test('the account store loads it on its first ceremony', async ({ assert }) => {
    const { defaultWebauthnCeremonies } = await import('../../src/accounts/lucid_store/shared.js');
    const options = await defaultWebauthnCeremonies.generateAuthenticationOptions({
      rpID: 'localhost',
    });
    assert.isString(options.challenge);
  });
});
