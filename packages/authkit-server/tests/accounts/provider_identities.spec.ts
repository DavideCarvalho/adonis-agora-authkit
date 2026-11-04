import { test } from '@japa/runner';
import type { AccountStore } from '../../src/accounts/account_store.js';
import {
  ProviderIdentities,
  ProviderIdentitiesUnsupportedError,
} from '../../src/accounts/provider_identities.js';

/**
 * Store em memória com a capacidade de provider identity — mesma semântica do
 * lucidAccountStore: upsert na chave `(provider, providerUserId)`, que MOVE a
 * identidade de conta.
 */
function storeWithIdentities() {
  const rows = new Map<string, { accountId: string; email: string | null }>();
  const key = (provider: string, uid: string) => `${provider}:${uid}`;
  const store = {
    async findByProviderIdentity(provider: string, uid: string) {
      const row = rows.get(key(provider, uid));
      return row ? { id: row.accountId, email: row.email ?? '' } : null;
    },
    async linkProviderIdentity(data: {
      accountId: string;
      provider: string;
      providerUserId: string;
      email?: string;
    }) {
      rows.set(key(data.provider, data.providerUserId), {
        accountId: data.accountId,
        email: data.email ?? null,
      });
    },
    async listProviderIdentities(accountId: string) {
      return [...rows.entries()]
        .filter(([, r]) => r.accountId === accountId)
        .map(([k, r]) => {
          const [provider, providerUserId] = k.split(':');
          return { provider, providerUserId, email: r.email };
        });
    },
    async unlinkAllProviderIdentities(accountId: string) {
      let n = 0;
      for (const [k, r] of rows) {
        if (r.accountId === accountId) {
          rows.delete(k);
          n++;
        }
      }
      return n;
    },
  };
  return store as unknown as AccountStore;
}

test.group('ProviderIdentities (authkit.identities)', () => {
  test('link liga a identidade e find acha a conta', async ({ assert }) => {
    const store = storeWithIdentities();
    const fixed = new ProviderIdentities(() => store);
    assert.isTrue(fixed.supported);

    const result = await fixed.link({
      accountId: 'conta-1',
      provider: 'google',
      providerUserId: 'sub-1',
      email: 'a@x.com',
    });

    assert.deepEqual(result, { previousAccountId: null });
    assert.equal((await fixed.find('google', 'sub-1'))?.id, 'conta-1');
    assert.deepEqual(await fixed.list('conta-1'), [
      { provider: 'google', providerUserId: 'sub-1', email: 'a@x.com' },
    ]);
  });

  test('link de identidade já ligada a outra conta MOVE e devolve a anterior', async ({
    assert,
  }) => {
    const store = storeWithIdentities();
    const identities = new ProviderIdentities(() => store);
    await identities.link({ accountId: 'conta-email', provider: 'google', providerUserId: 'sub' });

    const result = await identities.link({
      accountId: 'conta-que-conectou',
      provider: 'google',
      providerUserId: 'sub',
    });

    assert.deepEqual(result, { previousAccountId: 'conta-email' });
    assert.equal((await identities.find('google', 'sub'))?.id, 'conta-que-conectou');
    assert.lengthOf(await identities.list('conta-email'), 0);
  });

  test('relink na mesma conta é idempotente', async ({ assert }) => {
    const store = storeWithIdentities();
    const identities = new ProviderIdentities(() => store);
    await identities.link({ accountId: 'c', provider: 'google', providerUserId: 's' });
    const again = await identities.link({
      accountId: 'c',
      provider: 'google',
      providerUserId: 's',
    });

    assert.deepEqual(again, { previousAccountId: 'c' });
    assert.lengthOf(await identities.list('c'), 1);
  });

  test('unlinkAll remove só as da conta', async ({ assert }) => {
    const store = storeWithIdentities();
    const identities = new ProviderIdentities(() => store);
    await identities.link({ accountId: 'a', provider: 'google', providerUserId: '1' });
    await identities.link({ accountId: 'a', provider: 'github', providerUserId: '2' });
    await identities.link({ accountId: 'b', provider: 'google', providerUserId: '3' });

    assert.equal(await identities.unlinkAll('a'), 2);
    assert.equal((await identities.find('google', '3'))?.id, 'b');
  });

  test('store sem a capacidade: supported=false e os métodos lançam', async ({ assert }) => {
    const identities = new ProviderIdentities(() => ({}) as unknown as AccountStore);

    assert.isFalse(identities.supported);
    await assert.rejects(
      () => identities.link({ accountId: 'a', provider: 'google', providerUserId: '1' }),
      ProviderIdentitiesUnsupportedError,
    );
    await assert.rejects(() => identities.find('google', '1'), ProviderIdentitiesUnsupportedError);
  });
});
