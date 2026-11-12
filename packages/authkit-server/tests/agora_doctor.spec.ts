import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  AgoraDoctorUsageError,
  discoverDoctorChecks,
  readDoctorChecks,
  registerDoctorChecks,
  renderAgoraDoctor,
  runAgoraDoctor,
  satisfies,
} from '../src/doctor/agora_doctor.js';
import { type DoctorInput, runAllChecks } from '../src/doctor/checks.js';
import { agoraDoctorChecks } from '../src/doctor/index.js';

const BOOT_APP = new URL('./fixtures/boot_app/', import.meta.url);

function fakeApp(root: string = tmpdir(), inProduction = false): ApplicationService {
  return {
    inProduction,
    nodeEnvironment: inProduction ? 'production' : 'development',
    makePath: (...parts: string[]) => join(root, ...parts),
  } as unknown as ApplicationService;
}

function check(id: string, run: AgoraDoctorCheck['run']): AgoraDoctorCheck {
  return { id, lib: id.split('.')[0]!, title: id, run };
}

test.group('agora doctor | shared runner (copy of durable)', () => {
  test('registry: created when absent, shared by every lib, duplicates skipped', async ({
    assert,
  }) => {
    const container = new Container();
    await registerDoctorChecks(container as never, [
      check('a.one', () => ({ status: 'ok', message: '' })),
    ]);
    await registerDoctorChecks(container as never, [
      check('a.one', () => ({ status: 'ok', message: '' })),
      check('b.one', () => ({ status: 'ok', message: '' })),
    ]);
    const checks = await readDoctorChecks(container as never);
    assert.deepEqual(
      checks.map((c) => c.id),
      ['a.one', 'b.one'],
    );
  });

  test('a registry of another version is a usage error (exit 2)', async ({ assert }) => {
    const container = new Container();
    container.bindValue(AGORA_DOCTOR_BINDING as never, { version: 2, checks: [] } as never);
    await assert.rejects(
      () => readDoctorChecks(container as never),
      AgoraDoctorUsageError as never,
    );
  });

  test('exit codes and --strict', async ({ assert }) => {
    const warn = [check('a.warn', () => ({ status: 'warn', message: 'meh' }))];
    assert.equal((await runAgoraDoctor(fakeApp(), warn)).exitCode, 0);
    assert.equal((await runAgoraDoctor(fakeApp(), warn, { strict: true })).exitCode, 1);
    const error = [check('a.err', () => ({ status: 'error', message: 'bad', fix: 'fix it' }))];
    const { report, exitCode } = await runAgoraDoctor(fakeApp(), error);
    assert.equal(exitCode, 1);
    assert.include(renderAgoraDoctor(report), 'fix: fix it');
    await assert.rejects(
      () => runAgoraDoctor(fakeApp(), error, { only: 'nope' }),
      AgoraDoctorUsageError as never,
    );
  });

  test('matches the peer ranges authkit declares', ({ assert }) => {
    const range = '>=0.7.0 <2.0.0 || >=1.0.0-rc.0 <2.0.0';
    assert.isTrue(satisfies('1.0.0-rc.3', range));
    assert.isTrue(satisfies('0.60.0', range));
    assert.isFalse(satisfies('0.6.0', range));
    assert.isTrue(satisfies('7.1.0', '^7.0.0'));
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
    const samples = [
      input(),
      input({ authkitConfig: null }),
      input({ peers: { session: false, shield: false, ally: false, limiter: false } }),
    ];
    for (const sample of samples) {
      const fromTable = AUTHKIT_DOCTOR_TABLE.flatMap(([, , fn]) => {
        const found = fn(sample);
        return found === null ? [] : Array.isArray(found) ? found : [found];
      });
      assert.deepEqual(fromTable, runAllChecks(sample));
    }
  });

  test('ids are unique, prefixed, kebab-case and point at the authkit-server package', ({
    assert,
  }) => {
    const checks = authkitDoctorChecks();
    const ids = checks.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const c of checks) {
      assert.match(c.id, /^authkit\.[a-z0-9]+(-[a-z0-9]+)*$/);
      assert.equal(c.lib, 'authkit');
      assert.equal(c.package, '@adonis-agora/authkit-server');
    }
    assert.includeMembers(ids, [
      'authkit.config-resolves',
      'authkit.signing-key-age',
      'authkit.console-gate',
    ]);
    assert.deepEqual(
      agoraDoctorChecks.map((c) => c.id),
      ids,
    );
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
});

test.group('agora doctor | in an app', () => {
  async function bootedApp(config: Record<string, unknown>) {
    const app = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({ config: { app: { appKey: 'a'.repeat(32) }, ...config } })
      .create(BOOT_APP)
      .createApp('web');
    await app.init();
    await app.boot();
    return app;
  }

  test('authkit checks register into the shared registry and report', async ({ assert }) => {
    const authkit = configProvider.create(
      async () =>
        ({
          issuer: 'https://idp.test/oidc',
          mountPath: '/oidc',
          admin: { enabled: true, roles: ['ADMIN'], authorize: null },
        }) as any,
    );
    const app = await bootedApp({ authkit });
    await registerDoctorChecks(app.container as never, authkitDoctorChecks());
    const checks = await readDoctorChecks(app.container as never);
    const { report } = await runAgoraDoctor(app, checks, { only: 'authkit.console-gate' });
    assert.equal(report.results[0]!.status, 'warn');
    assert.equal(report.libs[0]!.package, '@adonis-agora/authkit-server');
  });

  test('without config/authkit.ts: config-resolves is an error, the issuer check skips', async ({
    assert,
  }) => {
    const app = await bootedApp({});
    const { report } = await runAgoraDoctor(app, authkitDoctorChecks(), { libs: ['authkit'] });
    const byId = new Map(report.results.map((r) => [r.id, r]));
    assert.equal(byId.get('authkit.config-resolves')!.status, 'error');
    assert.equal(byId.get('authkit.issuer')!.status, 'skip');
    assert.equal(byId.get('authkit.console-gate')!.status, 'skip');
  });

  test('--no-boot: the checks skip instead of reporting a missing config', async ({ assert }) => {
    const app = new IgnitorFactory().withCoreConfig().create(BOOT_APP).createApp('console');
    await app.init();
    const { report } = await runAgoraDoctor(app, authkitDoctorChecks(), {
      only: 'authkit.signing-key-age',
    });
    assert.equal(report.results[0]!.status, 'skip');
    assert.match(report.results[0]!.message, /--no-boot/);
  });

  test('--no-boot discovers the ./doctor entry of an installed authkit-server', async ({
    assert,
  }) => {
    const root = await mkdtemp(join(tmpdir(), 'agora-doctor-'));
    try {
      const dir = join(root, 'node_modules', '@adonis-agora', 'authkit-server');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ dependencies: { '@adonis-agora/authkit-server': '*' } }),
      );
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          name: '@adonis-agora/authkit-server',
          exports: { './doctor': './doctor.mjs' },
        }),
      );
      const entry = new URL('../src/doctor/index.ts', import.meta.url).href;
      await writeFile(
        join(dir, 'doctor.mjs'),
        `export { agoraDoctorChecks } from ${JSON.stringify(entry)};`,
      );
      const checks = await discoverDoctorChecks(fakeApp(root));
      assert.include(
        checks.map((c) => c.id),
        'authkit.console-gate',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
