import { test } from '@japa/runner';
import { deriveActor } from '../index.js';

test.group('deriveActor', () => {
  test('reads act.sub and act.email', ({ assert }) => {
    assert.deepEqual(deriveActor({ act: { sub: 'admin-1' } }), { sub: 'admin-1' });
    assert.deepEqual(deriveActor({ act: { sub: 'admin-1', email: 'a@x.io' } }), {
      sub: 'admin-1',
      email: 'a@x.io',
    });
  });

  test('keeps the outermost actor of a delegation chain', ({ assert }) => {
    assert.deepEqual(deriveActor({ act: { sub: 'agent', act: { sub: 'admin' } } }), {
      sub: 'agent',
    });
  });

  test('undefined without a usable act claim', ({ assert }) => {
    assert.isUndefined(deriveActor({}));
    assert.isUndefined(deriveActor(undefined));
    assert.isUndefined(deriveActor({ act: 'admin' }));
    assert.isUndefined(deriveActor({ act: { sub: '' } }));
    assert.isUndefined(deriveActor({ act: [{ sub: 'x' }] }));
  });
});
