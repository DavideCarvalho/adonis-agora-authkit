import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { configProvider } from '@adonisjs/core';
import { Container } from '@adonisjs/core/container';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { test } from '@japa/runner';
import {
  AUTHKIT_DOCTOR_TABLE,
  authkitDoctorChecks,
  consoleGateResult,
} from '../src/doctor/agora_checks.js';
import {
  AGORA_DOCTOR_BINDING,
  type AgoraDoctorCheck,
  type AgoraDoctorRegistry,
  agoraDoctorExitCode,
  checkPeers,
  checkSiblings,
  executeAgoraDoctor,
  registerDoctorChecks,
  renderAgoraDoctor,
  runAgoraDoctor,
  satisfiesRange,
} from '../src/doctor/agora_doctor.js';
import { type DoctorInput, runAllChecks } from '../src/doctor/checks.js';

/** A fake app: container, `inProduction`, `makePath` rooted at `root`, config values. */
function fakeApp(
  options: { root?: string; inProduction?: boolean; config?: Record<string, unknown> } = {},
) {
  const container = new Container();
  const root = options.root ?? tmpdir();
  const config = options.config ?? {};
  container.bindValue(
    'config' as never,
    { get: (key: string, fallback: unknown) => config[key] ?? fallback } as never,
  );
  return {
    container,
    inProduction: options.inProduction ?? false,
    nodeEnvironment: options.inProduction ? 'production' : 'development',
    isReady: true,
    makePath: (...parts: string[]) => join(root, ...parts),
  } as unknown as ApplicationService;
}

function check(
  id: string,
  run: AgoraDoctorCheck['run'],
  extra: Partial<AgoraDoctorCheck> = {},
): AgoraDoctorCheck {
  return { id, lib: id.split('.')[0]!, title: id, run, ...extra };
}

function registry(checks: AgoraDoctorCheck[]): AgoraDoctorRegistry {
  return { version: 1, checks, libs: [] };
}

test.group('agora doctor | registerDoctorChecks', () => {
  test('creates the registry when absent and reuses it when present', async ({ assert }) => {
    const app = fakeApp();
    await registerDoctorChecks(app, { lib: 'a', package: '@x/a', from: import.meta.url }, [
      check('a.one', () => ({ status: 'ok', message: '' })),
    ]);
    await registerDoctorChecks(app, { lib: 'b', package: '@x/b', from: import.meta.url }, [
      check('b.one', () => ({ status: 'ok', message: '' })),
    ]);
    const reg = (await app.container.make(AGORA_DOCTOR_BINDING as never)) as AgoraDoctorRegistry;
    assert.deepEqual(
      reg.checks.map((c) => c.id),
      ['a.one', 'b.one'],
    );
    assert.deepEqual(
      reg.libs!.map((l) => l.lib),
      ['a', 'b'],
    );
  });

  test('registers synchronously when it creates the registry', ({ assert }) => {
    const app = fakeApp();
    void registerDoctorChecks(app, { lib: 'a', package: '@x/a', from: import.meta.url }, [
      check('a.one', () => ({ status: 'ok', message: '' })),
    ]);
    assert.isTrue(app.container.hasBinding(AGORA_DOCTOR_BINDING as never));
  });

  test('skips a registry of another version', async ({ assert }) => {
    const app = fakeApp();
    const foreign = { version: 2, checks: [] as unknown[] };
    app.container.bindValue(AGORA_DOCTOR_BINDING as never, foreign as never);
    await registerDoctorChecks(app, { lib: 'a', package: '@x/a', from: import.meta.url }, [
      check('a.one', () => ({ status: 'ok', message: '' })),
    ]);
    assert.lengthOf(foreign.checks, 0);
  });

  test('skips a duplicate id with a warning', async ({ assert }) => {
    const app = fakeApp();
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const c = check('a.one', () => ({ status: 'ok', message: '' }));
      await registerDoctorChecks(app, { lib: 'a', package: '@x/a', from: import.meta.url }, [c]);
      await registerDoctorChecks(app, { lib: 'a', package: '@x/a', from: import.meta.url }, [c]);
    } finally {
      console.warn = warn;
    }
    const reg = (await app.container.make(AGORA_DOCTOR_BINDING as never)) as AgoraDoctorRegistry;
    assert.lengthOf(reg.checks, 1);
    assert.lengthOf(warnings, 1);
    assert.include(warnings[0]!, 'a.one');
  });
});

test.group('agora doctor | runner', () => {
  test('orders by lib, then registration order', async ({ assert }) => {
    const result = await runAgoraDoctor(
      fakeApp(),
      registry([
        check('zeta.one', () => ({ status: 'ok', message: '' })),
        check('alpha.two', () => ({ status: 'ok', message: '' })),
        check('alpha.one', () => ({ status: 'ok', message: '' })),
      ]),
    );
    assert.deepEqual(
      result.results.map((r) => r.id),
      ['alpha.two', 'alpha.one', 'zeta.one'],
    );
  });

  test('filters by --lib and --only, runs deep checks only with --deep', async ({ assert }) => {
    const reg = registry([
      check('a.cheap', () => ({ status: 'ok', message: '' })),
      check('a.deep', () => ({ status: 'ok', message: '' }), { cost: 'deep' }),
      check('b.cheap', () => ({ status: 'ok', message: '' })),
    ]);
    const app = fakeApp();
    assert.deepEqual(
      (await runAgoraDoctor(app, reg)).results.map((r) => r.id),
      ['a.cheap', 'b.cheap'],
    );
    assert.deepEqual(
      (await runAgoraDoctor(app, reg, { deep: true, libs: ['a'] })).results.map((r) => r.id),
      ['a.cheap', 'a.deep'],
    );
    assert.deepEqual(
      (await runAgoraDoctor(app, reg, { only: 'a.deep' })).results.map((r) => r.id),
      ['a.deep'],
    );
  });

  test('a throw and a timeout become errors; an empty result is a skip', async ({ assert }) => {
    const result = await runAgoraDoctor(
      fakeApp(),
      registry([
        check('a.throws', () => {
          throw new Error('boom');
        }),
        check('a.slow', () => new Promise(() => {})),
        check('a.empty', () => []),
      ]),
      { timeouts: { cheap: 20, deep: 20 } },
    );
    const byId = Object.fromEntries(result.results.map((r) => [r.id, r]));
    assert.equal(byId['a.throws']!.status, 'error');
    assert.equal(byId['a.throws']!.message, 'boom');
    assert.equal(byId['a.slow']!.status, 'error');
    assert.match(byId['a.slow']!.message, /timed out/);
    assert.equal(byId['a.empty']!.status, 'skip');
    assert.deepEqual(result.summary, { ok: 0, warn: 0, error: 2, skip: 1 });
  });

  test('a check may return several results', async ({ assert }) => {
    const result = await runAgoraDoctor(
      fakeApp(),
      registry([
        check('a.multi', () => [
          { status: 'ok', message: 'one' },
          { status: 'warn', message: 'two', fix: 'do it' },
        ]),
      ]),
    );
    assert.deepEqual(
      result.results.map((r) => [r.id, r.status, r.message]),
      [
        ['a.multi', 'ok', 'one'],
        ['a.multi', 'warn', 'two'],
      ],
    );
  });

  test('unknown --lib, unknown --only and a foreign registry are usage errors', async ({
    assert,
  }) => {
    const reg = registry([check('a.one', () => ({ status: 'ok', message: '' }))]);
    await assert.rejects(() => runAgoraDoctor(fakeApp(), reg, { libs: ['nope'] }), /--lib/);
    await assert.rejects(() => runAgoraDoctor(fakeApp(), reg, { only: 'a.nope' }), /--only/);
    await assert.rejects(() => runAgoraDoctor(fakeApp(), { version: 2, checks: [] }), /version 2/);
  });

  test('exit codes: 0 without errors, 1 on error, 1 on warn with strict', ({ assert }) => {
    const base = { version: 1 as const, env: 'test', libs: [], results: [] };
    assert.equal(
      agoraDoctorExitCode({ ...base, summary: { ok: 1, warn: 1, error: 0, skip: 0 } }),
      0,
    );
    assert.equal(
      agoraDoctorExitCode({ ...base, summary: { ok: 1, warn: 0, error: 1, skip: 0 } }),
      1,
    );
    assert.equal(
      agoraDoctorExitCode({ ...base, summary: { ok: 1, warn: 1, error: 0, skip: 0 } }, true),
      1,
    );
  });

  test('human output hides skips unless verbose and prints fixes', async ({ assert }) => {
    const result = await runAgoraDoctor(
      fakeApp(),
      registry([
        check('a.ok', () => ({ status: 'ok', message: 'fine' })),
        check('a.bad', () => ({ status: 'error', message: 'broken', fix: 'repair it' })),
        check('a.off', () => ({ status: 'skip', message: 'feature off' })),
      ]),
    );
    const text = renderAgoraDoctor(result, { symbols: false }).join('\n');
    assert.include(text, 'error a.bad');
    assert.include(text, 'fix: repair it');
    assert.notInclude(text, 'feature off');
    assert.include(text, '3 checks: 1 ok · 0 warn · 1 error   (skipped 1, run with --verbose)');
    assert.include(renderAgoraDoctor(result, { verbose: true }).join('\n'), 'feature off');
    assert.include(renderAgoraDoctor(result).join('\n'), '✖ a.bad');
  });

  test('executeAgoraDoctor prints one JSON object and returns the exit code', async ({
    assert,
  }) => {
    const app = fakeApp();
    app.container.bindValue(
      AGORA_DOCTOR_BINDING as never,
      registry([check('a.warn', () => ({ status: 'warn', message: 'meh' }))]) as never,
    );
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l) };
    assert.equal(await executeAgoraDoctor(app, { json: true }, io), 0);
    assert.lengthOf(out, 1);
    const parsed = JSON.parse(out[0]!);
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.summary, { ok: 0, warn: 1, error: 0, skip: 0 });
    assert.equal(parsed.results[0].id, 'a.warn');
    assert.isNumber(parsed.results[0].ms);
    assert.equal(await executeAgoraDoctor(app, { json: true, strict: true }, io), 1);
    assert.equal(await executeAgoraDoctor(app, { only: 'zzz' }, io), 2);
    assert.match(err.at(-1)!, /--only/);
  });
});

test.group('agora doctor | built-in checks', (group) => {
  let root: string;
  let libDir: string;
  group.each.setup(async () => {
    root = await mkdtemp(join(tmpdir(), 'agora-doctor-'));
    libDir = join(root, 'lib', 'src');
    await mkdir(libDir, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
    await writeFile(
      join(root, 'lib', 'package.json'),
      JSON.stringify({
        name: '@adonis-agora/demo',
        version: '1.0.0-rc.1',
        peerDependencies: {
          '@adonisjs/core': '^7.0.0',
          'present-ok': '>=1.0.0 <2.0.0 || >=1.0.0-rc.0 <2.0.0',
          'present-old': '^2.0.0',
          'missing-required': '^1.0.0',
          'missing-optional': '^1.0.0',
          'from-catalog': 'catalog:x',
        },
        peerDependenciesMeta: { 'missing-optional': { optional: true } },
      }),
    );
    for (const [name, version] of [
      ['@adonisjs/core', '7.1.0'],
      ['present-ok', '1.0.0-rc.4'],
      ['present-old', '1.9.0'],
      ['from-catalog', '3.0.0'],
    ] as const) {
      await mkdir(join(root, 'node_modules', name), { recursive: true });
      await writeFile(
        join(root, 'node_modules', name, 'package.json'),
        JSON.stringify({ name, version }),
      );
    }
    return () => rm(root, { recursive: true, force: true });
  });

  test('peers: required missing and out of range are errors; optional missing is fine', async ({
    assert,
  }) => {
    const info = {
      lib: 'demo',
      package: '@adonis-agora/demo',
      from: pathToFileURL(join(libDir, 'x.js')).href,
    };
    const results = await checkPeers(fakeApp({ root }), info);
    assert.deepEqual(
      results.map((r) => r.status),
      ['error', 'error'],
    );
    assert.match(results[0]!.message, /present-old 1\.9\.0 is outside \^2\.0\.0/);
    assert.match(results[1]!.message, /missing-required/);
  });

  test('peers: all satisfied is ok', async ({ assert }) => {
    await writeFile(
      join(root, 'lib', 'package.json'),
      JSON.stringify({
        name: '@adonis-agora/demo',
        peerDependencies: { 'present-ok': '^1.0.0-rc.0' },
      }),
    );
    const info = {
      lib: 'demo',
      package: '@adonis-agora/demo',
      from: pathToFileURL(join(libDir, 'x.js')).href,
    };
    const results = await checkPeers(fakeApp({ root }), info);
    assert.deepEqual(
      results.map((r) => r.status),
      ['ok'],
    );
  });

  test('siblings: two installed versions of a related package warn', async ({ assert }) => {
    const info = {
      lib: 'demo',
      package: '@adonis-agora/demo',
      from: pathToFileURL(join(libDir, 'x.js')).href,
    };
    assert.equal((await checkSiblings(fakeApp({ root }), info)).status, 'ok');
    await mkdir(join(root, 'node_modules', '.pnpm', '@adonis-agora+demo@1.0.0-rc.1_abc'), {
      recursive: true,
    });
    await mkdir(join(root, 'node_modules', '.pnpm', '@adonis-agora+demo@0.9.0'), {
      recursive: true,
    });
    await mkdir(join(root, 'node_modules', '.pnpm', '@adonis-agora+other@1.0.0'), {
      recursive: true,
    });
    await mkdir(join(root, 'node_modules', '.pnpm', '@adonis-agora+other@2.0.0'), {
      recursive: true,
    });
    const result = await checkSiblings(fakeApp({ root }), info);
    assert.equal(result.status, 'warn');
    assert.include(result.message, '@adonis-agora/demo (0.9.0, 1.0.0-rc.1)');
    assert.notInclude(result.message, 'other');
  });

  test('siblings: npm/yarn nested copies warn too', async ({ assert }) => {
    const info = {
      lib: 'demo',
      package: '@adonis-agora/demo',
      from: pathToFileURL(join(libDir, 'x.js')).href,
    };
    const top = join(root, 'node_modules', '@adonis-agora', 'demo');
    const nested = join(
      root,
      'node_modules',
      '@adonis-agora',
      'host',
      'node_modules',
      '@adonis-agora',
      'demo',
    );
    await mkdir(top, { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(top, 'package.json'),
      JSON.stringify({ name: '@adonis-agora/demo', version: '1.0.0' }),
    );
    await writeFile(
      join(nested, 'package.json'),
      JSON.stringify({ name: '@adonis-agora/demo', version: '0.9.0' }),
    );
    const result = await checkSiblings(fakeApp({ root }), info);
    assert.equal(result.status, 'warn');
    assert.include(result.message, '@adonis-agora/demo (0.9.0, 1.0.0)');
  });

  test('built-ins run for every registered lib', async ({ assert }) => {
    const reg: AgoraDoctorRegistry = {
      version: 1,
      checks: [],
      libs: [
        {
          lib: 'demo',
          package: '@adonis-agora/demo',
          from: pathToFileURL(join(libDir, 'x.js')).href,
        },
      ],
    };
    const result = await runAgoraDoctor(fakeApp({ root }), reg);
    assert.deepEqual(
      [...new Set(result.results.map((r) => r.id))],
      ['demo.registered', 'demo.peers', 'demo.agora-siblings'],
    );
    assert.deepEqual(result.libs, [
      { lib: 'demo', package: '@adonis-agora/demo', version: '1.0.0-rc.1' },
    ]);
  });
});

test.group('agora doctor | satisfiesRange', () => {
  test('matches the ranges the ecosystem uses', ({ assert }) => {
    const cases: Array<[string, string, boolean | null]> = [
      ['1.2.3', '^1.0.0', true],
      ['2.0.0', '^1.0.0', false],
      ['0.3.5', '^0.3.0', true],
      ['0.4.0', '^0.3.0', false],
      ['1.2.9', '~1.2.0', true],
      ['1.3.0', '~1.2.0', false],
      ['1.5.0', '~1', true],
      ['2.0.0', '~1', false],
      ['1.2.7', '~1.2', true],
      ['1.3.0', '~1.2', false],
      ['1.0.0-rc.3', '>=0.7.0 <2.0.0 || >=1.0.0-rc.0 <2.0.0', true],
      ['2.0.0-rc.1', '>=0.7.0 <2.0.0 || >=1.0.0-rc.0 <2.0.0', false],
      ['0.6.0', '>=0.7.0 <2.0.0 || >=1.0.0-rc.0 <2.0.0', false],
      ['5.1.0', '^4.0.0 || ^5.0.0', true],
      ['1.4.0', '1.x', true],
      ['2.0.0', '<=1.4', false],
      ['1.4.9', '<=1.4', true],
      ['1.0.0', '*', true],
      ['1.0.0', 'catalog:x', null],
      ['1.0.0', 'workspace:*', null],
    ];
    for (const [version, range, expected] of cases) {
      assert.equal(satisfiesRange(version, range), expected, `${version} vs ${range}`);
    }
  });
});

test.group('agora doctor | authkit checks', () => {
  function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
    return {
      authkitConfig: {
        issuer: 'https://idp.test/oidc',
        mountPath: '/oidc',
        accountStore: { findById: () => {}, verifyCredentials: () => {} },
        jwks: { source: 'managed', store: 'tmp/jwks.json' },
        admin: { enabled: true, roles: ['ADMIN'], authorize: null },
      },
      sessionConfig: { store: 'redis' },
      peers: { session: true, shield: true, ally: true, limiter: true },
      ...overrides,
    };
  }

  test('the table yields exactly what runAllChecks yields, in order', ({ assert }) => {
    for (const sample of [
      input(),
      input({ authkitConfig: null }),
      input({ peers: { session: false, shield: false, ally: false, limiter: false } }),
    ]) {
      const fromTable = AUTHKIT_DOCTOR_TABLE.flatMap(([, , fn]) => {
        const found = fn(sample);
        return found === null ? [] : Array.isArray(found) ? found : [found];
      });
      assert.deepEqual(fromTable, runAllChecks(sample));
    }
  });

  test('ids are unique, prefixed and kebab-case', ({ assert }) => {
    const ids = authkitDoctorChecks().map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) assert.match(id, /^authkit\.[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.includeMembers(ids, [
      'authkit.config-resolves',
      'authkit.signing-key-age',
      'authkit.console-gate',
    ]);
  });

  test('console gate: off, set, missing in dev, missing in production', ({ assert }) => {
    assert.equal(consoleGateResult(null, false).status, 'skip');
    assert.equal(consoleGateResult({ admin: { enabled: false } }, true).status, 'skip');
    assert.equal(
      consoleGateResult({ admin: { enabled: true, authorize: () => true } }, true).status,
      'ok',
    );
    assert.equal(
      consoleGateResult({ admin: { enabled: true, authorize: null } }, false).status,
      'warn',
    );
    const prod = consoleGateResult({ admin: { enabled: true, authorize: null } }, true);
    assert.equal(prod.status, 'error');
    assert.include(prod.fix!, 'admin.authorize');
  });

  test('without config/authkit.ts: config-resolves is an error, the rest skip', async ({
    assert,
  }) => {
    const app = fakeApp({ config: {} });
    const reg: AgoraDoctorRegistry = { version: 1, checks: authkitDoctorChecks(), libs: [] };
    const result = await runAgoraDoctor(app, reg);
    const byId = new Map(result.results.map((r) => [r.id, r]));
    assert.equal(byId.get('authkit.config-resolves')!.status, 'error');
    assert.equal(byId.get('authkit.issuer')!.status, 'skip');
    assert.equal(byId.get('authkit.console-gate')!.status, 'skip');
  });
});

const BOOT_APP = new URL('./fixtures/boot_app/', import.meta.url);

test.group('agora doctor | in an app', () => {
  test('the authkit provider registers its checks; agora:doctor runs them', async ({ assert }) => {
    const authkit = configProvider.create(
      async () =>
        ({
          issuer: 'https://idp.test/oidc',
          mountPath: '/oidc',
          admin: { enabled: true, roles: ['ADMIN'], authorize: null },
        }) as any,
    );
    const app = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({ config: { app: { appKey: 'a'.repeat(32) }, authkit } })
      .create(BOOT_APP)
      .createApp('web');
    await app.init();
    await app.boot();
    const { default: AuthkitServerProvider } = await import(
      '../providers/authkit_server_provider.js'
    );
    new AuthkitServerProvider(app).register();
    const reg = (await app.container.make(AGORA_DOCTOR_BINDING as never)) as AgoraDoctorRegistry;
    assert.deepEqual(
      reg.libs!.map((l) => l.package),
      ['@adonis-agora/authkit-server'],
    );

    const out: string[] = [];
    const code = await executeAgoraDoctor(
      app,
      { json: true, only: 'authkit.console-gate' },
      { out: (l) => out.push(l), err: () => {} },
    );
    const parsed = JSON.parse(out[0]!);
    assert.equal(code, 0);
    assert.equal(parsed.results[0].status, 'warn');
    assert.equal(parsed.libs[0].lib, 'authkit');
    assert.match(parsed.libs[0].version, /^\d+\.\d+\.\d+/);
  });

  test('--no-boot runs register() only, so a failing boot() still gets its checks', async ({
    assert,
  }) => {
    let booted = false;
    class Broken {
      constructor(protected app: ApplicationService) {}
      register() {
        void registerDoctorChecks(
          this.app,
          { lib: 'broken', package: '@x/broken', from: import.meta.url },
          [check('broken.one', () => ({ status: 'ok', message: 'registered' }))],
        );
      }
      async boot() {
        booted = true;
        throw new Error('boot failed');
      }
    }
    const app = new IgnitorFactory()
      .withCoreConfig()
      .merge({
        config: { app: { appKey: 'a'.repeat(32) } },
        rcFileContents: { providers: [async () => ({ default: Broken })] },
      })
      .create(BOOT_APP)
      .createApp('console');
    await app.init();
    const out: string[] = [];
    const code = await executeAgoraDoctor(
      app,
      { json: true, boot: false, only: 'broken.one' },
      { out: (l) => out.push(l), err: () => {} },
    );
    assert.isFalse(booted);
    assert.equal(code, 0);
    assert.equal(JSON.parse(out[0]!).results[0].message, 'registered');
  });

  test('--no-boot reports a provider whose register() throws', async ({ assert }) => {
    class Throws {
      register() {
        throw new Error('bad register');
      }
    }
    const app = new IgnitorFactory()
      .withCoreConfig()
      .merge({
        config: { app: { appKey: 'a'.repeat(32) } },
        rcFileContents: { providers: [async () => ({ default: Throws })] },
      })
      .create(BOOT_APP)
      .createApp('console');
    await app.init();
    const out: string[] = [];
    const err: string[] = [];
    const code = await executeAgoraDoctor(
      app,
      { json: true, boot: false },
      { out: (l) => out.push(l), err: (l) => err.push(l) },
    );
    assert.equal(code, 1);
    assert.match(err.join('\n'), /Throws failed to register: bad register/);
    const parsed = JSON.parse(out[0]!);
    assert.equal(parsed.results[0].id, 'agora.no-boot');
    assert.equal(parsed.summary.error, 1);
  });

  test('a boot failure exits 2 with a message', async ({ assert }) => {
    class BootFails {
      async boot() {
        throw new Error('cannot boot');
      }
    }
    const app = new IgnitorFactory()
      .withCoreConfig()
      .merge({
        config: { app: { appKey: 'a'.repeat(32) } },
        rcFileContents: { providers: [async () => ({ default: BootFails })] },
      })
      .create(BOOT_APP)
      .createApp('console');
    await app.init();
    const err: string[] = [];
    const code = await executeAgoraDoctor(app, {}, { out: () => {}, err: (l) => err.push(l) });
    assert.equal(code, 2);
    assert.match(err.join('\n'), /failed to boot: cannot boot/);
  });
});
