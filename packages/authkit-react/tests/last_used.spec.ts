/**
 * Selo "último usado": o helper decide quando o selo aparece; o componente só
 * delega a ele (createElement não roda em Node — vale export/shape, como os
 * demais specs de componente).
 */

import { test } from '@japa/runner';
import { LastUsedBadge } from '../src/components/last_used_badge.js';
import { isLastUsedLoginMethod } from '../src/interaction/last_used.js';

test.group('isLastUsedLoginMethod', () => {
  test('casa o método exato', ({ assert }) => {
    assert.isTrue(isLastUsedLoginMethod('password', 'password'));
    assert.isTrue(isLastUsedLoginMethod('social:google', 'social:google'));
    assert.isFalse(isLastUsedLoginMethod('social:google', 'social:github'));
    assert.isFalse(isLastUsedLoginMethod('passkey', 'password'));
  });

  test('aceita vários métodos para um botão só', ({ assert }) => {
    assert.isTrue(isLastUsedLoginMethod('otp', ['magic_link', 'otp']));
    assert.isTrue(isLastUsedLoginMethod('magic_link', ['magic_link', 'otp']));
    assert.isFalse(isLastUsedLoginMethod('password', ['magic_link', 'otp']));
  });

  test('sem prop (primeiro acesso, feature desligada) nunca casa', ({ assert }) => {
    assert.isFalse(isLastUsedLoginMethod(undefined, 'password'));
    assert.isFalse(isLastUsedLoginMethod(null, 'password'));
    assert.isFalse(isLastUsedLoginMethod('', 'password'));
  });

  test('LastUsedBadge não renderiza nada quando não casa', ({ assert }) => {
    assert.isFunction(LastUsedBadge);
    assert.isNull(LastUsedBadge({ lastUsed: 'password', method: 'passkey' }));
    assert.isNull(LastUsedBadge({ lastUsed: undefined, method: 'passkey' }));
    assert.isNotNull(LastUsedBadge({ lastUsed: 'passkey', method: 'passkey' }));
  });
});
