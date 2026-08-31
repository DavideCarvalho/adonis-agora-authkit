import { AUTHKIT_METRICS } from '@adonis-agora/authkit-core';
import { configProvider } from '@adonisjs/core';
import { test } from '@japa/runner';
import RedisMock from 'ioredis-mock';
import { adapters, defineConfig, OidcService } from '../index.js';
import { OtelRecorder } from '../src/observability/otel_recorder.js';
import { fakeAccountStore } from './bootstrap.js';

test.group('provider metrics wiring', () => {
  test('um evento real do provider incrementa o counter', async ({ assert }) => {
    const fakeApp = {
      container: { make: async () => ({ connection: () => new RedisMock() }) },
    } as any;
    const cfg = await configProvider.resolve(
      fakeApp,
      defineConfig({
        issuer: 'http://localhost:9899',
        adapter: adapters.redis({ connection: 'main' }),
        jwks: { source: 'managed' },
        clients: [
          { clientId: 'app1', clientSecret: 's', redirectUris: ['http://localhost:9899/cb'] },
        ],
        accountStore: fakeAccountStore(),
      }),
    );
    const recorder = await OtelRecorder.create('test');
    const service = new OidcService(cfg!, 'a'.repeat(32), recorder);
    // `grant.success` é emitido pelo oidc-provider v9 em lib/actions/token.js
    service.provider.emit('grant.success', {});
    assert.equal(recorder.snapshot().counters[AUTHKIT_METRICS.loginSuccess], 1);
  });
});
