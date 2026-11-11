import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from '@japa/runner';

/**
 * Hosts add their own screens by augmenting `AuthkitScreenProps` from the
 * package root (`declare module '@adonis-agora/authkit-server'`). The fixture
 * compiles against the BUILT package, the way an app sees it: `views` and a
 * typed renderer accept the augmented screen, and still refuse undeclared ones
 * (`@ts-expect-error` lines fail the build if they stop erroring).
 */
const PKG = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = fileURLToPath(
  new URL('../fixtures/screen_augmentation/tsconfig.json', import.meta.url),
);

test.group('AuthkitScreenProps augmentation', () => {
  test('a host-declared screen is accepted by views and render', ({ assert }) => {
    assert.isTrue(existsSync(`${PKG}build/index.d.ts`), 'build the package first');
    const result = spawnSync(`${PKG}node_modules/.bin/tsc`, ['-p', FIXTURE], {
      cwd: PKG,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  }).timeout(120_000);
});
