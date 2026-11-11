import { test } from '@japa/runner';
import {
  ADMIN_CONSOLE_NO_AUTHORIZE_WARNING,
  resetAdminConsoleWarning,
  warnAdminConsoleUnauthorized,
} from '../../src/host/admin_console_warning.js';

test.group('admin console boot warning', (group) => {
  group.each.setup(() => resetAdminConsoleWarning);

  test('logs the shared wording once per process', ({ assert }) => {
    const logged: string[] = [];
    const logger = { warn: (m: string) => logged.push(m) };
    assert.isTrue(warnAdminConsoleUnauthorized(logger));
    assert.isFalse(warnAdminConsoleUnauthorized(logger));
    assert.deepEqual(logged, [
      '[@adonis-agora/authkit-server] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/authkit.ts.',
    ]);
    assert.equal(logged[0], ADMIN_CONSOLE_NO_AUTHORIZE_WARNING);
  });
});
