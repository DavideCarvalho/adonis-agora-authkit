import { assert } from '@japa/assert';
import { configure, processCLIArgs, run } from '@japa/runner';

/**
 * Preflight: verify the sqlite native binding loads before running the suite.
 *
 * `better-sqlite3` ships a prebuilt binary tied to a specific Node ABI
 * (NODE_MODULE_VERSION). When the running Node doesn't match the version it
 * was built for, `require`/`import` throws deep inside the native loader with
 * a message that says nothing about Node versions — it just looks like ~270
 * unrelated store tests failing with "Module did not self-register". Fail
 * fast here with an actionable message instead.
 */
async function assertSqliteDriverLoads(): Promise<void> {
  try {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    db.prepare('select 1').get();
    db.close();
  } catch (error) {
    console.error(
      [
        '',
        'sqlite driver failed to load — this usually means `better-sqlite3` was',
        'built for a different Node ABI. Run `nvm use` (see `.nvmrc`) then',
        '`pnpm rebuild better-sqlite3`.',
        '',
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
}

await assertSqliteDriverLoads();

processCLIArgs(process.argv.slice(2));
configure({
  files: ['tests/**/*.spec.ts'],
  plugins: [assert()],
});
run();
