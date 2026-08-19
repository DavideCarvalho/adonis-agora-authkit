/**
 * The server's twin of the client's augmentation guard.
 *
 * A sibling release shipped a middleware whose emitted declarations pulled in an
 * unparameterised `HttpContext.auth`. Because `HttpContext.auth` declared twice
 * with different types does not merge — TypeScript keeps whichever it reached
 * first and buries the conflict in a `.d.ts` that `skipLibCheck` discards — every
 * consumer's own `auth: Authenticator<AppUser>` lost and `getUser()` collapsed to
 * `unknown`. One app went from 24 type errors to 351.
 *
 * This package does not have that bug, and these specs are what keep it that way.
 * Two things protect it, and both are easy to break by accident:
 *
 *   1. `src/host/augmentations.ts` loads the framework's own augmentations with
 *      `import type {} from '…'`, a form tsc ERASES from the emitted `.d.ts`.
 *      Rewriting any of those as a bare side-effect `import '…'` would push
 *      `@adonisjs/auth`'s `HttpContext.auth` into every consumer at once.
 *   2. The service provider — the one module every host registers in
 *      `adonisrc.ts` — must reach the container bindings and nothing else.
 *
 * The monorepo's own typecheck compiles every file in a single program and so
 * cannot see any of this; only the emitted declaration graph can.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@japa/runner';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(PKG, 'build');
const PROVIDER = join(BUILD, 'providers/authkit_server_provider.d.ts');
const BARREL = join(BUILD, 'index.d.ts');

function specifiersIn(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
}

/** Every declaration file reachable from `entry` through relative specifiers. */
function reachableFrom(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
      queue.push(resolve(dirname(file), specifier).replace(/\.js$/, '.d.ts'));
    }
  }
  return [...seen];
}

/** Files declaring a member on `HttpContext`, with the member names they add. */
function httpContextAugmentations(files: string[]): Array<{ file: string; members: string[] }> {
  const found: Array<{ file: string; members: string[] }> = [];
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const block = /declare module '@adonisjs\/core\/http'\s*\{([\s\S]*?)\n\}/.exec(source);
    if (!block) continue;
    const members = [...block[1].matchAll(/^\s{4,}(\w+)\??\s*:/gm)].map((m) => m[1]);
    found.push({ file: relative(PKG, file), members });
  }
  return found;
}

test.group('module augmentation isolation (server)', () => {
  test('the build output is present, so the checks below are not vacuous', ({ assert }) => {
    assert.isTrue(existsSync(PROVIDER), 'run `pnpm --filter @adonis-agora/authkit-server build`');
    assert.isAbove(reachableFrom(BARREL).length, 50, 'the declaration walk found almost nothing');
  });

  test('the provider drags no HttpContext augmentation into a host', ({ assert }) => {
    // Every host registers this in adonisrc.ts, so it is the widest blast radius
    // in the package. It must carry the container bindings and nothing more.
    assert.deepEqual(httpContextAugmentations(reachableFrom(PROVIDER)), []);
  });

  test('nothing this package ships declares HttpContext.auth', ({ assert }) => {
    // `auth` is the framework's slot and the app's to type. If this ever fires,
    // an `import type {}` in augmentations.ts has been turned into a real import.
    const offenders = httpContextAugmentations(reachableFrom(BARREL))
      .filter((entry) => entry.members.includes('auth'))
      .map((entry) => entry.file);

    assert.deepEqual(
      offenders,
      [],
      'these files push `HttpContext.auth` into every consumer and will silently ' +
        "override the app's own `Authenticator<AppUser>`",
    );
  });

  test('no shipped declaration side-effect-imports an external module', ({ assert }) => {
    // The subtler half, and the one a declaration walk cannot see: this package
    // never DECLARES `HttpContext.auth`, but a bare `import '@adonisjs/auth/...'`
    // in a shipped `.d.ts` would inherit that module's declaration and hand it to
    // every consumer just the same.
    //
    // `src/host/augmentations.ts` deliberately uses `import type {} from '…'`,
    // which tsc erases from the emitted declarations, and the erasure is the only
    // thing standing between this package and the client's regression. Relative
    // side-effect imports stay allowed — that is how the container bindings
    // travel, and those name keys nobody else can claim.
    const offenders = reachableFrom(BARREL)
      .concat(reachableFrom(PROVIDER))
      .filter((file) => /^import\s+['"][^.]/m.test(readFileSync(file, 'utf8')))
      .map((file) => relative(PKG, file))
      .sort();

    assert.deepEqual(
      [...new Set(offenders)],
      [],
      'a bare side-effect import of an external module in a shipped .d.ts pulls that ' +
        "module's augmentations into every consumer — use `import type {} from '…'`",
    );
  });

  test('the container bindings still reach a host through the provider', ({ assert }) => {
    // The other half: severing augmentations must never cost the bindings.
    const declares = reachableFrom(PROVIDER).some((file) =>
      /declare module '@adonisjs\/core\/types'[\s\S]{0,600}?'authkit\.server'/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    assert.isTrue(declares, 'the provider no longer types the authkit.* container bindings');
  });
});
