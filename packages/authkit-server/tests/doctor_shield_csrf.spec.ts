import { test } from '@japa/runner';
import {
  authkitCsrfExemptEndpoints,
  checkShield,
  csrfRejects,
  type DoctorInput,
} from '../src/doctor/checks.js';
import { authkitCsrfExceptions } from '../src/host/csrf.js';

function input(shieldConfig: DoctorInput['shieldConfig'], authkit: Record<string, any> = {}) {
  return {
    authkitConfig: { issuer: 'https://idp.test/oidc', mountPath: '/oidc', ...authkit },
    sessionConfig: { store: 'redis' },
    peers: { session: true, shield: true, ally: true, limiter: true },
    shieldConfig,
  } satisfies DoctorInput;
}

/** What a real app writes: an anchored exemption of its own OR the helper. */
const appFunction = {
  csrf: {
    enabled: true,
    methods: [],
    exceptRoutes: (ctx: any) =>
      ctx.request.url() === '/telescope/mcp' ||
      /^\/api\//.test(ctx.request.url()) ||
      authkitCsrfExceptions(ctx.request.url(), { mountPath: '/oidc' }),
  },
};

test.group('doctor: authkit.shield evaluates the real shield config', () => {
  test('a function exceptRoutes that exempts authkit (plus anchored app rules) is ok', ({
    assert,
  }) => {
    assert.equal(checkShield(input(appFunction)).level, 'ok');
  });

  test('an anchored app-only exemption that misses authkit warns and names the endpoints', ({
    assert,
  }) => {
    const finding = checkShield(
      input({
        csrf: { enabled: true, exceptRoutes: (ctx: any) => ctx.request.url() === '/telescope/mcp' },
      }),
    );
    assert.equal(finding.level, 'warn');
    assert.include(finding.message, 'POST /oidc/token, /oidc/token/introspection');
    assert.include(finding.message, '/authkit/pat/introspect');
    assert.notInclude(finding.message, '/telescope/mcp');
  });

  test('empty `methods` checks every method; a list without POST skips POST', ({ assert }) => {
    const endpoint = { path: '/oidc/token', pattern: '/oidc/*' };
    assert.isTrue(csrfRejects({ csrf: { enabled: true, methods: [] } }, endpoint));
    assert.isTrue(csrfRejects({ csrf: { enabled: true } }, endpoint));
    assert.isTrue(csrfRejects({ csrf: { enabled: true, methods: ['POST', 'PUT'] } }, endpoint));
    assert.isFalse(csrfRejects({ csrf: { enabled: true, methods: ['PUT', 'DELETE'] } }, endpoint));
    assert.isFalse(csrfRejects({ csrf: { enabled: false } }, endpoint));
    assert.isFalse(csrfRejects(null, endpoint));
  });

  test('an array exceptRoutes matches route patterns, like shield', ({ assert }) => {
    const ok = checkShield(
      input({
        csrf: { enabled: true, exceptRoutes: ['/oidc/*', '/authkit/pat/introspect'] },
      }),
    );
    assert.equal(ok.level, 'ok');
    const missing = checkShield(input({ csrf: { enabled: true, exceptRoutes: ['/oidc/*'] } }));
    assert.equal(missing.level, 'warn');
    assert.include(missing.message, '/authkit/pat/introspect');
    assert.notInclude(missing.message, '/oidc/token');
  });

  test('CSRF off, no shield config, or a throwing function', ({ assert }) => {
    assert.equal(checkShield(input({ csrf: { enabled: false } })).level, 'ok');
    assert.equal(checkShield(input(null)).level, 'ok');
    const threw = checkShield(
      input({
        csrf: {
          enabled: true,
          exceptRoutes: (ctx: any) => ctx.session.get('x') === 1,
        },
      }),
    );
    assert.equal(threw.level, 'warn');
    assert.include(threw.message, 'threw');
    assert.equal(checkShield(input(undefined)).level, 'warn');
  });

  test('custom mountPath and personal agents endpoints are required too', ({ assert }) => {
    const authkit = {
      mountPath: '/sso',
      personalAgents: {
        prefix: '/agents',
        extensions: [{ csrfExemptPaths: ['/poppy/messages'] }],
      },
    };
    assert.deepEqual(
      authkitCsrfExemptEndpoints(authkit).map((e) => e.path),
      [
        '/sso/token',
        '/sso/token/introspection',
        '/sso/token/revocation',
        '/authkit/pat/introspect',
        '/agents/oauth/device_authorization',
        '/agents/oauth/token',
        '/poppy/messages',
      ],
    );
    const onlyIdp = checkShield(
      input(
        {
          csrf: {
            enabled: true,
            exceptRoutes: (ctx: any) =>
              authkitCsrfExceptions(ctx.request.url(), {
                mountPath: '/sso',
                personalAgentsPrefix: false,
              }),
          },
        },
        authkit,
      ),
    );
    assert.equal(onlyIdp.level, 'warn');
    assert.include(onlyIdp.message, '/agents/oauth/token');
  });

  test('the suggested helper is anchored', ({ assert }) => {
    assert.include(
      checkShield(input({ csrf: { enabled: true } })).message,
      'authkitCsrfExceptions',
    );
    assert.isTrue(authkitCsrfExceptions('/oidc', { mountPath: '/oidc' }));
    assert.isTrue(authkitCsrfExceptions('/oidc/token?x=1', { mountPath: '/oidc' }));
    assert.isTrue(authkitCsrfExceptions('https://idp.test/oidc/token', { mountPath: '/oidc' }));
    assert.isTrue(authkitCsrfExceptions('/oidc/token', { mountPath: '/oidc/' }));
    assert.isFalse(authkitCsrfExceptions('/admin/oidc/token', { mountPath: '/oidc' }));
    assert.isFalse(authkitCsrfExceptions('/oidc-clients/new', { mountPath: '/oidc' }));
    assert.isFalse(authkitCsrfExceptions('/profile?next=/oidc/token', { mountPath: '/oidc' }));
    assert.isFalse(authkitCsrfExceptions('/x/authkit/pat/introspect', { mountPath: '/oidc' }));
    assert.isFalse(authkitCsrfExceptions('/auth/backchannel-logout/extra', { mountPath: '/oidc' }));
  });
});
