/**
 * Importing this package's middleware must NOT inject `HttpContext.auth` into a
 * consumer's type program.
 *
 * `Authenticator` is generic, and most apps declare `auth: Authenticator<AppUser>`
 * so `getUser()` returns their user model. Two declarations of the same property
 * with different types do not merge — TypeScript keeps whichever it reached
 * FIRST and reports the conflict on the other, inside a `.d.ts`, where
 * `skipLibCheck` (on in every AdonisJS app) silently discards it. In a real app
 * the library's file is reached first, so the app's declaration loses and
 * `auth.getUser()` collapses to `unknown` across the entire codebase.
 *
 * That is not hypothetical: a release that added `import '../../types.js'` to the
 * middleware took one consumer app from 24 type errors to 351 and another from 0
 * to 105, and forced them to pin an exact old version.
 *
 * So `types.ts` — which carries the `HttpContext.auth` augmentation — must stay
 * reachable ONLY through the `./types` subpath a host opts into. The container
 * bindings live in `container_bindings.ts` precisely so the provider and the
 * middleware can pull those in without dragging `auth` along.
 *
 * This spec walks the emitted declaration graph, because the emitted `.d.ts` is
 * what a consumer actually compiles against — the monorepo's own typecheck has
 * every file in one program and cannot see the difference.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@japa/runner';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(PKG, 'build');

/** The augmentation a host must opt into, and the module that carries it. */
const OPT_IN_MODULE = join(BUILD, 'types.d.ts');

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

/** Consumer entrypoints, from the exports map, minus the opt-in subpath itself. */
function consumerEntrypoints(): Array<{ subpath: string; declaration: string }> {
  const manifest = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')) as {
    exports: Record<string, string>;
  };
  return Object.entries(manifest.exports)
    .filter(([subpath]) => subpath !== './types')
    .map(([subpath, target]) => ({ subpath, declaration: declarationFileFor(target) }))
    .filter((entry) => existsSync(entry.declaration));
}

test.group('module augmentation isolation', () => {
  test('the build output is present, so the checks below are not vacuous', ({ assert }) => {
    assert.isTrue(
      existsSync(OPT_IN_MODULE),
      'run `pnpm --filter @adonis-agora/authkit-client build` first — this spec reads build/',
    );
    assert.isAbove(consumerEntrypoints().length, 5, 'the exports map scan found almost nothing');
  });

  test('types.d.ts is the only module declaring HttpContext.auth', ({ assert }) => {
    // A second one would reintroduce the collision from somewhere new.
    const declaring = [...reachableFrom(join(BUILD, 'index.d.ts')), OPT_IN_MODULE].filter(
      (file) => {
        const source = readFileSync(file, 'utf8');
        return /declare module '@adonisjs\/core\/http'[\s\S]{0,400}?\bauth\s*:/.test(source);
      },
    );

    assert.deepEqual(
      declaring.map((f) => relative(PKG, f)),
      ['build/types.d.ts'],
    );
  });

  test('no consumer entrypoint reaches the HttpContext.auth augmentation', ({ assert }) => {
    const leaking = consumerEntrypoints()
      .filter((entry) => reachableFrom(entry.declaration).has(OPT_IN_MODULE))
      .map((entry) => entry.subpath)
      .sort();

    assert.deepEqual(
      leaking,
      [],
      'these subpaths drag `HttpContext.auth` into every consumer that imports them — ' +
        'import `container_bindings.js` instead of `types.js`',
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

  test('the middleware still carries the container bindings', ({ assert }) => {
    // The other half of the split: separating the two must not cost the binding,
    // or `containerResolver.make('authkit.client')` goes untyped for consumers.
    const middleware = declarationFileFor('./build/src/middleware/authkit_middleware.js');
    const reachable = [...reachableFrom(middleware)];
    const declaresBinding = reachable.some((file) =>
      /declare module '@adonisjs\/core\/types'[\s\S]{0,400}?'authkit\.client'/.test(
        readFileSync(file, 'utf8'),
      ),
    );
    assert.isTrue(declaresBinding, 'the middleware no longer types `authkit.client`');
  });
});
