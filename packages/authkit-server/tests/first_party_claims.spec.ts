/**
 * Who receives the authorization claims (`<globalRolesClaim>`, `org_id`,
 * `org_slug`, `org_role`).
 *
 * The gate used to read `config.branding ? isFirstParty(config.branding, id) : false`,
 * so the ABSENCE of a theming block meant "nobody is first-party". On any host
 * that had not customised its look — the common case — every relying party
 * received `globalRoles: []`, silently, while the admin console kept working
 * because it reads roles from the account session rather than from a token.
 * That asymmetry is what made the breakage so hard to see, and it landed on the
 * very feature positioned as "authz is the single authority on roles".
 *
 * An authorization decision must not depend on whether the host picked a colour.
 * The allowlist now lives in its own key, `firstPartyClients`, with
 * `branding.firstParty` kept as a fallback, and NOT declaring one means every
 * registered client is first-party. That is not a free-for-all: the claims are
 * bound to the `roles` scope in the provider, so a client still has to be
 * registered by an admin and to ask for `scope=roles`.
 */

import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import instance from 'oidc-provider/lib/helpers/weak_cache.js';
import { type AuthServerConfigInput, adapters, defineConfig } from '../src/define_config.js';
import { checkFirstPartyClients } from '../src/doctor/checks.js';
import { isFirstPartyClient } from '../src/host/branding.js';
import { OidcService } from '../src/provider/oidc_service.js';
import { fakeAccountStore } from './bootstrap.js';

const ISSUER = 'https://firstparty.test';

async function resolvedConfig(extra: Partial<AuthServerConfigInput> = {}) {
  const fakeApp = {
    container: { make: async () => ({ connection: () => new RedisMock() }) },
  } as any;
  return (await configProvider.resolve(
    fakeApp,
    defineConfig({
      issuer: ISSUER,
      adapter: adapters.redis({ connection: 'main' }),
      jwks: { source: 'managed', algorithm: 'RS256' },
      accountStore: fakeAccountStore({}),
      ...extra,
    }),
  )) as any;
}

const branding = (firstParty: string[]) => ({
  company: 'Acme',
  clients: {},
  default: { appName: 'Acme', accent: '#000', accentSoft: '#111', tagline: 'x' },
  firstParty,
});

test.group('isFirstPartyClient', () => {
  test('no allowlist declared → every client is first-party', ({ assert }) => {
    assert.isTrue(isFirstPartyClient(undefined, 'any-client'));
    assert.isTrue(isFirstPartyClient(undefined, 'another'));
  });

  test('an allowlist is honoured literally', ({ assert }) => {
    assert.isTrue(isFirstPartyClient(['web'], 'web'));
    assert.isFalse(isFirstPartyClient(['web'], 'partner'));
  });

  test('an EMPTY allowlist means nobody — not "no restriction"', ({ assert }) => {
    // Declaring `firstPartyClients: []` is a deliberate "no client gets roles".
    // Collapsing it into the undefined case would silently ignore the operator.
    assert.isFalse(isFirstPartyClient([], 'web'));
  });

  test('no clientId → never first-party (fail closed)', ({ assert }) => {
    assert.isFalse(isFirstPartyClient(undefined, undefined));
    assert.isFalse(isFirstPartyClient(['web'], undefined));
  });
});

test.group('firstPartyClients — resolution', () => {
  test('a host with NO branding block gets no allowlist, so roles are emitted', async ({
    assert,
  }) => {
    const cfg = await resolvedConfig();
    assert.isUndefined(
      cfg.firstPartyClients,
      'this is the regression: no branding must not mean "nobody is first-party"',
    );
    assert.isTrue(isFirstPartyClient(cfg.firstPartyClients, 'web'));
  });

  test('branding.firstParty is still honoured as a fallback', async ({ assert }) => {
    const cfg = await resolvedConfig({ branding: branding(['web']) as any });
    assert.deepEqual(cfg.firstPartyClients, ['web']);
    assert.isTrue(isFirstPartyClient(cfg.firstPartyClients, 'web'));
    assert.isFalse(isFirstPartyClient(cfg.firstPartyClients, 'partner'));
  });

  test('firstPartyClients wins over branding.firstParty', async ({ assert }) => {
    const cfg = await resolvedConfig({
      firstPartyClients: ['api'],
      branding: branding(['web']) as any,
    });
    assert.deepEqual(cfg.firstPartyClients, ['api']);
  });

  test('firstPartyClients works with no branding block at all', async ({ assert }) => {
    const cfg = await resolvedConfig({ firstPartyClients: ['api'] });
    assert.deepEqual(cfg.firstPartyClients, ['api']);
    assert.isFalse(isFirstPartyClient(cfg.firstPartyClients, 'web'));
  });
});

test.group('firstPartyClients — doctor', () => {
  test('warns when no allowlist is declared', async ({ assert }) => {
    const cfg = await resolvedConfig();
    const finding = checkFirstPartyClients({ authkitConfig: cfg } as any);
    assert.equal(finding?.level, 'warn');
    assert.include(finding?.message ?? '', 'firstPartyClients');
  });

  test('reports the allowlist when declared', async ({ assert }) => {
    const cfg = await resolvedConfig({ firstPartyClients: ['api', 'web'] });
    const finding = checkFirstPartyClients({ authkitConfig: cfg } as any);
    assert.equal(finding?.level, 'ok');
    assert.include(finding?.message ?? '', 'api, web');
  });

  test('flags an empty allowlist as the deliberate lockout it is', async ({ assert }) => {
    const cfg = await resolvedConfig({ firstPartyClients: [] });
    const finding = checkFirstPartyClients({ authkitConfig: cfg } as any);
    assert.equal(finding?.level, 'ok');
    assert.include(finding?.message ?? '', 'NO client');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The wiring, not just the helper: what a token actually carries.
//
// The unit tests above pin `isFirstPartyClient`. These go through the provider
// the way a real authorize does — `findAccount` is the seam `oidc_service.ts`
// hands to oidc-provider, and `claims()` is what ends up in the id_token. A
// helper can be right while the call site still passes the wrong argument, and
// that is exactly the shape of the bug being fixed.
// ───────────────────────────────────────────────────────────────────────────

const ACCOUNT = { id: 'u1', email: 'u@x.com', globalRoles: ['ADMIN', 'EDITOR'], name: 'U' };

/** Resolve the claims oidc-provider would put in a token for `clientId`. */
async function claimsFor(cfg: any, clientId: string | undefined) {
  const service = new OidcService(cfg, 'a'.repeat(32));
  const findAccount = (instance(service.provider as any) as any).configuration.findAccount;
  const koaCtx = { oidc: { client: clientId ? { clientId } : undefined } };
  const account = await findAccount(koaCtx, ACCOUNT.id);
  return account.claims('id_token', 'openid roles');
}

const rolesConfig = (extra: Partial<AuthServerConfigInput> = {}) =>
  resolvedConfig({
    accountStore: fakeAccountStore({ findById: async () => ACCOUNT }),
    ...extra,
  });

test.group('firstPartyClients — claims emitted by the provider', () => {
  test('a host with NO branding emits the roles claim to its client', async ({ assert }) => {
    // The regression, stated as a token: this used to come back as [].
    const claims = await claimsFor(await rolesConfig(), 'web');
    assert.deepEqual(claims.roles, ['ADMIN', 'EDITOR']);
  });

  test('a declared allowlist keeps the claim from clients outside it', async ({ assert }) => {
    const cfg = await rolesConfig({ firstPartyClients: ['web'] });
    assert.deepEqual((await claimsFor(cfg, 'web')).roles, ['ADMIN', 'EDITOR']);
    assert.isUndefined((await claimsFor(cfg, 'partner')).roles);
  });

  test('branding.firstParty still restricts, for hosts that declared it', async ({ assert }) => {
    const cfg = await rolesConfig({ branding: branding(['web']) as any });
    assert.deepEqual((await claimsFor(cfg, 'web')).roles, ['ADMIN', 'EDITOR']);
    assert.isUndefined((await claimsFor(cfg, 'partner')).roles);
  });

  test('resolveTokenRoles is consulted for a first-party client', async ({ assert }) => {
    const cfg = await rolesConfig({
      resolveTokenRoles: async () => ['FROM_AUTHZ'],
    });
    assert.deepEqual((await claimsFor(cfg, 'web')).roles, ['FROM_AUTHZ']);
  });

  test('a request with no client never gets the claim', async ({ assert }) => {
    assert.isUndefined((await claimsFor(await rolesConfig(), undefined)).roles);
  });
});
