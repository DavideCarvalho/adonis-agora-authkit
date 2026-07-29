/**
 * Type-check `tests/` and `bin/` — the code the package's `typecheck` script
 * does NOT cover.
 *
 * WHY THIS EXISTS. `tsconfig.json`'s `include` lists `index.ts`, `types.ts`,
 * `src`, `providers`, `commands`, `database`, `services` and `stubs` — not
 * `tests`. And the runner (`node --import=@poppinss/ts-exec bin/test.ts`)
 * strips types without checking them. So a type error in a test failed NO gate
 * in this repo: not `pnpm typecheck`, not `pnpm lint`, not CI. Tests could
 * assert against a shape the library no longer has and stay green forever —
 * which is the opposite of what tests are for.
 *
 * WHY A RATCHET AND NOT A PLAIN `tsc`. Turning the check on found 337 existing
 * errors (see the categories printed below). Fixing all of them is a separate,
 * much larger job, and the two dishonest shortcuts — `@ts-nocheck` or widening
 * the exclusions — recreate the exact blind spot this script removes. So every
 * error stays visible and the script gates on the COUNT:
 *
 *   - count > BASELINE → FAIL. A new type error in a test is now caught.
 *   - count < BASELINE → FAIL, asking you to lower BASELINE. The number can
 *     only go down; the debt cannot be silently re-accrued.
 *   - count === BASELINE → pass.
 *
 * This is a regression gate, not a suppression: nothing is hidden, `tsc`'s full
 * output is printed on any failure.
 *
 * THE COUNT USED TO DEPEND ON INSTALL STATE. It no longer does. 41 of the
 * original errors were `TS7016` — missing declaration files for `ioredis-mock`
 * and `better-sqlite3`. Those declarations were installed all along, but only as
 * peers inside pnpm's store, which is never on TypeScript's `node_modules/@types`
 * upward walk. Declaring `@types/ioredis-mock` and `@types/better-sqlite3` as
 * direct devDependencies of this package puts them on that walk and removed the
 * class outright (333 → 292), unmasking nothing.
 *
 * That matters because `TS7016` and `TS2307` are the only codes whose presence
 * turns on *resolution* rather than on the code. Both are now 0, and every
 * remaining code (`TS18046`, `TS2345`, `TS2722`, …) is a code-shape error over
 * lockfile-pinned dependencies. The count is a function of the lockfile, not of
 * the machine: verified by deleting `node_modules/` for this package and
 * relinking with `--frozen-lockfile`, which reproduced 292 exactly.
 *
 * So the number moves only when something reviewable moves — a dependency
 * version, the pinned `typescript`, or the tests themselves.
 *
 * Usage: `pnpm --filter @adonis-agora/authkit-server typecheck:tests`
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Number of type errors `tsconfig.tests.json` currently produces.
 *
 * Only ever lower this. Raising it means you are re-accruing the debt this
 * script exists to stop.
 */
const BASELINE = 292;

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = resolve(pkgDir, 'node_modules/.bin/tsc');

const run = spawnSync(tsc, ['-p', 'tsconfig.tests.json', '--noEmit', '--pretty', 'false'], {
  cwd: pkgDir,
  encoding: 'utf8',
});

if (run.error) {
  console.error('[typecheck:tests] could not run tsc:', run.error.message);
  process.exit(1);
}

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
const lines = output.split('\n');
const errorLines = lines.filter((l) => /^\S.*: error TS\d+:/.test(l));
const count = errorLines.length;

/** `path/file.ts(12,3): error TS1234: message` → `{ file, code }` */
function parse(line) {
  const file = line.slice(0, line.indexOf('('));
  const code = /error (TS\d+):/.exec(line)?.[1] ?? 'TS?';
  return { file, code };
}

function tally(items, pick) {
  const map = new Map();
  for (const item of items) map.set(pick(item), (map.get(pick(item)) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

const parsed = errorLines.map(parse);

console.log(`[typecheck:tests] ${count} type error(s) over tests/ + bin/ (baseline ${BASELINE})`);
if (count > 0) {
  console.log('[typecheck:tests] by error code:');
  for (const [code, n] of tally(parsed, (e) => e.code))
    console.log(`  ${String(n).padStart(4)}  ${code}`);
  console.log('[typecheck:tests] top files:');
  for (const [file, n] of tally(parsed, (e) => e.file).slice(0, 10))
    console.log(`  ${String(n).padStart(4)}  ${file}`);
}

if (count > BASELINE) {
  console.error('');
  console.error(output.trimEnd());
  console.error('');
  console.error(
    `[typecheck:tests] FAIL: ${count} errors > baseline ${BASELINE}. A new type error was introduced in tests/ or bin/. Fix it — do not raise the baseline.`,
  );
  process.exit(1);
}

if (count < BASELINE) {
  console.error(
    `[typecheck:tests] FAIL: ${count} errors < baseline ${BASELINE}. Good news — lower BASELINE to ${count} in scripts/typecheck_tests.mjs to lock the win in.`,
  );
  process.exit(1);
}

console.log('[typecheck:tests] OK — no regression against the baseline.');
