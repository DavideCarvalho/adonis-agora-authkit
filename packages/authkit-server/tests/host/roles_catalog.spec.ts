/**
 * Tests for roles_catalog runtime setting:
 *   - resolveEffectiveRolesCatalog (resolver)
 *   - AdminUsersService.setGlobalRolesValidated (catalog validation)
 *   - checkRolesCatalog (doctor check)
 *   - SETTING_KEYS.ROLES_CATALOG (registry)
 */

import { test } from '@japa/runner';
import type { DoctorInput } from '../../src/doctor/checks.js';
import { checkRolesCatalog } from '../../src/doctor/checks.js';
import { AdminUsersService } from '../../src/host/admin_api/admin_users_service.js';
import { RuntimeSettings } from '../../src/host/runtime_settings.js';
import {
  ROLES_CATALOG_DEFAULT,
  resolveEffectiveRolesCatalog,
  SETTING_KEYS,
} from '../../src/host/runtime_toggles.js';

// ---------------------------------------------------------------------------
// Helpers (shared with runtime_toggles.spec.ts pattern)
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

function noTableDb() {
  return {
    from() {
      return this.table();
    },
    table() {
      throw new Error('no table');
    },
  };
}

function throwingDb() {
  return {
    from() {
      return this.table();
    },
    table() {
      throw new Error('db down');
    },
  };
}

function settings(db: any) {
  return new RuntimeSettings(db as any);
}

// ---------------------------------------------------------------------------
// SETTING_KEYS registry
// ---------------------------------------------------------------------------

test.group('SETTING_KEYS.ROLES_CATALOG', () => {
  test('ROLES_CATALOG key is registered as roles_catalog', ({ assert }) => {
    assert.equal(SETTING_KEYS.ROLES_CATALOG, 'roles_catalog');
  });
});

// ---------------------------------------------------------------------------
// ROLES_CATALOG_DEFAULT
// ---------------------------------------------------------------------------

test.group('ROLES_CATALOG_DEFAULT', () => {
  test('default contains ADMIN role', ({ assert }) => {
    const admin = ROLES_CATALOG_DEFAULT.roles.find((r) => r.name === 'ADMIN');
    assert.isDefined(admin);
  });

  test('default ADMIN has a description', ({ assert }) => {
    const admin = ROLES_CATALOG_DEFAULT.roles.find((r) => r.name === 'ADMIN');
    assert.isString(admin?.description);
  });
});

// ---------------------------------------------------------------------------
// resolveEffectiveRolesCatalog — core resolver
// ---------------------------------------------------------------------------

test.group('resolveEffectiveRolesCatalog', () => {
  // ---- setting absent ----

  test('no table → default (ADMIN)', async ({ assert }) => {
    const s = settings(noTableDb());
    const result = await resolveEffectiveRolesCatalog(s);
    assert.equal(result.roles.length, 1);
    assert.equal(result.roles[0].name, 'ADMIN');
  });

  test('DB error → default (fail-safe)', async ({ assert }) => {
    const s = settings(throwingDb());
    const result = await resolveEffectiveRolesCatalog(s);
    assert.equal(result.roles[0].name, 'ADMIN');
  });

  test('setting absent → default', async ({ assert }) => {
    const s = settings(fakeDb({}));
    const result = await resolveEffectiveRolesCatalog(s);
    assert.equal(result.roles[0].name, 'ADMIN');
  });

  // ---- setting present ----

  test('setting with ADMIN + EDITOR → both roles sorted', async ({ assert }) => {
    const s = settings(
      fakeDb({
        roles_catalog: {
          roles: [
            { name: 'EDITOR', description: 'Content editor' },
            { name: 'ADMIN', description: 'Full access' },
          ],
        },
      }),
    );
    const result = await resolveEffectiveRolesCatalog(s);
    assert.equal(result.roles.length, 2);
    // Sorted alphabetically: ADMIN < EDITOR
    assert.equal(result.roles[0].name, 'ADMIN');
    assert.equal(result.roles[1].name, 'EDITOR');
  });

  // ---- merge defensivo: ADMIN sempre presente ----

  test('setting without ADMIN → ADMIN added (merge defensivo)', async ({ assert }) => {
    const s = settings(
      fakeDb({
        roles_catalog: {
          roles: [{ name: 'VIEWER', description: 'Read only' }, { name: 'EDITOR' }],
        },
      }),
    );
    const result = await resolveEffectiveRolesCatalog(s);
    const names = result.roles.map((r) => r.name);
    assert.include(names, 'ADMIN');
    assert.include(names, 'VIEWER');
    assert.include(names, 'EDITOR');
  });

  // ---- ordenação ----

  test('result is sorted alphabetically by name', async ({ assert }) => {
    const s = settings(
      fakeDb({
        roles_catalog: {
          roles: [{ name: 'ZEBRA' }, { name: 'CONTENT_MANAGER' }, { name: 'ADMIN' }],
        },
      }),
    );
    const result = await resolveEffectiveRolesCatalog(s);
    const names = result.roles.map((r) => r.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(names, sorted);
  });

  // ---- entradas inválidas ----

  test('entries with empty name are discarded', async ({ assert }) => {
    const s = settings(
      fakeDb({
        roles_catalog: {
          roles: [{ name: '' }, { name: '   ' }, { name: 'EDITOR' }, { name: 'ADMIN' }],
        },
      }),
    );
    const result = await resolveEffectiveRolesCatalog(s);
    const names = result.roles.map((r) => r.name);
    assert.notInclude(names, '');
    assert.notInclude(names, '   ');
    assert.include(names, 'EDITOR');
  });

  test('invalid shape (array) → default', async ({ assert }) => {
    const s = settings(fakeDb({ roles_catalog: ['ADMIN', 'EDITOR'] }));
    const result = await resolveEffectiveRolesCatalog(s);
    assert.equal(result.roles.length, 1);
    assert.equal(result.roles[0].name, 'ADMIN');
  });

  test('invalid shape (no roles key) → default', async ({ assert }) => {
    const s = settings(fakeDb({ roles_catalog: { categories: [] } }));
    const result = await resolveEffectiveRolesCatalog(s);
    assert.equal(result.roles[0].name, 'ADMIN');
  });

  // ---- descrição ----

  test('description is preserved when present', async ({ assert }) => {
    const s = settings(
      fakeDb({
        roles_catalog: {
          roles: [
            { name: 'ADMIN', description: 'Admin desc' },
            { name: 'EDITOR', description: 'Edit content' },
          ],
        },
      }),
    );
    const result = await resolveEffectiveRolesCatalog(s);
    const editor = result.roles.find((r) => r.name === 'EDITOR');
    assert.equal(editor?.description, 'Edit content');
  });

  test('empty description string → entry without description key', async ({ assert }) => {
    const s = settings(
      fakeDb({
        roles_catalog: { roles: [{ name: 'ADMIN' }, { name: 'VIEWER', description: '  ' }] },
      }),
    );
    const result = await resolveEffectiveRolesCatalog(s);
    const viewer = result.roles.find((r) => r.name === 'VIEWER');
    assert.isUndefined(viewer?.description);
  });
});

// ---------------------------------------------------------------------------
// AdminUsersService.setGlobalRolesValidated
// ---------------------------------------------------------------------------

test.group('AdminUsersService.setGlobalRolesValidated', () => {
  function makeService(globalRoles: string[] = []) {
    const setGlobalRolesCalls: string[][] = [];
    const cfg: any = {
      accountStore: {
        findById: async () => ({ id: 'u1', globalRoles }),
        setGlobalRoles: async (_id: string, roles: string[]) => {
          setGlobalRolesCalls.push(roles);
        },
      },
    };
    const svc = new AdminUsersService(cfg);
    return { svc, setGlobalRolesCalls };
  }

  test('roles in catalog → accepted (null error)', async ({ assert }) => {
    const { svc } = makeService([]);
    const s = settings(
      fakeDb({
        roles_catalog: { roles: [{ name: 'ADMIN' }, { name: 'EDITOR' }] },
      }),
    );
    const err = await svc.setGlobalRolesValidated('u1', ['ADMIN', 'EDITOR'], s);
    assert.isNull(err);
  });

  test('role unknown and not previously held → rejected with i18n key', async ({ assert }) => {
    const { svc } = makeService(['ADMIN']);
    const s = settings(
      fakeDb({
        roles_catalog: { roles: [{ name: 'ADMIN' }] },
      }),
    );
    // GHOST_ROLE is not in catalog and user did not have it
    const err = await svc.setGlobalRolesValidated('u1', ['ADMIN', 'GHOST_ROLE'], s);
    assert.equal(err, 'admin.roles.unknown_role');
  });

  test('out-of-catalog role that user already has → allowed (removal scenario)', async ({
    assert,
  }) => {
    // User has OLD_ROLE (out of catalog); we still pass it — that means keeping it.
    const { svc, setGlobalRolesCalls } = makeService(['OLD_ROLE', 'ADMIN']);
    const s = settings(
      fakeDb({
        roles_catalog: { roles: [{ name: 'ADMIN' }] },
      }),
    );
    // Keep OLD_ROLE (it's out-of-catalog but user had it): allowed
    const err = await svc.setGlobalRolesValidated('u1', ['ADMIN', 'OLD_ROLE'], s);
    assert.isNull(err);
    assert.deepEqual(setGlobalRolesCalls[0].sort(), ['ADMIN', 'OLD_ROLE'].sort());
  });

  test('out-of-catalog role removed (not in submitted array) → allowed', async ({ assert }) => {
    // User had OLD_ROLE, we submit only ADMIN — that removes OLD_ROLE.
    const { svc, setGlobalRolesCalls } = makeService(['OLD_ROLE', 'ADMIN']);
    const s = settings(
      fakeDb({
        roles_catalog: { roles: [{ name: 'ADMIN' }] },
      }),
    );
    const err = await svc.setGlobalRolesValidated('u1', ['ADMIN'], s);
    assert.isNull(err);
    assert.deepEqual(setGlobalRolesCalls[0], ['ADMIN']);
  });

  test('null settings → all roles accepted (fail-safe)', async ({ assert }) => {
    const { svc, setGlobalRolesCalls } = makeService([]);
    const err = await svc.setGlobalRolesValidated('u1', ['WHATEVER', 'NO_CATALOG'], null);
    assert.isNull(err);
    assert.deepEqual(setGlobalRolesCalls[0].sort(), ['NO_CATALOG', 'WHATEVER'].sort());
  });
});

// ---------------------------------------------------------------------------
// checkRolesCatalog (doctor check)
// ---------------------------------------------------------------------------

function baseInput(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    authkitConfig: {
      issuer: 'https://idp.test/oidc',
      mountPath: '/oidc',
      accountStore: {},
      admin: { enabled: true, roles: ['ADMIN'] },
    },
    sessionConfig: { store: 'redis' },
    peers: { session: true, shield: true, ally: true, limiter: true },
    ...overrides,
  };
}

test.group('checkRolesCatalog', () => {
  test('no rolesCatalogSetting → null (silencioso)', ({ assert }) => {
    const result = checkRolesCatalog(baseInput());
    assert.isNull(result);
  });

  test('valid catalog with admin.roles covered → ok', ({ assert }) => {
    const result = checkRolesCatalog({
      ...baseInput(),
      rolesCatalogSetting: { roles: [{ name: 'ADMIN', description: 'Admin' }, { name: 'EDITOR' }] },
    } as any);
    assert.isNotNull(result);
    assert.equal(result!.level, 'ok');
  });

  test('admin.roles contains role not in catalog → warn', ({ assert }) => {
    const result = checkRolesCatalog({
      ...baseInput({
        authkitConfig: {
          issuer: 'https://idp.test/oidc',
          admin: { enabled: true, roles: ['SUPER_ADMIN'] },
          accountStore: {},
        },
      }),
      rolesCatalogSetting: { roles: [{ name: 'ADMIN' }] },
    } as any);
    assert.isNotNull(result);
    assert.equal(result!.level, 'warn');
    assert.include(result!.message, 'SUPER_ADMIN');
  });

  test('invalid shape → warn', ({ assert }) => {
    const result = checkRolesCatalog({
      ...baseInput(),
      rolesCatalogSetting: ['ADMIN'],
    } as any);
    assert.isNotNull(result);
    assert.equal(result!.level, 'warn');
  });

  test('catalog count appears in ok message', ({ assert }) => {
    const result = checkRolesCatalog({
      ...baseInput(),
      rolesCatalogSetting: { roles: [{ name: 'ADMIN' }, { name: 'EDITOR' }, { name: 'VIEWER' }] },
    } as any);
    assert.isNotNull(result);
    assert.include(result!.message, '3');
  });
});
