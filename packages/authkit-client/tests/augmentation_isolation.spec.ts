/**
 * This package must NOT declare `HttpContext.auth` anywhere.
 *
 * `ctx.auth` belongs to `@adonisjs/auth` (and to the app, which types it for its
 * own user model). Two declarations of the same property with different types do
 * not merge, and `skipLibCheck` hides the conflict: whichever file TypeScript
 * reaches first wins, and `auth.user` silently changes type across the app.
 * AuthKit's own surface lives on `ctx.authkit`.
 *
 * This spec walks the emitted declaration graph, because the emitted `.d.ts` is
 * what a consumer actually compiles against.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@japa/runner';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(PKG, 'build');

const TYPES_MODULE = join(BUILD, 'types.d.ts');

function declarationFileFor(exportTarget: string): string {
  return join(PKG, exportTarget).replace(/\.js$/, '.d.ts');
}

/** Every `import`/`export ... from` specifier in a declaration file. */
function specifiersIn(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
    found.push(match[1]);
  }
  return found;
}

/**
 * Every declaration file reachable from `entry`, following relative specifiers.
 * Package-external specifiers are irrelevant: a leak can only come from this
 * package's own files.
 */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const specifier of specifiersIn(source)) {
      queue.push(resolve(dirname(file), specifier).replace(/\.js$/, '.d.ts'));
    }
  }
  return seen;
}

/** Consumer entrypoints, from the exports map. */
function consumerEntrypoints(): Array<{ subpath: string; declaration: string }> {
  const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
    exports: Record<string, string>;
  };
  return Object.entries(manifest.exports)
    .map(([subpath, target]) => ({ subpath, declaration: declarationFileFor(target) }))
    .filter((entry) => existsSync(entry.declaration));
}

test.group('module augmentation isolation', () => {
  test('the build output is present, so the checks below are not vacuous', ({ assert }) => {
    assert.isTrue(
      existsSync(TYPES_MODULE),
      'run `pnpm --filter @adonis-agora/authkit-client build` first — this spec reads build/',
    );
    assert.isAbove(consumerEntrypoints().length, 5, 'the exports map scan found almost nothing');
  });

  test('no shipped module declares HttpContext.auth', ({ assert }) => {
    const declaring = [
      ...new Set(consumerEntrypoints().flatMap((e) => [...reachableFrom(e.declaration)])),
    ].filter((file) =>
      /declare module '@adonisjs\/core\/http'[\s\S]{0,400}?\bauth\s*:/.test(
        readFileSync(file, 'utf8'),
      ),
    );

    assert.deepEqual(
      declaring.map((f) => relative(PKG, f)),
      [],
    );
  });

  test('no shipped declaration side-effect-imports an external module', ({ assert }) => {
    // A declaration walk only sees this package's own files. A bare
    // `import '@adonisjs/auth/...'` in a shipped `.d.ts` would inherit THAT
    // module's `HttpContext.auth` and hand it to every consumer just the same,
    // without this package declaring anything. Relative side-effect imports stay
    // allowed — that is how `container_bindings.js` travels.
    const entrypoints = consumerEntrypoints().flatMap((e) => [...reachableFrom(e.declaration)]);
    const offenders = [
      ...new Set(
        entrypoints
          .filter((file) => /^import\s+['"][^.]/m.test(readFileSync(file, 'utf8')))
          .map((file) => relative(PKG, file)),
      ),
    ].sort();

    assert.deepEqual(offenders, []);
  });

  test('the context middleware carries the container bindings', ({ assert }) => {
    // Without it `containerResolver.make('authkit.client')` goes untyped for consumers.
    const middleware = declarationFileFor('./build/authkit_context_middleware.js');
    const reachable = [...reachableFrom(middleware)];
    const declaresBinding = reachable.some((file) =>
      /declare module '@adonisjs\/core\/types'[\s\S]{0,400}?'authkit\.client'/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    assert.isTrue(declaresBinding, 'the middleware no longer types `authkit.client`');
  });
});
