#!/usr/bin/env node
import { existsSync } from 'node:fs';
/**
 * Packaging smoke test: importa dinamicamente CADA módulo .js do build de cada
 * pacote publicável. Pega bugs de empacotamento (ex.: o antigo crash de import
 * runtime de augmentations) que typecheck/test não pegam porque exercitam o src,
 * não o build.
 *
 * Os peers (session/shield/ally/limiter/mail/edge) estão instalados como devDeps
 * neste monorepo, então qualquer ERR_MODULE_NOT_FOUND aqui é um bug REAL de
 * empacotamento — a lib não deve hard-importar nada que não resolva.
 */
import { readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const PACKAGES = [
  'packages/authkit-core/build',
  'packages/authkit-client/build',
  'packages/authkit-server/build',
  'packages/authkit-react/build',
  'packages/authkit-testing/build',
  'packages/authkit-sdk/build',
];

// O react usa JSX/DOM; importar seus módulos a frio em Node pode falhar por
// razões NÃO relacionadas a empacotamento (ambiente DOM ausente). Para esses,
// só verificamos que o entrypoint resolve.
const ENTRYPOINT_ONLY = new Set(['packages/authkit-react/build']);

/**
 * Diretórios que NÃO devem ser importados a frio em Node:
 * - `ui-dist`: bundles Vite da SPA do console (referenciam `document`/`window`).
 * - `services`: acessores `services/main` (convenção Adonis, como `@adonisjs/lucid/services/db`)
 *   rodam `await app.booted()` no top-level, então só funcionam dentro de um app booted —
 *   importar a frio quebra por falta de app, não por bug de empacotamento.
 */
// `assets` holds browser scripts copied verbatim into the build (e.g. host/assets/logout.js);
// they touch `document` on load and are not modules the package exports.
const SKIP_DIRS = new Set(['ui-dist', 'services', 'assets']);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) out.push(...(await walk(full)));
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

let imported = 0;
const failures = [];

for (const pkg of PACKAGES) {
  const buildDir = join(root, pkg);
  if (!existsSync(buildDir)) {
    failures.push(`${pkg}: build ausente — rode \`pnpm -r build\` antes.`);
    continue;
  }

  const files = ENTRYPOINT_ONLY.has(pkg)
    ? [join(buildDir, 'index.js')].filter(existsSync)
    : await walk(buildDir);

  for (const file of files) {
    try {
      await import(pathToFileURL(file).href);
      imported++;
    } catch (err) {
      failures.push(`${file.replace(`${root}/`, '')}: ${err.code ?? ''} ${err.message}`);
    }
  }
}

if (failures.length) {
  console.error(`\n❌ Import smoke FALHOU (${failures.length} módulo(s)):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log(`✅ Import smoke OK: ${imported} módulo(s) importam limpos a partir do build.`);
