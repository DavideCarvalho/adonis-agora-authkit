/**
 * Lint every published package the way npm will serve it: `publint` on the package directory and
 * `attw` (Are The Types Wrong) on the packed tarball. Run after `pnpm build` — both read the built output.
 *
 * Packages are ESM-only (`"type": "module"`, no `require` condition), so attw runs with the
 * `esm-only` profile: a CommonJS consumer resolving them is expected to fail.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PACKAGES = join(import.meta.dirname, '..', 'packages');
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

let checked = 0;
for (const name of readdirSync(PACKAGES)) {
  const dir = join(PACKAGES, name);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  if (pkg.private === true) continue;

  console.log(`\n▶ ${pkg.name}`);
  run('pnpm', ['exec', 'publint', '--strict'], dir);

  // Pack without lifecycle scripts: `prepack` would rebuild what the caller already built.
  const out = mkdtempSync(join(tmpdir(), 'check-package-'));
  try {
    run('npm', ['pack', '--ignore-scripts', '--silent', '--pack-destination', out], dir);
    const tarball = readdirSync(out).find((file) => file.endsWith('.tgz'));
    if (!tarball) throw new Error(`npm pack produced no tarball for ${pkg.name}`);
    // Non-JS exports (stylesheets) have no types to check.
    const assets = Object.entries(pkg.exports ?? {})
      .filter(([, target]) => typeof target === 'string' && !/\.[cm]?js$/.test(target))
      .map(([subpath]) => subpath);
    const exclude = assets.length ? ['--exclude-entrypoints', ...assets] : [];
    run('pnpm', ['exec', 'attw', join(out, tarball), '--profile', 'esm-only', ...exclude], dir);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  checked += 1;
}

if (checked === 0) {
  console.error('check:package found no published package under packages/');
  process.exit(1);
}
