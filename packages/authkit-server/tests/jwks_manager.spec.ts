import { test } from '@japa/runner';
import { generateJwks, type ManagedJwks } from '../src/keys/jwks_manager.js';

test.group('JwksManager', () => {
  test('gera um JWKS privado válido com kid e alg', async ({ assert }) => {
    const jwks: ManagedJwks = await generateJwks('RS256');
    assert.lengthOf(jwks.keys, 1);
    const [key] = jwks.keys;
    assert.equal(key.use, 'sig');
    assert.equal(key.alg, 'RS256');
    assert.isString(key.kid);
    assert.equal(key.kty, 'RSA');
    assert.isString(key.d); // parte privada presente
  });

  test('gera kids distintos a cada chamada', async ({ assert }) => {
    const a = await generateJwks('ES256');
    const b = await generateJwks('ES256');
    assert.notEqual(a.keys[0].kid, b.keys[0].kid);
    assert.equal(a.keys[0].kty, 'EC');
  });
});
