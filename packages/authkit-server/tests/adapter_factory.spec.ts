import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { adapters } from '../src/adapters/factory.js';

test.group('adapters factory', () => {
  test('redis() resolve uma classe-adapter usável pelo oidc-provider', async ({ assert }) => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const AdapterClass = await adapters
      .redis({ connection: 'main', prefix: 'authkit' })
      .resolver(fakeApp);
    const instance = new AdapterClass('AccessToken');
    await instance.upsert('t', { jti: 't' }, 60);
    assert.deepInclude(await instance.find('t'), { jti: 't' });
  });

  test('redis() sem connection usa a default do app (mesma da sessão do app)', async ({
    assert,
  }) => {
    // Sem `connection`, as duas camadas de sessão caem na MESMA connection
    // por construção — não há string duplicada pra divergir.
    const requested: Array<string | undefined> = [];
    const fakeApp = {
      container: {
        make: async () => ({
          connection: (name?: string) => {
            requested.push(name);
            return new RedisMock();
          },
        }),
      },
    } as any;
    for (const factory of [adapters.redis(), adapters.redis({ prefix: 'authkit' })]) {
      const AdapterClass = await factory.resolver(fakeApp);
      const instance = new AdapterClass('Session');
      await instance.upsert('s', { jti: 's' }, 60);
      assert.deepInclude(await instance.find('s'), { jti: 's' });
    }
    assert.deepEqual(requested, [undefined, undefined]);
  });
});
