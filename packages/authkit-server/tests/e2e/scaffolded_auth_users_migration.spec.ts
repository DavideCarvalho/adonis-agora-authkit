import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compose } from '@adonisjs/core/helpers';
import { BaseModel, beforeCreate, column } from '@adonisjs/lucid/orm';
import { test } from '@japa/runner';
import { lucidAccountStore } from '../../src/accounts/lucid_account_store.js';
import { withAuthUser } from '../../src/mixins/with_auth_user.js';
import { withCredentials } from '../../src/mixins/with_credentials.js';
import { createTestDatabase } from '../bootstrap.js';

const STUB_PATH = fileURLToPath(
  new URL('../../stubs/migrations/create_auth_users_table.stub', import.meta.url),
);

/**
 * Loads the REAL migration stub `node ace configure` scaffolds (not a
 * hand-copied schema) and executes its `up()` against a fresh in-memory
 * sqlite database. This is the strongest regression test for "getting-started
 * ships an AuthUser with no migration, host hits `no such table: auth_users`"
 * (flagged during PR #132, fixed alongside it, see
 * commands/configure.ts + stubs/migrations/create_auth_users_table.stub):
 * if the migration stub and the model stub ever drift apart again,
 * `store.create()`/`verifyCredentials()` below fail for real, against a
 * really-migrated table — not a hand-crafted schema that only stays in sync
 * with itself.
 */
async function runScaffoldedMigration(db: ReturnType<typeof createTestDatabase>): Promise<void> {
  const raw = await readFile(STUB_PATH, 'utf8');
  // Strip the `{{{ ... }}}` codemods frontmatter (`exports(...)`, only
  // meaningful to `codemods.makeUsingStub`) — what's left is the migration
  // class as real TypeScript, written out and imported as-is below.
  const body = raw.replace(/^\{\{\{[\s\S]*?\}\}\}\n?/, '');
  // Written out as `.ts` (not `.mjs`): the stub uses TS-only syntax
  // (`protected tableName`), and the test runner already has the `.ts` loader
  // (`@poppinss/ts-exec`) registered process-wide, so a dynamic `import()` of
  // a `.ts` file works the same as any other test file. It has to land INSIDE
  // the package (not `os.tmpdir()`): the migration's own `import
  // '@adonisjs/lucid/schema'` resolves node_modules by walking up from the
  // importing file's directory, which fails for a file outside the repo.
  const dir = await mkdtemp(
    join(fileURLToPath(new URL('../../', import.meta.url)), '.tmp-migration-'),
  );
  const file = join(dir, 'create_auth_users_table.ts');
  await writeFile(file, body, 'utf8');
  try {
    const { default: MigrationClass } = await import(pathToFileURL(file).href);
    const migration = new MigrationClass(db.connection(), file, false);
    await migration.execUp();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * AuthUser exactly as scaffolded by `stubs/models/auth_user.stub` — same
 * mixins, same `selfAssignPrimaryKey` flag, same @beforeCreate uuid hook,
 * same fullName column, nothing extra. (`tests/configure.spec.ts` asserts the
 * real stub file has these same pieces; this class exercises the identical
 * shape against a real migrated database.)
 */
class ScaffoldedAuthUser extends compose(BaseModel, withAuthUser(), withCredentials()) {
  static table = 'auth_users';

  /**
   * Without this, Lucid overwrites the id the hook below assigns with the
   * database's raw INSERT result (SQLite's internal rowid) right after
   * save — same practical failure as no hook at all.
   */
  static selfAssignPrimaryKey = true;

  @column({ isPrimary: true })
  declare id: string;

  @beforeCreate()
  static assignUuid(user: ScaffoldedAuthUser) {
    user.id = randomUUID();
  }

  @column()
  declare fullName: string | null;
}

test.group('e2e: scaffolded auth_users migration', (group) => {
  let db: ReturnType<typeof createTestDatabase>;

  group.each.setup(async () => {
    db = createTestDatabase();
    BaseModel.useAdapter(db.modelAdapter());
    await runScaffoldedMigration(db);
    return async () => db.manager.closeAll();
  });

  test('signup → login works end-to-end against the migrated table (regression)', async ({
    assert,
  }) => {
    const store = lucidAccountStore(ScaffoldedAuthUser);

    const created = await store.create({
      email: 'new-user@example.com',
      password: 'Xk9pQ!mZr7nL',
      fullName: 'Ada Lovelace',
    });

    // Bug 1 (PR #132 + follow-up): without the @beforeCreate hook AND
    // `selfAssignPrimaryKey`, Lucid either inserts NULL into this column or
    // silently overwrites the assigned UUID with the database's internal
    // auto-increment rowid right after insert.
    assert.match(created.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(created.email, 'new-user@example.com');
    // Bug 2 (PR #132): without the `fullName` column, this create() call
    // itself would throw ("Cannot define 'fullName' on 'AuthUser' model...").
    assert.equal(created.name, 'Ada Lovelace');

    // The row is genuinely reachable by its real id on a follow-up request —
    // exactly the failure mode both PR #132 bugs produced together.
    const foundById = await store.findById(created.id);
    assert.isNotNull(foundById);
    assert.equal(foundById!.email, 'new-user@example.com');

    const loggedIn = await store.verifyCredentials('new-user@example.com', 'Xk9pQ!mZr7nL');
    assert.isNotNull(loggedIn);
    assert.equal(loggedIn!.id, created.id);

    assert.isNull(await store.verifyCredentials('new-user@example.com', 'wrong-password'));
  });

  test('email is unique at the DB level', async ({ assert }) => {
    const store = lucidAccountStore(ScaffoldedAuthUser);
    await store.create({ email: 'dup@example.com', password: 'Xk9pQ!mZr7nL' });
    await assert.rejects(() =>
      store.create({ email: 'dup@example.com', password: 'anotherPass1' }),
    );
  });

  test('password reset round-trips through the migrated columns', async ({ assert }) => {
    const store = lucidAccountStore(ScaffoldedAuthUser);
    await store.create({ email: 'reset@example.com', password: 'Xk9pQ!mZr7nL' });
    const issued = await store.issuePasswordResetToken('reset@example.com');
    assert.isNotNull(issued);
    const ok = await store.consumePasswordResetToken(issued!.token, 'NewPassw0rd!');
    assert.isTrue(ok);
    assert.isNotNull(await store.verifyCredentials('reset@example.com', 'NewPassw0rd!'));
  });

  test('email verification round-trips through the migrated columns', async ({ assert }) => {
    const store = lucidAccountStore(ScaffoldedAuthUser);
    await store.create({ email: 'verify@example.com', password: 'Xk9pQ!mZr7nL' });
    const issued = await store.issueEmailVerificationToken('verify@example.com');
    assert.isNotNull(issued);
    assert.isTrue(await store.consumeEmailVerificationToken(issued!.token));
  });
});
