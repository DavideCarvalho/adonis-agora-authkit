/**
 * Tests para config locks: settings definidas no defineConfig travam a UI/Admin API.
 *   - deriveLockedSettingKeys (mapa config → setting keys)
 *   - RuntimeSettings honra locks: getSetting → null (config vence); set/delete → throw
 */
import { test } from '@japa/runner';
import {
  deriveLockedSettingKeys,
  isSettingLocked,
  lockedSettingKeys,
  resetLockedSettingKeys,
  SettingLockedError,
  setLockedSettingKeys,
} from '../../src/host/config_locks.js';
import { RuntimeSettings } from '../../src/host/runtime_settings.js';
import { SETTING_KEYS } from '../../src/host/runtime_toggles.js';

test.group('config_locks / deriveLockedSettingKeys', () => {
  test('mapeia campos explícitos do config para as setting keys', ({ assert }) => {
    const locked = deriveLockedSettingKeys({
      registration: { enabled: false },
      authMethods: { password: false },
      lockout: { enabled: true },
      ttl: { accessToken: 900 },
      login: { requireVerifiedEmail: true },
      admin: { impersonation: true },
    });
    assert.includeMembers(locked, [
      SETTING_KEYS.REGISTRATION,
      SETTING_KEYS.AUTH_METHODS,
      SETTING_KEYS.LOCKOUT,
      SETTING_KEYS.TOKEN_TTL,
      SETTING_KEYS.REQUIRE_VERIFIED_EMAIL,
      SETTING_KEYS.ADMIN_IMPERSONATION,
    ]);
  });

  test('authMethods no config trava a key auth_methods', ({ assert }) => {
    assert.include(
      deriveLockedSettingKeys({ authMethods: { password: false } }),
      SETTING_KEYS.AUTH_METHODS,
    );
    // authMethods ausente → não trava (UI/runtime controla).
    assert.notInclude(deriveLockedSettingKeys({}), SETTING_KEYS.AUTH_METHODS);
  });

  test('campos ausentes não travam (UI controla)', ({ assert }) => {
    const locked = deriveLockedSettingKeys({});
    assert.notInclude(locked, SETTING_KEYS.REGISTRATION);
    assert.notInclude(locked, SETTING_KEYS.LOCKOUT);
    assert.lengthOf(locked, 0);
  });

  test('admin sem impersonation NÃO trava admin_impersonation', ({ assert }) => {
    const locked = deriveLockedSettingKeys({ admin: { enabled: true } });
    assert.notInclude(locked, SETTING_KEYS.ADMIN_IMPERSONATION);
  });
});

test.group('config_locks / RuntimeSettings enforcement', (group) => {
  group.each.teardown(() => resetLockedSettingKeys());

  test('getSetting de key travada retorna null (config vence, sem tocar DB)', async ({
    assert,
  }) => {
    setLockedSettingKeys([SETTING_KEYS.REGISTRATION]);
    // db que explode se for usado — prova que o lock retorna antes de tocar no DB.
    const explodingDb = {
      connection: () => {
        throw new Error('DB não deveria ser tocado');
      },
    };
    const rs = new RuntimeSettings(explodingDb as any);
    assert.isNull(await rs.getSetting(SETTING_KEYS.REGISTRATION));
  });

  test('setSetting de key travada lança SettingLockedError', async ({ assert }) => {
    setLockedSettingKeys([SETTING_KEYS.LOCKOUT]);
    const rs = new RuntimeSettings({} as any);
    let caught: unknown;
    try {
      await rs.setSetting(SETTING_KEYS.LOCKOUT, { enabled: false });
    } catch (err) {
      caught = err;
    }
    // A classe e a `key` são o contrato; a mensagem é prosa e pode mudar.
    assert.instanceOf(caught, SettingLockedError);
    assert.equal((caught as SettingLockedError).key, SETTING_KEYS.LOCKOUT);
    assert.equal((caught as SettingLockedError).code, 'E_SETTING_LOCKED');
  });

  test('deleteSetting de key travada lança SettingLockedError', async ({ assert }) => {
    setLockedSettingKeys([SETTING_KEYS.LOCKOUT]);
    const rs = new RuntimeSettings({} as any);
    let caught: unknown;
    try {
      await rs.deleteSetting(SETTING_KEYS.LOCKOUT);
    } catch (err) {
      caught = err;
    }
    assert.instanceOf(caught, SettingLockedError);
    assert.equal((caught as SettingLockedError).key, SETTING_KEYS.LOCKOUT);
  });

  test('isSettingLocked / lockedSettingKeys refletem o registro', ({ assert }) => {
    setLockedSettingKeys([SETTING_KEYS.REGISTRATION, SETTING_KEYS.TOKEN_TTL]);
    assert.isTrue(isSettingLocked(SETTING_KEYS.REGISTRATION));
    assert.isFalse(isSettingLocked(SETTING_KEYS.RATE_LIMIT));
    assert.sameMembers(lockedSettingKeys(), [SETTING_KEYS.REGISTRATION, SETTING_KEYS.TOKEN_TTL]);
  });

  test('key NÃO travada segue o fluxo normal (sem throw no set)', async ({ assert }) => {
    setLockedSettingKeys([SETTING_KEYS.REGISTRATION]);
    // tabela ausente → setSetting é no-op silencioso (não lança) p/ key não travada.
    const rs = new RuntimeSettings({
      connection: () => ({
        from: () => {
          throw new Error('no table');
        },
      }),
    } as any);
    await rs.setSetting(SETTING_KEYS.RATE_LIMIT, { login: { points: 5 } });
    assert.isFalse(isSettingLocked(SETTING_KEYS.RATE_LIMIT));
  });
});
