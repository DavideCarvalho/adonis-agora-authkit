import { test } from '@japa/runner';
import type { ResolvedServerConfig } from '../../src/define_config.js';
import { loginMethodsStateForAccount } from '../../src/host/login_methods_state.js';
import type { SettingsCapability } from '../../src/host/runtime_settings.js';
import { fakeAccountStore } from '../bootstrap.js';

/** Preferences-método do fake store. */
function fakeSettings(value: Record<string, unknown> | null): SettingsCapability {
  return {
    getSetting: async () => value,
  } as unknown as SettingsCapability;
}

function makeConfig(
  overrides: {
    accountStore?: any;
    social?: string[];
    authMethods?: Record<string, boolean>;
    passwordless?: { magicLink?: boolean; passkeyFirst?: boolean };
  } = {},
): ResolvedServerConfig {
  return {
    accountStore:
      overrides.accountStore ??
      fakeAccountStore({
        getLoginMethods: async () => null,
        setLoginMethods: async () => {},
        // Capacidades exigidas para o default de magic link/passkey resolver on.
        issueMagicLinkToken: async () => null,
        listPasskeys: async () => [],
      } as any),
    social: { providers: overrides.social ?? ['google'] } as any,
    authMethods: overrides.authMethods as any,
    passwordless: (overrides.passwordless ?? { magicLink: true, passkeyFirst: true }) as any,
  } as ResolvedServerConfig;
}

test.group('loginMethodsStateForAccount (headless state)', () => {
  test('store sem capacidade → supported false', async ({ assert }) => {
    const cfg = makeConfig({ accountStore: fakeAccountStore() });
    const state = await loginMethodsStateForAccount(
      'u1',
      cfg.accountStore,
      fakeSettings(null),
      cfg,
    );
    assert.isFalse(state.supported);
    assert.isNull(state.available);
  });

  test('sem preferência → métodos globais herdam, tudo disponível', async ({ assert }) => {
    const store = fakeAccountStore({
      getLoginMethods: async () => null,
      issueMagicLinkToken: async () => null,
      listPasskeys: async () => [],
    } as any);
    const cfg = makeConfig({ accountStore: store });
    const state = await loginMethodsStateForAccount(
      'u1',
      cfg.accountStore,
      fakeSettings(null),
      cfg,
    );
    assert.isTrue(state.supported);
    assert.deepEqual(state.methods, {});
    assert.isTrue(state.available?.password);
    assert.isTrue(state.available?.magicLink);
    assert.isTrue(state.available?.passkey);
    assert.deepEqual(state.available?.social, ['google']);
    assert.isFalse(state.locked?.password);
  });

  test('preferência desliga magic link → available reflete e social∩ preferência', async ({
    assert,
  }) => {
    const store = fakeAccountStore({
      getLoginMethods: async () => ({ magicLink: false }),
      issueMagicLinkToken: async () => null,
      listPasskeys: async () => [],
    } as any);
    const cfg = makeConfig({ accountStore: store });
    const state = await loginMethodsStateForAccount(
      'u1',
      cfg.accountStore,
      fakeSettings(null),
      cfg,
    );
    assert.isFalse(state.available?.magicLink);
    assert.isTrue(state.available?.password);
    assert.isTrue(state.available?.passkey);
  });

  test('preferência social desligada → social vazio', async ({ assert }) => {
    const store = fakeAccountStore({
      getLoginMethods: async () => ({ social: false }),
      issueMagicLinkToken: async () => null,
      listPasskeys: async () => [],
    } as any);
    const cfg = makeConfig({ accountStore: store });
    const state = await loginMethodsStateForAccount(
      'u1',
      cfg.accountStore,
      fakeSettings(null),
      cfg,
    );
    assert.deepEqual(state.available?.social, []);
  });

  test('pin de config password:false → available falso e locked true', async ({ assert }) => {
    const store = fakeAccountStore({
      getLoginMethods: async () => null,
      issueMagicLinkToken: async () => null,
      listPasskeys: async () => [],
    } as any);
    const cfg = makeConfig({ accountStore: store, authMethods: { password: false } });
    const state = await loginMethodsStateForAccount(
      'u1',
      cfg.accountStore,
      fakeSettings(null),
      cfg,
    );
    assert.isFalse(state.available?.password);
    assert.isFalse(state.available?.forgotPassword); // derivado
    assert.isTrue(state.locked?.password);
  });

  test('setting global desliga magic link → available false', async ({ assert }) => {
    const store = fakeAccountStore({
      getLoginMethods: async () => null,
      issueMagicLinkToken: async () => null,
      listPasskeys: async () => [],
    } as any);
    const cfg = makeConfig({ accountStore: store });
    const state = await loginMethodsStateForAccount(
      'u1',
      cfg.accountStore,
      fakeSettings({ magicLink: false }),
      cfg,
    );
    assert.isFalse(state.available?.magicLink);
  });
});
