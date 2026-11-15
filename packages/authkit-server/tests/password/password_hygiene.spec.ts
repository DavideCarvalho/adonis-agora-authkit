import { compose } from '@adonisjs/core/helpers';
import { BaseModel, column } from '@adonisjs/lucid/orm';
/**
 * Testes de integração para password history, password expiration e grace period.
 *
 * Usa SQLite em memória + model Lucid real para testar o comportamento end-to-end
 * das capabilities.
 */
import { test } from '@japa/runner';
import { DateTime } from 'luxon';
import { lucidAccountStore } from '../../src/accounts/lucid_account_store.js';
import {
  buildPasswordExpiration,
  buildPasswordHistory,
} from '../../src/accounts/lucid_store/password_hygiene.js';
import { RuntimeSettings } from '../../src/host/runtime_settings.js';
import {
  resolveEffectivePasswordExpiration,
  resolveEffectivePasswordHistory,
  resolveEffectiveRequireVerifiedEmailFull,
} from '../../src/host/runtime_toggles.js';
import { withAuthUser } from '../../src/mixins/with_auth_user.js';
import { createTestDatabase } from '../bootstrap.js';

// ---------------------------------------------------------------------------
// Helpers de fake DB (espelha o padrão do runtime_toggles.spec.ts)
// ---------------------------------------------------------------------------

function fakeDb(rows: Record<string, any> = {}) {
  const storeKey = (key: string, orgId: string | null) => `${key}|${orgId ?? ''}`;
  const store = new Map<string, { key: string; org_id: string | null; value: string }>(
    Object.entries(rows).map(([k, v]) => [
      storeKey(k, null),
      { key: k, org_id: null, value: JSON.stringify(v) },
    ]),
  );
  function makeChain(filters: Array<{ col: string; val: string | null; isNull: boolean }>) {
    return {
      where(col: string, val: string) {
        return makeChain([...filters, { col, val, isNull: false }]);
      },
      whereNull(col: string) {
        return makeChain([...filters, { col, val: null, isNull: true }]);
      },
      async first() {
        const keyFilter = filters.find((f) => f.col === 'key');
        const orgFilter = filters.find((f) => f.col === 'organization_id');
        if (!keyFilter) return null;
        const orgId: string | null = orgFilter ? (orgFilter.isNull ? null : orgFilter.val) : null;
        const v = store.get(storeKey(keyFilter.val!, orgId));
        return v
          ? {
              key: v.key,
              organization_id: v.org_id,
              value: v.value,
              updated_at: new Date(),
              updated_by: null,
            }
          : null;
      },
    };
  }
  return {
    from(name: string) {
      return this.table(name);
    },
    table(_name: string) {
      return {
        // Probe: select().limit() → resolves (table present).
        select(_cols?: string) {
          return {
            limit(_n: number) {
              return Promise.resolve([]);
            },
          };
        },
        where(col: string, val: string) {
          return makeChain([{ col, val, isNull: false }]);
        },
        whereNull(col: string) {
          return makeChain([{ col, val: null, isNull: true }]);
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime settings resolvers
// ---------------------------------------------------------------------------

test.group('resolveEffectivePasswordHistory', () => {
  test('ausente → { enabled: false, count: 5 }', async ({ assert }) => {
    const settings = new RuntimeSettings(fakeDb());
    const res = await resolveEffectivePasswordHistory(settings);
    assert.deepEqual(res, { enabled: false, count: 5 });
  });

  test('setting presente com enabled=true, count=10', async ({ assert }) => {
    const settings = new RuntimeSettings(
      fakeDb({ password_history: { enabled: true, count: 10 } }),
    );
    const res = await resolveEffectivePasswordHistory(settings);
    assert.deepEqual(res, { enabled: true, count: 10 });
  });

  test('count inválido (<1) cai no default 5', async ({ assert }) => {
    const settings = new RuntimeSettings(fakeDb({ password_history: { enabled: true, count: 0 } }));
    const res = await resolveEffectivePasswordHistory(settings);
    assert.equal(res.count, 5);
  });

  test('count decimal é truncado para inteiro', async ({ assert }) => {
    const settings = new RuntimeSettings(
      fakeDb({ password_history: { enabled: true, count: 3.9 } }),
    );
    const res = await resolveEffectivePasswordHistory(settings);
    assert.equal(res.count, 3);
  });
});

test.group('resolveEffectivePasswordExpiration', () => {
  test('ausente → { enabled: false, maxAgeDays: 90 }', async ({ assert }) => {
    const settings = new RuntimeSettings(fakeDb());
    const res = await resolveEffectivePasswordExpiration(settings);
    assert.deepEqual(res, { enabled: false, maxAgeDays: 90 });
  });

  test('setting com enabled=true, maxAgeDays=30', async ({ assert }) => {
    const settings = new RuntimeSettings(
      fakeDb({ password_expiration: { enabled: true, maxAgeDays: 30 } }),
    );
    const res = await resolveEffectivePasswordExpiration(settings);
    assert.deepEqual(res, { enabled: true, maxAgeDays: 30 });
  });

  test('maxAgeDays inválido (<1) cai no default 90', async ({ assert }) => {
    const settings = new RuntimeSettings(
      fakeDb({ password_expiration: { enabled: true, maxAgeDays: 0 } }),
    );
    const res = await resolveEffectivePasswordExpiration(settings);
    assert.equal(res.maxAgeDays, 90);
  });
});

test.group('resolveEffectiveRequireVerifiedEmailFull', () => {
  test('ausente → { enabled: false, graceDays: 0 }', async ({ assert }) => {
    const settings = new RuntimeSettings(fakeDb());
    const res = await resolveEffectiveRequireVerifiedEmailFull(false, settings);
    assert.deepEqual(res, { enabled: false, graceDays: 0 });
  });

  test('com graceDays=7', async ({ assert }) => {
    const settings = new RuntimeSettings(
      fakeDb({ require_verified_email: { enabled: true, graceDays: 7 } }),
    );
    const res = await resolveEffectiveRequireVerifiedEmailFull(false, settings);
    assert.deepEqual(res, { enabled: true, graceDays: 7 });
  });

  test('graceDays negativo → 0', async ({ assert }) => {
    const settings = new RuntimeSettings(
      fakeDb({ require_verified_email: { enabled: true, graceDays: -5 } }),
    );
    const res = await resolveEffectiveRequireVerifiedEmailFull(false, settings);
    assert.equal(res.graceDays, 0);
  });

  test('sem graceDays → 0', async ({ assert }) => {
    const settings = new RuntimeSettings(fakeDb({ require_verified_email: { enabled: true } }));
    const res = await resolveEffectiveRequireVerifiedEmailFull(true, settings);
    assert.deepEqual(res, { enabled: true, graceDays: 0 });
  });
});

// ---------------------------------------------------------------------------
// buildPasswordHistory — testes com DB em memória
// ---------------------------------------------------------------------------

test.group('buildPasswordHistory — integração SQLite', (group) => {
  let db: any;

  group.each.setup(async () => {
    db = createTestDatabase();
    BaseModel.useAdapter(db.modelAdapter());

    // Cria tabela de histórico.
    await db.connection().schema.createTable('auth_password_history', (t: any) => {
      t.increments('id').primary();
      t.string('account_id').notNullable();
      t.string('password_hash').notNullable();
      t.timestamp('created_at').notNullable();
    });

    return async () => db.manager.closeAll();
  });

  // Cria um contexto mínimo para o buildPasswordHistory.
  function makeCtx() {
    return {
      Model: null as any,
      mfaIssuer: 'test',
      recoveryCodeCount: 8,
      passwords: {} as any,
      sealSecret: async (s: string) => s,
      openSecret: async (s: string | null | undefined) => s ?? null,
      toAccount: (r: any) => r,
      // Verificador simples: HASH:<plain>
      nativeVerifyHash: async (hash: string, plain: string) => hash === `HASH:${plain}`,
    };
  }

  test('isPasswordReused → false quando sem histórico', async ({ assert }) => {
    const ctx = makeCtx();
    const cap = buildPasswordHistory(ctx, db);
    const reused = await cap.isPasswordReused('u1', 'HASH:newPass', 5);
    assert.isFalse(reused);
  });

  test('recordPasswordHistory grava o hash corretamente', async ({ assert }) => {
    const ctx = makeCtx();
    const cap = buildPasswordHistory(ctx, db);
    await cap.recordPasswordHistory('u1', 'HASH:oldPass');

    const rows = await db.query().from('auth_password_history').where('account_id', 'u1');
    assert.lengthOf(rows, 1);
    assert.equal(rows[0].password_hash, 'HASH:oldPass');
  });

  test('isPasswordReused → true quando senha já foi usada', async ({ assert }) => {
    const ctx = makeCtx();
    const cap = buildPasswordHistory(ctx, db);
    await cap.recordPasswordHistory('u1', 'HASH:oldPass');

    // Verifica reutilização: plain = 'oldPass', hash = 'HASH:oldPass' → matches.
    const reused = await cap.isPasswordReused('u1', 'oldPass', 5);
    assert.isTrue(reused);
  });

  test('isPasswordReused → false para senha nova diferente', async ({ assert }) => {
    const ctx = makeCtx();
    const cap = buildPasswordHistory(ctx, db);
    await cap.recordPasswordHistory('u1', 'HASH:oldPass');

    const reused = await cap.isPasswordReused('u1', 'newPass', 5);
    assert.isFalse(reused);
  });

  test('isPasswordReused respeita o count (verifica só os últimos N)', async ({ assert }) => {
    const ctx = makeCtx();
    const cap = buildPasswordHistory(ctx, db);

    // Grava 6 senhas com timestamps distintos para garantir ordenação correta.
    // SQLite pode retornar mesma ordem em timestamps iguais — forçamos datas distintas.
    const baseTime = new Date('2024-01-01T00:00:00.000Z');
    for (let i = 0; i < 6; i++) {
      const ts = new Date(baseTime.getTime() + i * 1000).toISOString();
      await db.table('auth_password_history').insert({
        account_id: 'u1',
        password_hash: `HASH:pass${i}`,
        created_at: ts,
      });
    }

    // Com count=5, as últimas 5 são: pass1, pass2, pass3, pass4, pass5.
    // pass0 está fora do window → não deve ser rejeitada.
    const reusedOld = await cap.isPasswordReused('u1', 'pass0', 5);
    assert.isFalse(reusedOld, 'pass0 está fora da janela de 5 → deve ser permitida');

    const reusedRecent = await cap.isPasswordReused('u1', 'pass5', 5);
    assert.isTrue(reusedRecent, 'pass5 está na janela → deve ser rejeitada');
  });

  test('prunePasswordHistory poda além dos últimos N', async ({ assert }) => {
    const ctx = makeCtx();
    const cap = buildPasswordHistory(ctx, db);

    // Grava 8 entradas com timestamps distintos para garantir ordenação correta.
    const baseTime = new Date('2024-01-01T00:00:00.000Z');
    for (let i = 0; i < 8; i++) {
      const ts = new Date(baseTime.getTime() + i * 1000).toISOString();
      await db.table('auth_password_history').insert({
        account_id: 'u1',
        password_hash: `HASH:pass${i}`,
        created_at: ts,
      });
    }

    await cap.prunePasswordHistory('u1', 5);

    const rows = await db.query().from('auth_password_history').where('account_id', 'u1');
    // Deve manter exatamente 5 (as mais recentes).
    assert.lengthOf(rows, 5);
  });

  test('isPasswordReused não é afetado pela conta de outro usuário', async ({ assert }) => {
    const ctx = makeCtx();
    const cap = buildPasswordHistory(ctx, db);
    await cap.recordPasswordHistory('u1', 'HASH:sharedPass');

    const reusedU2 = await cap.isPasswordReused('u2', 'sharedPass', 5);
    assert.isFalse(reusedU2, 'histórico de u1 não deve afetar u2');

    const reusedU1 = await cap.isPasswordReused('u1', 'sharedPass', 5);
    assert.isTrue(reusedU1);
  });

  test('sem tabela → isPasswordReused retorna false (fail-safe)', async ({ assert }) => {
    // DB que simula erro na query (lança ao tentar usar query builder).
    const brokenDb = {
      query: () => {
        throw new Error('table missing');
      },
      table: () => {
        throw new Error('table missing');
      },
    };
    const ctx = makeCtx();
    const cap = buildPasswordHistory(ctx, brokenDb);
    const reused = await cap.isPasswordReused('u1', 'anyPass', 5);
    assert.isFalse(reused, 'sem tabela → não bloqueia (fail-safe)');
  });
});

// ---------------------------------------------------------------------------
// buildPasswordExpiration — testes com model Lucid + coluna passwordChangedAt
// ---------------------------------------------------------------------------

test.group('buildPasswordExpiration — integração SQLite', (group) => {
  let db: any;

  group.each.setup(async () => {
    db = createTestDatabase();
    BaseModel.useAdapter(db.modelAdapter());

    await db.connection().schema.createTable('auth_users_exp', (t: any) => {
      t.string('id').primary();
      t.string('email').notNullable();
      t.string('password').notNullable();
      t.text('global_roles').nullable();
      t.timestamp('password_changed_at').nullable();
    });

    return async () => db.manager.closeAll();
  });

  function makeExpModel() {
    class AuthUserExp extends compose(BaseModel, withAuthUser()) {
      static table = 'auth_users_exp';

      @column({ isPrimary: true })
      declare id: string;

      @column.dateTime({ columnName: 'password_changed_at' })
      declare passwordChangedAt: DateTime | null;
    }
    return AuthUserExp;
  }

  test('getPasswordChangedAt → null quando coluna é NULL', async ({ assert }) => {
    const Model = makeExpModel();
    await Model.create({ id: 'u1', email: 'a@b.com', password: 'pass', passwordChangedAt: null });

    const ctx = {
      Model,
      passwords: {} as any,
      mfaIssuer: '',
      recoveryCodeCount: 8,
      sealSecret: async (s: string) => s,
      openSecret: async (s: any) => s,
      toAccount: (r: any) => r,
    };
    const cap = buildPasswordExpiration(ctx as any);
    const changedAt = await cap.getPasswordChangedAt('u1');
    assert.isNull(changedAt);
  });

  test('getPasswordChangedAt → Date quando coluna está preenchida', async ({ assert }) => {
    const Model = makeExpModel();
    const now = DateTime.now();
    await Model.create({ id: 'u1', email: 'a@b.com', password: 'pass', passwordChangedAt: now });

    const ctx = {
      Model,
      passwords: {} as any,
      mfaIssuer: '',
      recoveryCodeCount: 8,
      sealSecret: async (s: string) => s,
      openSecret: async (s: any) => s,
      toAccount: (r: any) => r,
    };
    const cap = buildPasswordExpiration(ctx as any);
    const changedAt = await cap.getPasswordChangedAt('u1');
    assert.instanceOf(changedAt, Date);
  });

  test('touchPasswordChangedAt atualiza a coluna', async ({ assert }) => {
    const Model = makeExpModel();
    await Model.create({ id: 'u1', email: 'a@b.com', password: 'pass', passwordChangedAt: null });

    const ctx = {
      Model,
      passwords: {} as any,
      mfaIssuer: '',
      recoveryCodeCount: 8,
      sealSecret: async (s: string) => s,
      openSecret: async (s: any) => s,
      toAccount: (r: any) => r,
    };
    const cap = buildPasswordExpiration(ctx as any);
    await cap.touchPasswordChangedAt('u1');

    const changedAt = await cap.getPasswordChangedAt('u1');
    assert.instanceOf(changedAt, Date);
  });
});

// ---------------------------------------------------------------------------
// lucidAccountStore — capability probing
// ---------------------------------------------------------------------------

test.group('lucidAccountStore — password expiration capability-probed', (group) => {
  let db: any;

  group.each.setup(async () => {
    db = createTestDatabase();
    BaseModel.useAdapter(db.modelAdapter());

    await db.connection().schema.createTable('auth_users_exp2', (t: any) => {
      t.string('id').primary();
      t.string('email').notNullable();
      t.string('password').notNullable();
      t.text('global_roles').nullable();
      t.timestamp('password_changed_at').nullable();
    });

    return async () => db.manager.closeAll();
  });

  test('store com passwordChangedAt expõe PasswordExpirationCapability', ({ assert }) => {
    class AuthUserWithExp extends compose(BaseModel, withAuthUser()) {
      static table = 'auth_users_exp2';

      @column({ isPrimary: true })
      declare id: string;

      @column.dateTime({ columnName: 'password_changed_at' })
      declare passwordChangedAt: DateTime | null;
    }

    const store = lucidAccountStore(AuthUserWithExp);
    assert.isFunction(store.getPasswordChangedAt, 'getPasswordChangedAt deve estar presente');
    assert.isFunction(store.touchPasswordChangedAt, 'touchPasswordChangedAt deve estar presente');
  });

  test('store SEM passwordChangedAt NÃO expõe PasswordExpirationCapability', ({ assert }) => {
    class AuthUserWithoutExp extends compose(BaseModel, withAuthUser()) {
      static table = 'auth_users_exp2';

      @column({ isPrimary: true })
      declare id: string;
    }

    const store = lucidAccountStore(AuthUserWithoutExp);
    assert.isUndefined(store.getPasswordChangedAt, 'getPasswordChangedAt não deve existir');
  });
});
