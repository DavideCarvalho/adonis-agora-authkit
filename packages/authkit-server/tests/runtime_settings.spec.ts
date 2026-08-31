import { test } from '@japa/runner';
import { RuntimeSettings, supportsSettings } from '../src/host/runtime_settings.js';

// ---------- helpers ----------

/** Minimal DB-like object simulating auth_settings table present. */
/**
 * fakeDb — simula auth_settings com escopo (key, organization_id).
 * rows é populado como settings GLOBAIS (organization_id = null).
 */
function fakeDb(rows: Record<string, string> = {}) {
  const storeKey = (key: string, orgId: string | null) => `${key}|${orgId ?? ''}`;
  const store = new Map<
    string,
    { key: string; org_id: string | null; value: string; updatedAt: Date; updatedBy: string | null }
  >(
    Object.entries(rows).map(([k, v]) => [
      storeKey(k, null),
      { key: k, org_id: null, value: v, updatedAt: new Date(), updatedBy: null },
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
        const keyVal = keyFilter.val!;
        const orgId: string | null = orgFilter ? (orgFilter.isNull ? null : orgFilter.val) : null;
        const sk = storeKey(keyVal, orgId);
        const v = store.get(sk);
        if (!v) return null;
        return {
          key: v.key,
          organization_id: v.org_id,
          value: v.value,
          updated_at: v.updatedAt,
          updated_by: v.updatedBy,
        };
      },
      async delete() {
        const keyFilter = filters.find((f) => f.col === 'key');
        const orgFilter = filters.find((f) => f.col === 'organization_id');
        if (!keyFilter) return;
        const keyVal = keyFilter.val!;
        const orgId: string | null = orgFilter ? (orgFilter.isNull ? null : orgFilter.val) : null;
        store.delete(storeKey(keyVal, orgId));
      },
    };
  }

  return {
    _hasTable: true,
    from(name: string) {
      return this.table(name);
    },
    table(_name: string) {
      const allRows = () =>
        [...store.values()].map((v) => ({
          key: v.key,
          organization_id: v.org_id,
          value: v.value,
          updated_at: v.updatedAt,
          updated_by: v.updatedBy,
        }));
      return {
        where(col: string, val: string) {
          return makeChain([{ col, val, isNull: false }]);
        },
        whereNull(col: string) {
          return makeChain([{ col, val: null, isNull: true }]);
        },
        // select() returns chainable with .limit() and .then() for probe + listSettings.
        select(_cols?: string) {
          const rows = allRows();
          return {
            where(col: string, val: string) {
              const filtered = rows.filter((r) => (r as any)[col] === val);
              return {
                limit(_n: number) {
                  return Promise.resolve(filtered.slice(0, _n));
                },
                then(resolve: any, reject: any) {
                  return Promise.resolve(filtered).then(resolve, reject);
                },
              };
            },
            whereNull(col: string) {
              const filtered = rows.filter(
                (r) => (r as any)[col] === null || (r as any)[col] === undefined,
              );
              return {
                limit(_n: number) {
                  return Promise.resolve(filtered.slice(0, _n));
                },
                then(resolve: any, reject: any) {
                  return Promise.resolve(filtered).then(resolve, reject);
                },
              };
            },
            limit(_n: number) {
              return Promise.resolve(rows.slice(0, _n));
            },
            then(resolve: any, reject: any) {
              return Promise.resolve(rows).then(resolve, reject);
            },
          };
        },
        async insert(row: any) {
          const orgId: string | null = row.organization_id ?? null;
          const sk = storeKey(row.key, orgId);
          store.set(sk, {
            key: row.key,
            org_id: orgId,
            value: row.value,
            updatedAt: row.updated_at ?? new Date(),
            updatedBy: row.updated_by ?? null,
          });
        },
      };
    },
    __store: store,
  };
}

function noTableDb() {
  return {
    // table() throws → probe catches it → tablePresent = false (searchPath-aware probe).
    from() {
      return this.table();
    },
    table() {
      throw new Error('table does not exist');
    },
  };
}

function throwingDb() {
  return {
    // table() throws → probe catches → fail-safe (tablePresent = false).
    from() {
      return this.table();
    },
    table() {
      throw new Error('db is down');
    },
  };
}

// ---------- tests ----------

test.group('RuntimeSettings', () => {
  test('supportsSettings: true when getSetting present', ({ assert }) => {
    const obj = {
      getSetting: async () => null,
      setSetting: async () => {},
      deleteSetting: async () => {},
      listSettings: async () => [],
    };
    assert.isTrue(supportsSettings(obj));
  });

  test('supportsSettings: false when getSetting absent', ({ assert }) => {
    assert.isFalse(supportsSettings({}));
    assert.isFalse(supportsSettings({ setSetting: async () => {} }));
  });

  test('getSetting returns null when table absent (capability probe)', async ({ assert }) => {
    const settings = new RuntimeSettings(noTableDb() as any);
    const value = await settings.getSetting('bot_protection');
    assert.isNull(value);
  });

  test('getSetting returns null when DB throws during probe (fail-safe)', async ({ assert }) => {
    const settings = new RuntimeSettings(throwingDb() as any);
    const value = await settings.getSetting('bot_protection');
    assert.isNull(value);
  });

  test('getSetting returns parsed JSON value when row exists', async ({ assert }) => {
    const db = fakeDb({ bot_protection: JSON.stringify({ enabled: true, on: ['login'] }) });
    const settings = new RuntimeSettings(db as any);
    const value = await settings.getSetting('bot_protection');
    assert.deepEqual(value, { enabled: true, on: ['login'] });
  });

  test('getSetting returns null when key does not exist', async ({ assert }) => {
    const db = fakeDb({});
    const settings = new RuntimeSettings(db as any);
    const value = await settings.getSetting('nonexistent');
    assert.isNull(value);
  });

  test('cache: second call within TTL does not re-query DB', async ({ assert }) => {
    let queryCalls = 0;
    function makeChain() {
      return {
        where(_col: string, _val: string) {
          return makeChain();
        },
        whereNull(_col: string) {
          return makeChain();
        },
        async first() {
          queryCalls++;
          return {
            key: 'bot_protection',
            organization_id: null,
            value: JSON.stringify({ enabled: false }),
            updated_at: new Date(),
            updated_by: null,
          };
        },
        async delete() {},
      };
    }
    const db = {
      from(name: string) {
        return this.table(name);
      },
      table(_name: string) {
        return {
          // Probe: select().limit() → resolves (table present)
          select(_cols?: string) {
            return {
              limit(_n: number) {
                return Promise.resolve([]);
              },
            };
          },
          where(_col: string, _val: string) {
            return makeChain();
          },
          whereNull(_col: string) {
            return makeChain();
          },
        };
      },
    };
    const settings = new RuntimeSettings(db as any, { ttlMs: 5000 });
    await settings.getSetting('bot_protection');
    await settings.getSetting('bot_protection');
    assert.equal(queryCalls, 1, 'DB should be queried only once within TTL');
  });

  test('cache: invalidate() clears cache, next call re-queries', async ({ assert }) => {
    let queryCalls = 0;
    function makeChain() {
      return {
        where(_col: string, _val: string) {
          return makeChain();
        },
        whereNull(_col: string) {
          return makeChain();
        },
        async first() {
          queryCalls++;
          return {
            key: 'bot_protection',
            organization_id: null,
            value: JSON.stringify({ enabled: false }),
            updated_at: new Date(),
            updated_by: null,
          };
        },
        async delete() {},
      };
    }
    const db = {
      from(name: string) {
        return this.table(name);
      },
      table(_name: string) {
        return {
          // Probe: select().limit() → resolves (table present)
          select(_cols?: string) {
            return {
              limit(_n: number) {
                return Promise.resolve([]);
              },
            };
          },
          where(_col: string, _val: string) {
            return makeChain();
          },
          whereNull(_col: string) {
            return makeChain();
          },
        };
      },
    };
    const settings = new RuntimeSettings(db as any, { ttlMs: 60000 });
    await settings.getSetting('bot_protection');
    settings.invalidate();
    await settings.getSetting('bot_protection');
    assert.equal(queryCalls, 2, 'DB should be queried again after invalidate()');
  });

  test('listSettings returns empty array when table absent', async ({ assert }) => {
    const settings = new RuntimeSettings(noTableDb() as any);
    const list = await settings.listSettings();
    assert.deepEqual(list, []);
  });

  test('listSettings returns all rows', async ({ assert }) => {
    const db = fakeDb({ key1: '"val1"', key2: '"val2"' });
    const settings = new RuntimeSettings(db as any);
    const list = await settings.listSettings();
    assert.lengthOf(list, 2);
    assert.isTrue(list.some((r) => r.key === 'key1'));
    assert.isTrue(list.some((r) => r.key === 'key2'));
  });
});

// ---- searchPath-aware probe + named connection tests ----

test.group('RuntimeSettings — searchPath-aware probe', () => {
  test('probe via SELECT detects table present (select resolves)', async ({ assert }) => {
    // The probe uses table().select('key').limit(1) — if it resolves, table is present.
    const db = fakeDb({ bot_protection: JSON.stringify({ enabled: true }) });
    const settings = new RuntimeSettings(db as any);
    assert.isTrue(await settings.isTablePresent());
  });

  test('probe via SELECT detects table absent (table() throws)', async ({ assert }) => {
    // If table() throws (e.g. table not in search_path), probe catches → absent.
    const settings = new RuntimeSettings(noTableDb() as any);
    assert.isFalse(await settings.isTablePresent());
  });

  test('probe result is cached — table() called only once across multiple operations', async ({
    assert,
  }) => {
    let tableCallCount = 0;
    const db = {
      from(name: string) {
        return this.table(name);
      },
      table(_name: string) {
        tableCallCount++;
        function makeChain() {
          return {
            where(_c: string, _v: string) {
              return makeChain();
            },
            whereNull(_c: string) {
              return makeChain();
            },
            async first() {
              return null;
            },
          };
        }
        return {
          select(_cols?: string) {
            return {
              limit(_n: number) {
                return Promise.resolve([]);
              },
            };
          },
          where(_c: string, _v: string) {
            return makeChain();
          },
          whereNull(_c: string) {
            return makeChain();
          },
        };
      },
    };
    const settings = new RuntimeSettings(db as any);
    await settings.getSetting('foo');
    await settings.getSetting('bar');
    await settings.isTablePresent();
    // probe happens on first access; subsequent calls use cache.
    assert.equal(
      tableCallCount,
      3,
      'table() called once for probe, then once per getSetting (queries)',
    );
    // tablePresent should be true from the probe
    assert.isTrue(await settings.isTablePresent());
  });

  test('probe result NOT invalidated by invalidate() — tablePresent cache is separate', async ({
    assert,
  }) => {
    let tableCallCount = 0;
    const db = {
      from(name: string) {
        return this.table(name);
      },
      table(_name: string) {
        tableCallCount++;
        function makeChain() {
          return {
            where(_c: string, _v: string) {
              return makeChain();
            },
            whereNull(_c: string) {
              return makeChain();
            },
            async first() {
              return null;
            },
          };
        }
        return {
          select(_cols?: string) {
            return {
              limit(_n: number) {
                return Promise.resolve([]);
              },
            };
          },
          where(_c: string, _v: string) {
            return makeChain();
          },
          whereNull(_c: string) {
            return makeChain();
          },
        };
      },
    };
    const settings = new RuntimeSettings(db as any);
    await settings.isTablePresent();
    settings.invalidate(); // clears value cache, NOT tablePresent
    await settings.isTablePresent();
    // tablePresent was not re-probed (still cached)
    assert.isTrue(await settings.isTablePresent());
  });
});

test.group('RuntimeSettings — named connection option', () => {
  test('connection option: uses db.connection(name) for all ops', async ({ assert }) => {
    const namedConns: string[] = [];
    // db.connection(name) returns a connection-like object.
    const db = {
      connection(name: string) {
        namedConns.push(name);
        function makeChain() {
          return {
            where(_c: string, _v: string) {
              return makeChain();
            },
            whereNull(_c: string) {
              return makeChain();
            },
            async first() {
              return null;
            },
          };
        }
        return {
          from(...args: any[]) {
            return (this as any).table(...args);
          },
          table(_tableName: string) {
            return {
              select(_cols?: string) {
                return {
                  limit(_n: number) {
                    return Promise.resolve([]);
                  },
                };
              },
              where(_c: string, _v: string) {
                return makeChain();
              },
              whereNull(_c: string) {
                return makeChain();
              },
            };
          },
        };
      },
    };
    const settings = new RuntimeSettings(db as any, { connection: 'auth' });
    await settings.getSetting('test_key');
    assert.isTrue(
      namedConns.every((n) => n === 'auth'),
      'all calls used the named connection',
    );
    assert.isTrue(namedConns.length > 0, 'at least one named connection call was made');
  });

  test('connection option absent: uses db directly (back-compat)', async ({ assert }) => {
    let directTableCalled = false;
    const db = {
      from(name: string) {
        return this.table(name);
      },
      table(_name: string) {
        directTableCalled = true;
        function makeChain() {
          return {
            where(_c: string, _v: string) {
              return makeChain();
            },
            whereNull(_c: string) {
              return makeChain();
            },
            async first() {
              return null;
            },
          };
        }
        return {
          select(_cols?: string) {
            return {
              limit(_n: number) {
                return Promise.resolve([]);
              },
            };
          },
          where(_c: string, _v: string) {
            return makeChain();
          },
          whereNull(_c: string) {
            return makeChain();
          },
        };
      },
      connection(_name: string) {
        throw new Error('should not be called when no connectionName');
      },
    };
    const settings = new RuntimeSettings(db as any); // no connection option
    await settings.getSetting('test_key');
    assert.isTrue(directTableCalled);
  });

  test('named connection with table present returns settings correctly', async ({ assert }) => {
    const settingValue = { enabled: true, on: ['login'] };
    const db = {
      connection(_name: string) {
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
              if (keyFilter?.val === 'bot_protection') {
                return {
                  key: 'bot_protection',
                  organization_id: null,
                  value: JSON.stringify(settingValue),
                  updated_at: new Date(),
                  updated_by: null,
                };
              }
              return null;
            },
          };
        }
        return {
          from(...args: any[]) {
            return (this as any).table(...args);
          },
          table(_tableName: string) {
            return {
              select(_cols?: string) {
                return {
                  limit(_n: number) {
                    return Promise.resolve([
                      {
                        key: 'bot_protection',
                        organization_id: null,
                        value: JSON.stringify(settingValue),
                      },
                    ]);
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
      },
    };
    const settings = new RuntimeSettings(db as any, { connection: 'auth' });
    const val = await settings.getSetting('bot_protection');
    assert.deepEqual(val, settingValue);
  });

  test('named connection with table absent (throws) → fail-safe null', async ({ assert }) => {
    const db = {
      connection(_name: string) {
        return {
          from(...args: any[]) {
            return (this as any).table(...args);
          },
          table(_tableName: string) {
            throw new Error('relation does not exist');
          },
        };
      },
    };
    const settings = new RuntimeSettings(db as any, { connection: 'auth' });
    const val = await settings.getSetting('bot_protection');
    assert.isNull(val);
    assert.isFalse(await settings.isTablePresent());
  });
});

// ---- lucidAccountStore connectionName tests ----

import { lucidAccountStore } from '../src/accounts/lucid_account_store.js';

test.group('lucidAccountStore — connectionName', () => {
  test('connectionName reflects Model.connection when set', ({ assert }) => {
    class FakeModel {
      static connection = 'auth';
      static $columnsDefinitions = new Map([
        ['id', { columnName: 'id' }],
        ['email', { columnName: 'email' }],
        ['password', { columnName: 'password' }],
        ['globalRoles', { columnName: 'global_roles' }],
      ]);
      static $hooks = { has: () => false };
      static findBy = async () => null;
      static find = async () => null;
    }
    const store = lucidAccountStore(FakeModel as any);
    assert.equal((store as any).connectionName, 'auth');
  });

  test('connectionName is undefined when Model.connection is not set', ({ assert }) => {
    class FakeModel {
      static $columnsDefinitions = new Map([
        ['id', { columnName: 'id' }],
        ['email', { columnName: 'email' }],
        ['password', { columnName: 'password' }],
        ['globalRoles', { columnName: 'global_roles' }],
      ]);
      static $hooks = { has: () => false };
      static findBy = async () => null;
      static find = async () => null;
    }
    const store = lucidAccountStore(FakeModel as any);
    assert.isUndefined((store as any).connectionName);
  });
});

// ---- resolveEffectiveBotProtection tests (added in Task 2) ----

import type { ResolvedBotProtectionConfig } from '../src/host/bot_protection.js';
import { resolveEffectiveBotProtection } from '../src/host/bot_protection.js';

test.group('resolveEffectiveBotProtection', () => {
  const verifyFn = async () => true;
  const configBot: ResolvedBotProtectionConfig = {
    verify: verifyFn,
    on: ['login', 'signup'],
    tokenFields: ['cf-turnstile-response'],
    timeoutMs: 5000,
  };

  test('no config → undefined regardless of setting', async ({ assert }) => {
    const settings = new RuntimeSettings(noTableDb() as any);
    const result = await resolveEffectiveBotProtection(undefined, settings);
    assert.isUndefined(result);
  });

  test('no setting (table absent) → returns config as-is', async ({ assert }) => {
    const settings = new RuntimeSettings(noTableDb() as any);
    const result = await resolveEffectiveBotProtection(configBot, settings);
    assert.deepEqual(result, configBot);
  });

  test('setting { enabled: false } → returns undefined (protection off)', async ({ assert }) => {
    const db = fakeDb({ bot_protection: JSON.stringify({ enabled: false }) });
    const settings = new RuntimeSettings(db as any);
    const result = await resolveEffectiveBotProtection(configBot, settings);
    assert.isUndefined(result);
  });

  test('setting { enabled: true } with no "on" → uses config.on', async ({ assert }) => {
    const db = fakeDb({ bot_protection: JSON.stringify({ enabled: true }) });
    const settings = new RuntimeSettings(db as any);
    const result = await resolveEffectiveBotProtection(configBot, settings);
    assert.deepEqual(result!.on, configBot.on);
    assert.strictEqual(result!.verify, verifyFn);
  });

  test('setting { enabled: true, on: ["reset"] } → overrides config.on', async ({ assert }) => {
    const db = fakeDb({ bot_protection: JSON.stringify({ enabled: true, on: ['reset'] }) });
    const settings = new RuntimeSettings(db as any);
    const result = await resolveEffectiveBotProtection(configBot, settings);
    assert.deepEqual(result!.on, ['reset']);
    assert.strictEqual(result!.verify, verifyFn);
  });

  test('setting with DB error (fail-safe) → returns config as-is', async ({ assert }) => {
    const settings = new RuntimeSettings(throwingDb() as any);
    const result = await resolveEffectiveBotProtection(configBot, settings);
    assert.deepEqual(result, configBot);
  });
});
