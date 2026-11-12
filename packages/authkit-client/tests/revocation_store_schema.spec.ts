import { test } from '@japa/runner';
import { lucidRevocationStore } from '../src/revocation/revocation_store.js';

test.group('lucidRevocationStore | schema', () => {
  test('rejects a schema name that is not a plain identifier', ({ assert }) => {
    for (const bad of ['', '1auth', 'auth.x', 'au th', 'a'.repeat(64)]) {
      assert.throws(() => lucidRevocationStore({ schema: bad }), /schema must match/);
    }
    assert.doesNotThrow(() => lucidRevocationStore({ schema: 'auth' }));
    assert.doesNotThrow(() => lucidRevocationStore());
  });
});
