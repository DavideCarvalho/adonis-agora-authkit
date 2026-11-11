import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@japa/runner';
import type { AuthkitScreen, AuthkitScreenProps } from '../../index.js';

/**
 * Every screen has a props type, and every props entry is a screen: `satisfies
 * Record<AuthkitScreen, true>` fails `tsc` on a missing or an extra key.
 */
const SCREENS = {
  login: true,
  signup: true,
  consent: true,
  forgot: true,
  reset: true,
  'verify-email': true,
  'mfa-challenge': true,
  'otp-unlock': true,
  maintenance: true,
  'session-expired': true,
  throttled: true,
  'agents/consent': true,
  'agents/done': true,
  'account/login': true,
  'account/tokens': true,
  'account/mfa': true,
  'account/security': true,
  'account/apps': true,
  'account/orgs': true,
  'account/confirm': true,
  'account/email-confirmed': true,
} as const satisfies Record<AuthkitScreen, true>;

// `AuthkitScreen` and the props map have exactly the same keys.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameKeys: Same<AuthkitScreen, keyof AuthkitScreenProps> = true;
// Every page receives `messages`.
const withMessages: Same<
  {
    [V in AuthkitScreen]: 'messages' extends keyof AuthkitScreenProps[V] ? true : false;
  }[AuthkitScreen],
  true
> = true;

const VIEWS = fileURLToPath(new URL('../../src/host/views/', import.meta.url));

function edgeViews(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === 'partials' ? [] : edgeViews(path);
    return entry.endsWith('.edge') ? [relative(VIEWS, path).replace(/\.edge$/, '')] : [];
  });
}

test.group('AuthkitScreen', () => {
  test('the union, the props map and the built-in Edge views name the same screens', ({
    assert,
  }) => {
    assert.isTrue(sameKeys && withMessages);
    assert.sameMembers(edgeViews(VIEWS), Object.keys(SCREENS));
  });
});
