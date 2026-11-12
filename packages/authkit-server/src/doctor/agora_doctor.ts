// agora-doctor runner v1 — keep identical across libs
// This file is copied byte for byte into every @adonis-agora lib (src/doctor/agora_doctor.ts) and
// checked in CI against the copy @adonis-agora/durable publishes. Change it in durable first.

import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ApplicationService } from '@adonisjs/core/types';

/** The container binding the registry lives at. */
export const AGORA_DOCTOR_BINDING = 'agora.doctor';

/** Bound as a VALUE under `'agora.doctor'`. Data only. */
export interface AgoraDoctorRegistry {
  readonly version: 1;
  readonly checks: AgoraDoctorCheck[];
}

export type AgoraDoctorStatus = 'ok' | 'warn' | 'error' | 'skip';

export interface AgoraDoctorCheck {
  /** `'<lib>.<kebab>'`, unique and frozen for 1.x: `'durable.verify-tenant'`. */
  id: string;
  /** `'durable'`. The package is `@adonis-agora/<lib>` unless {@link package} says otherwise. */
  lib: string;
  /** The npm package, when it is not `@adonis-agora/<lib>`. */
  package?: string;
  title: string;
  /** `'cheap'` (default) reads config, env and files only; `'deep'` touches a DB, Redis or the network. */
  cost?: 'cheap' | 'deep';
  run(
    app: ApplicationService,
  ): AgoraDoctorResult | AgoraDoctorResult[] | Promise<AgoraDoctorResult | AgoraDoctorResult[]>;
}

export interface AgoraDoctorResult {
  status: AgoraDoctorStatus;
  /** One line, no secrets, no stack. */
  message: string;
  /** One line: the exact change to make. */
  fix?: string;
  /** Absolute URL of the lib docs page. */
  docs?: string;
}

/** One reported result. */
export interface AgoraDoctorReportEntry extends AgoraDoctorResult {
  id: string;
  lib: string;
  title: string;
  ms: number;
}

/** What `agora:doctor --json` prints. */
export interface AgoraDoctorReport {
  version: 1;
  env: string;
  summary: Record<AgoraDoctorStatus, number>;
  libs: Array<{ lib: string; package: string; version: string | null }>;
  results: AgoraDoctorReportEntry[];
}

export interface AgoraDoctorOptions {
  libs?: string[];
  only?: string;
  deep?: boolean;
  strict?: boolean;
  /** Per-check budget in ms (default 5000, deep checks 15000). */
  timeoutMs?: number;
  deepTimeoutMs?: number;
}

/** A doctor problem that stops the run itself (exit 2). */
export class AgoraDoctorUsageError extends Error {}

interface ContainerLike {
  hasBinding(binding: string): boolean;
  bindValue(binding: string, value: unknown): void;
  make(binding: string): Promise<unknown>;
}

/**
 * Add a lib's checks to the app's doctor registry, creating it when absent. Call it from a provider's
 * `register()`. A registry of another version is left alone; a duplicate id is skipped.
 */
export async function registerDoctorChecks(
  container: ContainerLike,
  checks: readonly AgoraDoctorCheck[],
): Promise<void> {
  if (!container.hasBinding(AGORA_DOCTOR_BINDING)) {
    const fresh: AgoraDoctorRegistry = { version: 1, checks: [] };
    container.bindValue(AGORA_DOCTOR_BINDING, fresh);
  }
  const registry = (await container.make(AGORA_DOCTOR_BINDING)) as Partial<AgoraDoctorRegistry>;
  if (registry?.version !== 1 || !Array.isArray(registry.checks)) return;
  for (const check of checks) {
    if (registry.checks.some((existing) => existing.id === check.id)) continue;
    registry.checks.push(check);
  }
}

/** The registered checks; throws {@link AgoraDoctorUsageError} on a registry of another version. */
export async function readDoctorChecks(container: ContainerLike): Promise<AgoraDoctorCheck[]> {
  if (!container.hasBinding(AGORA_DOCTOR_BINDING)) return [];
  const registry = (await container.make(AGORA_DOCTOR_BINDING)) as Partial<AgoraDoctorRegistry>;
  if (registry?.version !== 1 || !Array.isArray(registry.checks)) {
    throw new AgoraDoctorUsageError(
      `the doctor registry has version ${String(registry?.version)}; this command reads version 1. Upgrade the @adonis-agora libs together.`,
    );
  }
  return registry.checks;
}

/**
 * The checks of every installed `@adonis-agora/*` package that publishes a `./doctor` entry
 * (`export const agoraDoctorChecks`), imported from the app root without booting providers.
 */
export async function discoverDoctorChecks(app: ApplicationService): Promise<AgoraDoctorCheck[]> {
  const manifest = await readJson(app.makePath('package.json'));
  const names = Object.keys({
    ...(manifest?.dependencies as object | undefined),
    ...(manifest?.devDependencies as object | undefined),
  }).filter((name) => name.startsWith('@adonis-agora/'));
  const checks: AgoraDoctorCheck[] = [];
  for (const name of names.sort()) {
    const dir = await packageDir(name, app.makePath());
    if (dir === null) continue;
    const pkg = await readJson(join(dir, 'package.json'));
    const entry = exportTarget(pkg?.exports, './doctor');
    if (entry === null) continue;
    try {
      const mod = (await import(pathToFileURL(join(dir, entry)).href)) as {
        agoraDoctorChecks?: unknown;
      };
      if (Array.isArray(mod.agoraDoctorChecks)) {
        for (const check of mod.agoraDoctorChecks as AgoraDoctorCheck[]) {
          if (!checks.some((c) => c.id === check.id)) checks.push(check);
        }
      }
    } catch {
      /* a package whose doctor entry cannot load is reported by its peers check */
    }
  }
  return checks;
}

function exportTarget(exportsField: unknown, subpath: string): string | null {
  if (typeof exportsField !== 'object' || exportsField === null) return null;
  const target = (exportsField as Record<string, unknown>)[subpath];
  if (typeof target === 'string') return target;
  if (typeof target === 'object' && target !== null) {
    const t = target as Record<string, unknown>;
    for (const key of ['import', 'default'])
      if (typeof t[key] === 'string') return t[key] as string;
  }
  return null;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The directory of `name` as Node would find it from `from` (walking up `node_modules`), real path. */
export async function packageDir(name: string, from: string): Promise<string | null> {
  let dir = from;
  for (;;) {
    const candidate = join(dir, 'node_modules', name);
    if ((await readJson(join(candidate, 'package.json'))) !== null) {
      try {
        return await realpath(candidate);
      } catch {
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The installed version of `name` resolved from `from`, or `null` when it is not installed. */
export async function installedVersion(name: string, from: string): Promise<string | null> {
  const dir = await packageDir(name, from);
  if (dir === null) return null;
  const pkg = await readJson(join(dir, 'package.json'));
  return typeof pkg?.version === 'string' ? pkg.version : null;
}

// ── a small semver range matcher (^, ~, >=, >, <=, <, =, x, ||, hyphen-free) ─────────────────────

type Version = { nums: [number, number, number]; pre: string[] };

function parseVersion(text: string): Version | null {
  const m = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z.-]+))?/.exec(text.trim());
  if (!m) return null;
  const n = (s: string | undefined) => (s === undefined || s === 'x' || s === '*' ? 0 : Number(s));
  return { nums: [Number(m[1]), n(m[2]), n(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : Number.NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : Number.NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function satisfiesComparator(version: Version, comparator: string): boolean {
  const c = comparator.trim();
  if (c === '' || c === '*' || c === 'x') return true;
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(c);
  if (!m) return false;
  const op = m[1] ?? '=';
  const raw = m[2] as string;
  const target = parseVersion(raw);
  if (!target) return false;
  const parts = raw.replace(/^v/, '').split('-')[0]?.split('.') ?? [];
  const wild = (i: number) => parts[i] === undefined || parts[i] === 'x' || parts[i] === '*';
  const cmp = compare(version, target);
  if (op === '>=') return cmp >= 0;
  if (op === '>') return cmp > 0;
  if (op === '<=') return cmp <= 0;
  if (op === '<') return cmp < 0;
  const [major, minor] = target.nums;
  if (op === '^') {
    if (cmp < 0) return false;
    if (major > 0 || wild(1)) return version.nums[0] === major;
    if (minor > 0 || wild(2)) return version.nums[0] === 0 && version.nums[1] === minor;
    return compare({ nums: version.nums, pre: [] }, { nums: target.nums, pre: [] }) === 0;
  }
  if (op === '~') {
    if (cmp < 0) return false;
    return version.nums[0] === major && (wild(1) || version.nums[1] === minor);
  }
  if (wild(1)) return version.nums[0] === major;
  if (wild(2)) return version.nums[0] === major && version.nums[1] === minor;
  return cmp === 0;
}

/** Whether `version` satisfies `range` (prereleases included). */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  return range.split('||').some((set) =>
    set
      .trim()
      .replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1')
      .split(/\s+/)
      .every((comparator) => satisfiesComparator(v, comparator)),
  );
}

// ── built-in checks, one set per lib ──────────────────────────────────────────────────────────────

function packageOf(check: Pick<AgoraDoctorCheck, 'lib' | 'package'>): string {
  return check.package ?? `@adonis-agora/${check.lib}`;
}

function builtinChecks(lib: string, pkgName: string): AgoraDoctorCheck[] {
  return [
    {
      id: `${lib}.registered`,
      lib,
      title: 'Provider registered',
      run: () => ({ status: 'ok', message: `${pkgName} is registered in this app.` }),
    },
    {
      id: `${lib}.peers`,
      lib,
      title: 'Peer dependencies',
      run: async (app) => {
        const dir = await packageDir(pkgName, app.makePath());
        if (dir === null) {
          return { status: 'skip', message: `${pkgName} is not resolvable from the app root.` };
        }
        const pkg = await readJson(join(dir, 'package.json'));
        const peers = (pkg?.peerDependencies ?? {}) as Record<string, string>;
        const meta = (pkg?.peerDependenciesMeta ?? {}) as Record<string, { optional?: boolean }>;
        const results: AgoraDoctorResult[] = [];
        for (const [peer, range] of Object.entries(peers)) {
          const optional = meta[peer]?.optional === true;
          const version = await installedVersion(peer, dir);
          if (version === null) {
            results.push(
              optional
                ? { status: 'skip', message: `optional peer ${peer} is not installed.` }
                : {
                    status: 'error',
                    message: `required peer ${peer} (${range}) is not installed.`,
                    fix: `Install it: npm install ${peer}`,
                  },
            );
          } else if (!satisfies(version, range)) {
            results.push({
              status: 'error',
              message: `${peer} ${version} is outside the supported range ${range}.`,
              fix: `Install a version of ${peer} matching ${range}.`,
            });
          }
        }
        if (!results.some((r) => r.status !== 'skip')) {
          results.push({ status: 'ok', message: 'Every installed peer is in range.' });
        }
        return results;
      },
    },
    {
      id: `${lib}.agora-siblings`,
      lib,
      title: 'Agora versions line up',
      run: async (app) => {
        const own = await installedVersion(pkgName, app.makePath());
        if (own === null) return { status: 'skip', message: `${pkgName} is not installed.` };
        const manifest = await readJson(app.makePath('package.json'));
        const names = Object.keys({
          ...(manifest?.dependencies as object | undefined),
          ...(manifest?.devDependencies as object | undefined),
        }).filter((name) => name.startsWith('@adonis-agora/') && name !== pkgName);
        const ownMajor = parseVersion(own)?.nums[0] ?? 0;
        const off: string[] = [];
        for (const name of names) {
          const version = await installedVersion(name, app.makePath());
          if (version === null) continue;
          const major = parseVersion(version)?.nums[0] ?? 0;
          if ((ownMajor === 0) !== (major === 0)) off.push(`${name} ${version}`);
        }
        if (off.length === 0) return { status: 'ok', message: `${pkgName} ${own}.` };
        return {
          status: 'warn',
          message: `${pkgName} ${own} is installed next to ${off.join(', ')}: 0.x and 1.x Agora libs are not meant to be mixed.`,
          fix: 'Upgrade every @adonis-agora package to the same release line.',
        };
      },
    },
  ];
}

// ── running ───────────────────────────────────────────────────────────────────────────────────────

async function withTimeout<T>(work: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runOne(
  app: ApplicationService,
  check: AgoraDoctorCheck,
  options: AgoraDoctorOptions,
): Promise<AgoraDoctorReportEntry[]> {
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  const budget =
    check.cost === 'deep' ? (options.deepTimeoutMs ?? 15_000) : (options.timeoutMs ?? 5_000);
  try {
    const out = await withTimeout(async () => check.run(app), budget);
    const list = (Array.isArray(out) ? out : [out]).filter(
      (r): r is AgoraDoctorResult => typeof r === 'object' && r !== null,
    );
    return list.map((result) => ({
      id: check.id,
      lib: check.lib,
      title: check.title,
      status: (['ok', 'warn', 'error', 'skip'] as const).includes(result.status)
        ? result.status
        : 'error',
      message: String(result.message ?? ''),
      ...(result.fix ? { fix: result.fix } : {}),
      ...(result.docs ? { docs: result.docs } : {}),
      ms: ms(),
    }));
  } catch (error) {
    return [
      {
        id: check.id,
        lib: check.lib,
        title: check.title,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        ms: ms(),
      },
    ];
  }
}

/** Run the checks and build the report. Throws {@link AgoraDoctorUsageError} for an unknown `--only`. */
export async function runAgoraDoctor(
  app: ApplicationService,
  registered: readonly AgoraDoctorCheck[],
  options: AgoraDoctorOptions = {},
): Promise<{ report: AgoraDoctorReport; exitCode: 0 | 1 }> {
  const libNames = [...new Set(registered.map((check) => check.lib))].sort();
  const packages = new Map<string, string>();
  for (const check of registered)
    if (!packages.has(check.lib)) packages.set(check.lib, packageOf(check));
  const all: AgoraDoctorCheck[] = [];
  for (const lib of libNames) {
    all.push(...builtinChecks(lib, packages.get(lib) as string));
    all.push(...registered.filter((check) => check.lib === lib));
  }
  if (options.only !== undefined && !all.some((check) => check.id === options.only)) {
    throw new AgoraDoctorUsageError(`no check has the id "${options.only}".`);
  }
  const selected = all.filter(
    (check) =>
      (options.only === undefined || check.id === options.only) &&
      (options.libs === undefined ||
        options.libs.length === 0 ||
        options.libs.includes(check.lib)) &&
      (check.cost !== 'deep' || options.deep === true || options.only === check.id),
  );
  const byLib = new Map<string, AgoraDoctorCheck[]>();
  for (const check of selected) byLib.set(check.lib, [...(byLib.get(check.lib) ?? []), check]);

  const queue = [...byLib.keys()];
  const perLib = new Map<string, AgoraDoctorReportEntry[]>();
  const worker = async () => {
    for (let lib = queue.shift(); lib !== undefined; lib = queue.shift()) {
      const entries: AgoraDoctorReportEntry[] = [];
      for (const check of byLib.get(lib) ?? [])
        entries.push(...(await runOne(app, check, options)));
      perLib.set(lib, entries);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));

  const results = [...byLib.keys()].flatMap((lib) => perLib.get(lib) ?? []);
  const summary: Record<AgoraDoctorStatus, number> = { ok: 0, warn: 0, error: 0, skip: 0 };
  for (const r of results) summary[r.status] += 1;
  const libs = await Promise.all(
    [...byLib.keys()].map(async (lib) => {
      const pkg = packages.get(lib) as string;
      return { lib, package: pkg, version: await installedVersion(pkg, app.makePath()) };
    }),
  );
  const failed = summary.error > 0 || (options.strict === true && summary.warn > 0);
  return {
    report: {
      version: 1,
      env: app.inProduction ? 'production' : (app.nodeEnvironment ?? 'development'),
      summary,
      libs,
      results,
    },
    exitCode: failed ? 1 : 0,
  };
}

// ── rendering ─────────────────────────────────────────────────────────────────────────────────────

export interface Paint {
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

const plain: Paint = {
  green: (t) => t,
  yellow: (t) => t,
  red: (t) => t,
  dim: (t) => t,
  bold: (t) => t,
};

/** The human report. `fancy` = colors and symbols (a TTY without `NO_COLOR`). */
export function renderAgoraDoctor(
  report: AgoraDoctorReport,
  options: { verbose?: boolean; fancy?: boolean; paint?: Paint } = {},
): string {
  const p = options.fancy ? (options.paint ?? plain) : plain;
  const symbol = (status: AgoraDoctorStatus) => {
    if (!options.fancy) return status;
    if (status === 'ok') return p.green('✔');
    if (status === 'warn') return p.yellow('!');
    if (status === 'error') return p.red('✖');
    return p.dim('-');
  };
  const total = report.results.length;
  const lines = [
    p.bold(
      `@adonis-agora doctor · ${report.env} · ${report.libs.length} ${report.libs.length === 1 ? 'lib' : 'libs'} · ${total} checks`,
    ),
  ];
  for (const lib of report.libs) {
    const shown = report.results.filter(
      (r) => r.lib === lib.lib && (r.status !== 'skip' || options.verbose),
    );
    if (shown.length === 0) continue;
    lines.push('', p.bold(`${lib.lib}${lib.version ? ` ${lib.version}` : ''}`));
    for (const r of shown) {
      lines.push(`  ${symbol(r.status)} ${r.title}`);
      if (r.status !== 'ok' || options.verbose) lines.push(`    ${r.message}`);
      if (r.fix && r.status !== 'ok') lines.push(`    ${p.dim(`fix: ${r.fix}`)}`);
      if (r.docs && r.status !== 'ok') lines.push(`    ${p.dim(r.docs)}`);
    }
  }
  const { ok, warn, error, skip } = report.summary;
  const hidden = skip > 0 && !options.verbose ? `   (skipped ${skip}, run with --verbose)` : '';
  lines.push('', `${total} checks: ${ok} ok · ${warn} warn · ${error} error${hidden}`);
  return `${lines.join('\n')}\n`;
}
