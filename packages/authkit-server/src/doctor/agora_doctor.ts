// agora-doctor runner v1 — keep identical across libs
//
// `node ace agora:doctor`: one health check for every installed `@adonis-agora` lib. Every lib ships
// this file byte for byte (a CI script diffs it). Libs register checks into a data-only container
// value at `'agora.doctor'`, created if absent; whichever lib's copy of the command Ace keeps runs
// them all. No lib imports another.

import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ApplicationService } from '@adonisjs/core/types';

/** The container key the registry is bound at, as a value. */
export const AGORA_DOCTOR_BINDING = 'agora.doctor';

export type AgoraDoctorStatus = 'ok' | 'warn' | 'error' | 'skip';

export interface AgoraDoctorResult {
  status: AgoraDoctorStatus;
  /** One line, no secrets, no stack. */
  message: string;
  /** One line: the exact change to make. */
  fix?: string;
  /** Absolute URL to the lib docs page. */
  docs?: string;
}

export interface AgoraDoctorCheck {
  /** `<lib>.<kebab>`, unique, frozen for 1.x. */
  id: string;
  lib: string;
  title: string;
  /** `cheap` (default): config, env and files only. `deep`: DB, Redis or network; only with `--deep`. */
  cost?: 'cheap' | 'deep';
  run(
    app: ApplicationService,
  ): AgoraDoctorResult | AgoraDoctorResult[] | Promise<AgoraDoctorResult | AgoraDoctorResult[]>;
}

/** Which package a lib id belongs to, so the runner can check its peers. */
export interface AgoraDoctorLib {
  lib: string;
  /** npm name, e.g. `@adonis-agora/durable`. */
  package: string;
  /** `import.meta.url` of any module inside the package (used to find its package.json). */
  from: string;
}

/** Bound as a VALUE under `'agora.doctor'`. Data only. */
export interface AgoraDoctorRegistry {
  readonly version: 1;
  readonly checks: AgoraDoctorCheck[];
  /** Libs that registered (optional: a registry created by an older copy may lack it). */
  libs?: AgoraDoctorLib[];
}

interface ContainerLike {
  hasBinding(key: string): boolean;
  bindValue(key: string, value: unknown): void;
  make(key: string): Promise<unknown>;
}

/**
 * Register a lib's checks. Call it from the provider's `register()` (Adonis does not await it, so
 * neither must you): it only stores descriptors. Creates the registry when absent, skips a registry
 * of another version, warns once on a duplicate id. Never throws.
 */
export function registerDoctorChecks(
  app: { container: unknown },
  lib: AgoraDoctorLib,
  checks: AgoraDoctorCheck[],
): Promise<void> {
  const container = app.container as ContainerLike;
  const add = (registry: AgoraDoctorRegistry) => {
    if (registry?.version !== 1 || !Array.isArray(registry.checks)) return;
    if (!Array.isArray(registry.libs)) (registry as { libs?: AgoraDoctorLib[] }).libs = [];
    if (!registry.libs!.some((entry) => entry.lib === lib.lib)) registry.libs!.push(lib);
    for (const check of checks) {
      if (registry.checks.some((existing) => existing.id === check.id)) {
        console.warn(`[${lib.package}] doctor check "${check.id}" is already registered; skipped`);
        continue;
      }
      registry.checks.push(check);
    }
  };
  try {
    if (!container.hasBinding(AGORA_DOCTOR_BINDING)) {
      const registry: AgoraDoctorRegistry = { version: 1, checks: [], libs: [] };
      add(registry);
      container.bindValue(AGORA_DOCTOR_BINDING, registry);
      return Promise.resolve();
    }
    return container.make(AGORA_DOCTOR_BINDING).then(
      (registry) => add(registry as AgoraDoctorRegistry),
      () => {},
    );
  } catch {
    return Promise.resolve();
  }
}

// ----------------------------------------------------------------------------------------------
// Running

export interface AgoraDoctorOptions {
  deep?: boolean;
  /** Lib ids to keep. */
  libs?: string[];
  /** Run only this check id. */
  only?: string;
  /** Per-check timeouts in ms (defaults 5000 cheap / 15000 deep). */
  timeouts?: { cheap: number; deep: number };
}

export interface AgoraDoctorReportResult extends AgoraDoctorResult {
  id: string;
  lib: string;
  title: string;
  ms: number;
}

export interface AgoraDoctorReport {
  version: 1;
  env: string;
  summary: Record<AgoraDoctorStatus, number>;
  libs: Array<{ lib: string; package: string; version: string | null }>;
  results: AgoraDoctorReportResult[];
}

/** The doctor itself cannot run (exit code 2). */
export class AgoraDoctorUsageError extends Error {}

const STATUSES: readonly AgoraDoctorStatus[] = ['ok', 'warn', 'error', 'skip'];

export async function runAgoraDoctor(
  app: ApplicationService,
  registry: unknown,
  options: AgoraDoctorOptions = {},
): Promise<AgoraDoctorReport> {
  const reg = registry as AgoraDoctorRegistry | undefined;
  if (reg === undefined || reg === null) {
    return report(app, [], [], []);
  }
  if (reg.version !== 1 || !Array.isArray(reg.checks)) {
    throw new AgoraDoctorUsageError(
      `the agora.doctor registry has version ${String(reg.version)}; this doctor knows version 1`,
    );
  }
  const libInfos = Array.isArray(reg.libs) ? reg.libs : [];
  const all: AgoraDoctorCheck[] = [];
  for (const info of libInfos) all.push(...builtinChecks(info));
  all.push(...reg.checks);

  const known = new Set(all.map((check) => check.lib));
  for (const lib of options.libs ?? []) {
    if (!known.has(lib)) {
      throw new AgoraDoctorUsageError(
        `--lib: no lib "${lib}" registered checks (known: ${[...known].sort().join(', ') || 'none'})`,
      );
    }
  }
  if (options.only !== undefined && !all.some((check) => check.id === options.only)) {
    throw new AgoraDoctorUsageError(`--only: no check with id "${options.only}"`);
  }

  const selected = all.filter(
    (check) =>
      (options.only === undefined || check.id === options.only) &&
      (options.libs === undefined ||
        options.libs.length === 0 ||
        options.libs.includes(check.lib)) &&
      (options.deep === true || options.only !== undefined || (check.cost ?? 'cheap') === 'cheap'),
  );

  const byLib = new Map<string, AgoraDoctorCheck[]>();
  for (const check of selected) {
    const list = byLib.get(check.lib) ?? [];
    list.push(check);
    byLib.set(check.lib, list);
  }
  const libOrder = [...byLib.keys()].sort();
  const timeouts = options.timeouts ?? { cheap: 5000, deep: 15000 };
  const perLib = new Map<string, AgoraDoctorReportResult[]>();
  let next = 0;
  const worker = async () => {
    while (next < libOrder.length) {
      const lib = libOrder[next++]!;
      const out: AgoraDoctorReportResult[] = [];
      for (const check of byLib.get(lib)!) out.push(...(await runOne(app, check, timeouts)));
      perLib.set(lib, out);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, libOrder.length) }, worker));
  const results = libOrder.flatMap((lib) => perLib.get(lib) ?? []);
  const libsReport = await Promise.all(
    libInfos
      .filter((info) => byLib.has(info.lib))
      .map(async (info) => ({
        lib: info.lib,
        package: info.package,
        version: (await ownPackageJson(info))?.version ?? null,
      })),
  );
  return report(app, libsReport, results, libOrder);
}

function report(
  app: ApplicationService,
  libs: AgoraDoctorReport['libs'],
  results: AgoraDoctorReportResult[],
  order: string[],
): AgoraDoctorReport {
  const summary = { ok: 0, warn: 0, error: 0, skip: 0 };
  for (const result of results) summary[result.status]++;
  libs.sort((a, b) => order.indexOf(a.lib) - order.indexOf(b.lib));
  return { version: 1, env: envName(app), summary, libs, results };
}

function envName(app: ApplicationService): string {
  if (app.inProduction) return 'production';
  return (app as { nodeEnvironment?: string }).nodeEnvironment ?? 'development';
}

async function runOne(
  app: ApplicationService,
  check: AgoraDoctorCheck,
  timeouts: { cheap: number; deep: number },
): Promise<AgoraDoctorReportResult[]> {
  const started = Date.now();
  const limit = (check.cost ?? 'cheap') === 'deep' ? timeouts.deep : timeouts.cheap;
  const base = { id: check.id, lib: check.lib, title: check.title };
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() => check.run(app)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${Math.round(limit / 1000)}s`)),
          limit,
        );
        timer.unref?.();
      }),
    ]);
    const list = (Array.isArray(value) ? value : [value]).filter(
      (entry): entry is AgoraDoctorResult =>
        !!entry && STATUSES.includes((entry as AgoraDoctorResult).status),
    );
    const ms = Date.now() - started;
    if (list.length === 0) return [{ ...base, status: 'skip', message: 'nothing to report', ms }];
    return list.map((entry) => ({ ...base, ...entry, ms }));
  } catch (error) {
    return [
      {
        ...base,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        ms: Date.now() - started,
      },
    ];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** `0` no error · `1` an error (or a warn with `strict`). */
export function agoraDoctorExitCode(result: AgoraDoctorReport, strict = false): 0 | 1 {
  if (result.summary.error > 0) return 1;
  if (strict && result.summary.warn > 0) return 1;
  return 0;
}

// ----------------------------------------------------------------------------------------------
// Built-in checks: `<lib>.registered`, `<lib>.peers`, `<lib>.agora-siblings`

function builtinChecks(info: AgoraDoctorLib): AgoraDoctorCheck[] {
  return [
    {
      id: `${info.lib}.registered`,
      lib: info.lib,
      title: 'Provider registered',
      run: () => ({ status: 'ok', message: `${info.package} is registered in adonisrc.ts` }),
    },
    {
      id: `${info.lib}.peers`,
      lib: info.lib,
      title: 'Peer dependencies',
      run: (app) => checkPeers(app, info),
    },
    {
      id: `${info.lib}.agora-siblings`,
      lib: info.lib,
      title: 'One copy of each @adonis-agora package',
      run: (app) => checkSiblings(app, info),
    },
  ];
}

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

async function readJson(path: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

/** The lib's own package.json: walk up from `info.from` to the first one named `info.package`. */
async function ownPackageJson(info: AgoraDoctorLib): Promise<PackageJson | null> {
  let dir = dirname(fileURLToPath(info.from));
  for (;;) {
    const pkg = await readJson(join(dir, 'package.json'));
    if (pkg?.name === info.package) return pkg;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Installed version of `name` as the app sees it, or null. */
async function installedVersion(appRoot: string, name: string): Promise<string | null> {
  const direct = await readJson(join(appRoot, 'node_modules', name, 'package.json'));
  if (direct?.version) return direct.version;
  try {
    const resolved = createRequire(join(appRoot, 'package.json')).resolve(name);
    let dir = dirname(resolved);
    for (;;) {
      const pkg = await readJson(join(dir, 'package.json'));
      if (pkg?.name === name && pkg.version) return pkg.version;
      const parent = dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

function appRootOf(app: ApplicationService): string {
  return dirname(app.makePath('package.json'));
}

export async function checkPeers(
  app: ApplicationService,
  info: AgoraDoctorLib,
): Promise<AgoraDoctorResult[]> {
  const pkg = await ownPackageJson(info);
  if (!pkg) return [{ status: 'skip', message: `could not read ${info.package}/package.json` }];
  const peers = pkg.peerDependencies ?? {};
  const meta = pkg.peerDependenciesMeta ?? {};
  const root = appRootOf(app);
  const out: AgoraDoctorResult[] = [];
  let satisfied = 0;
  for (const [name, range] of Object.entries(peers)) {
    const optional = meta[name]?.optional === true;
    const version = await installedVersion(root, name);
    if (version === null) {
      if (!optional) {
        out.push({
          status: 'error',
          message: `required peer ${name} (${range}) is not installed`,
          fix: `Install it: npm i ${name}`,
        });
      }
      continue;
    }
    const verdict = satisfiesRange(version, range);
    if (verdict === false) {
      out.push({
        status: 'error',
        message: `peer ${name} ${version} is outside ${range}`,
        fix: `Install a version of ${name} matching ${range}`,
      });
      continue;
    }
    satisfied++;
  }
  if (out.length === 0) {
    out.push({ status: 'ok', message: `${satisfied} installed peer(s) match their ranges` });
  }
  return out;
}

export async function checkSiblings(
  app: ApplicationService,
  info: AgoraDoctorLib,
): Promise<AgoraDoctorResult> {
  const pkg = await ownPackageJson(info);
  const watched = new Set<string>([info.package]);
  for (const name of Object.keys({ ...pkg?.dependencies, ...pkg?.peerDependencies })) {
    if (name.startsWith('@adonis-agora/')) watched.add(name);
  }
  const versions = new Map<string, Set<string>>();
  let entries: string[] = [];
  try {
    entries = await readdir(join(appRootOf(app), 'node_modules', '.pnpm'));
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const match = /^@adonis-agora\+([^@]+)@([^_]+)/.exec(entry);
    if (!match) continue;
    const name = `@adonis-agora/${match[1]}`;
    if (!watched.has(name)) continue;
    const set = versions.get(name) ?? new Set<string>();
    set.add(match[2]!);
    versions.set(name, set);
  }
  const dupes = [...versions.entries()].filter(([, set]) => set.size > 1);
  if (dupes.length === 0) {
    return { status: 'ok', message: 'one installed copy of each related @adonis-agora package' };
  }
  return {
    status: 'warn',
    message: `several versions installed: ${dupes
      .map(([name, set]) => `${name} (${[...set].sort().join(', ')})`)
      .join('; ')}`,
    fix: 'Align the @adonis-agora versions in package.json and reinstall (pnpm dedupe)',
  };
}

// ----------------------------------------------------------------------------------------------
// A small semver range matcher: `^ ~ >= > <= < =`, x-ranges, hyphen-free AND sets and `||`.

type Parsed = { nums: [number, number, number]; pre: Array<string | number> };

function parseVersion(text: string): Parsed | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(text.trim());
  if (!match) return null;
  const pre = match[4]
    ? match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  return { nums: [Number(match[1]), Number(match[2]), Number(match[3])], pre };
}

function compare(a: Parsed, b: Parsed): number {
  for (let i = 0; i < 3; i++) if (a.nums[i] !== b.nums[i]) return a.nums[i]! - b.nums[i]!;
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Expand a partial (`1`, `1.2`, `1.x`) into its lower bound and the bound it stops before. */
function partial(text: string): { low: Parsed; high: Parsed | null } | null {
  const full = parseVersion(text);
  if (full) return { low: full, high: null };
  const match = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(text);
  if (!match) return null;
  const parts = [match[1], match[2], match[3]].map((p) =>
    p === undefined || /[xX*]/.test(p) ? null : Number(p),
  );
  if (parts[0] === null) return { low: { nums: [0, 0, 0], pre: [] }, high: null };
  if (parts[1] === null) {
    return {
      low: { nums: [parts[0]!, 0, 0], pre: [] },
      high: { nums: [parts[0]! + 1, 0, 0], pre: [0] },
    };
  }
  return {
    low: { nums: [parts[0]!, parts[1]!, 0], pre: [] },
    high: { nums: [parts[0]!, parts[1]! + 1, 0], pre: [0] },
  };
}

function comparatorOk(version: Parsed, comparator: string): boolean | null {
  const match = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(comparator);
  if (!match) return null;
  const op = match[1] ?? '';
  const range = partial(match[2]!);
  if (!range) return null;
  const { low, high } = range;
  const cmp = compare(version, low);
  switch (op) {
    case '>=':
      return cmp >= 0;
    case '>':
      return high ? compare(version, high) >= 0 : cmp > 0;
    case '<':
      return cmp < 0;
    case '<=':
      return high ? compare(version, high) < 0 : cmp <= 0;
    case '^': {
      const [major, minor, patch] = low.nums;
      const upper: Parsed =
        major > 0
          ? { nums: [major + 1, 0, 0], pre: [0] }
          : minor > 0
            ? { nums: [0, minor + 1, 0], pre: [0] }
            : { nums: [0, 0, patch + 1], pre: [0] };
      return cmp >= 0 && compare(version, upper) < 0;
    }
    case '~':
      return (
        cmp >= 0 && compare(version, { nums: [low.nums[0], low.nums[1] + 1, 0], pre: [0] }) < 0
      );
    default:
      return high ? cmp >= 0 && compare(version, high) < 0 : cmp === 0;
  }
}

/**
 * Does `version` satisfy `range`? `null` when the range is not a plain semver range
 * (`catalog:`, `workspace:`, a URL): the caller treats that as unknown, not as a failure.
 */
export function satisfiesRange(version: string, range: string): boolean | null {
  const parsed = parseVersion(version);
  if (!parsed) return null;
  if (/^(catalog|workspace|npm|file|link|git|https?):/.test(range.trim())) return null;
  const sets = range.split('||').map((set) => set.trim());
  let unknown = false;
  for (const set of sets) {
    if (set === '' || set === '*' || set === 'x') return true;
    const comparators = set.replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/);
    let all = true;
    for (const comparator of comparators) {
      const ok = comparatorOk(parsed, comparator);
      if (ok === null) {
        unknown = true;
        all = false;
        break;
      }
      if (!ok) {
        all = false;
        break;
      }
    }
    // npm's rule: a prerelease only matches a set that names a prerelease of the same x.y.z.
    if (all && parsed.pre.length > 0) {
      all = comparators.some((comparator) => {
        const bound = parseVersion(comparator.replace(/^(\^|~|>=|<=|>|<|=)/, ''));
        return (
          bound !== null && bound.pre.length > 0 && bound.nums.every((n, i) => n === parsed.nums[i])
        );
      });
    }
    if (all) return true;
  }
  return unknown ? null : false;
}

// ----------------------------------------------------------------------------------------------
// Rendering

export interface AgoraDoctorPalette {
  green(text: string): string;
  yellow(text: string): string;
  red(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

const PLAIN: AgoraDoctorPalette = {
  green: (t) => t,
  yellow: (t) => t,
  red: (t) => t,
  dim: (t) => t,
  bold: (t) => t,
};

export function renderAgoraDoctor(
  result: AgoraDoctorReport,
  options: { verbose?: boolean; symbols?: boolean; palette?: AgoraDoctorPalette } = {},
): string[] {
  const c = options.palette ?? PLAIN;
  const mark = (status: AgoraDoctorStatus) => {
    if (options.symbols === false) {
      return {
        ok: c.green('ok'),
        warn: c.yellow('warn'),
        error: c.red('error'),
        skip: c.dim('skip'),
      }[status];
    }
    return { ok: c.green('✔'), warn: c.yellow('!'), error: c.red('✖'), skip: c.dim('-') }[status];
  };
  const total = result.results.length;
  const lines = [
    c.bold(`@adonis-agora doctor · ${result.env} · ${result.libs.length} libs · ${total} checks`),
  ];
  const versions = new Map(result.libs.map((lib) => [lib.lib, lib.version]));
  let current: string | null = null;
  for (const entry of result.results) {
    if (entry.status === 'skip' && options.verbose !== true) continue;
    if (entry.lib !== current) {
      current = entry.lib;
      const version = versions.get(entry.lib);
      lines.push('', c.bold(version ? `${entry.lib} ${version}` : entry.lib));
    }
    lines.push(`  ${mark(entry.status)} ${entry.title}`);
    if (entry.status !== 'ok' || options.verbose === true) {
      lines.push(`    ${entry.message}`);
      if (entry.fix) lines.push(`    fix: ${entry.fix}`);
      if (entry.docs && entry.status !== 'ok') lines.push(`    docs: ${entry.docs}`);
    }
  }
  const s = result.summary;
  const hidden =
    options.verbose === true || s.skip === 0 ? '' : `   (skipped ${s.skip}, run with --verbose)`;
  lines.push('', `${total} checks: ${s.ok} ok · ${s.warn} warn · ${s.error} error${hidden}`);
  return lines;
}

// ----------------------------------------------------------------------------------------------
// The command body (each lib's `agora:doctor` command delegates here)

export interface AgoraDoctorFlags {
  json?: boolean;
  deep?: boolean;
  lib?: string;
  only?: string;
  strict?: boolean;
  verbose?: boolean;
  /** `false` with `--no-boot`: load config and run providers' `register()` only. */
  boot?: boolean;
}

export interface AgoraDoctorIo {
  /** stdout line. */
  out(line: string): void;
  /** stderr line. */
  err(line: string): void;
  palette?: AgoraDoctorPalette;
  /** Use ✔/!/✖ (a TTY) or ok/warn/error words. */
  symbols?: boolean;
}

/**
 * Bring the app up for the doctor. Default: a full boot and start, like any `startApp` command.
 * `boot: false`: config is loaded and every provider's `register()` runs, but no `boot()` and no
 * preload, so the registry is filled even when a provider's `boot()` is what fails.
 */
export async function prepareAgoraDoctorApp(app: ApplicationService, boot: boolean): Promise<void> {
  // Already booted (a test, or a command run from another one): use the app as it is.
  const state = (app as { getState?(): string }).getState?.();
  if (app.isReady || (state !== undefined && state !== 'initiated')) return;
  if (boot) {
    await app.boot();
    await app.start(() => {});
    return;
  }
  type Entry = { file: () => Promise<{ default: new (app: unknown) => object }> };
  const rc = app.rcFile as unknown as { providers: Entry[] };
  rc.providers = rc.providers.map((entry) => ({
    ...entry,
    file: async () => {
      let Provider: (new (app: unknown) => { register?(): unknown }) | undefined;
      try {
        Provider = (await entry.file()).default as typeof Provider;
      } catch {
        Provider = undefined;
      }
      return {
        default: class RegisterOnly {
          #inner: { register?(): unknown } | undefined;
          constructor(target: unknown) {
            try {
              this.#inner = Provider ? new Provider(target) : undefined;
            } catch {
              this.#inner = undefined;
            }
          }
          async register() {
            try {
              await this.#inner?.register?.();
            } catch {
              // --no-boot is best effort: a provider that cannot register contributes no checks.
            }
          }
        },
      };
    },
  }));
  await app.boot();
}

export async function executeAgoraDoctor(
  app: ApplicationService,
  flags: AgoraDoctorFlags,
  io: AgoraDoctorIo,
): Promise<0 | 1 | 2> {
  const libs = flags.lib
    ? flags.lib
        .split(',')
        .map((lib) => lib.trim())
        .filter(Boolean)
    : undefined;
  await prepareAgoraDoctorApp(app, flags.boot !== false);
  const container = app.container as unknown as ContainerLike;
  const registry = container.hasBinding(AGORA_DOCTOR_BINDING)
    ? await container.make(AGORA_DOCTOR_BINDING)
    : undefined;
  let result: AgoraDoctorReport;
  try {
    result = await runAgoraDoctor(app, registry, { deep: flags.deep, libs, only: flags.only });
  } catch (error) {
    if (error instanceof AgoraDoctorUsageError) {
      io.err(`agora:doctor: ${error.message}`);
      return 2;
    }
    throw error;
  }
  if (flags.json === true) {
    io.out(JSON.stringify(result));
  } else {
    for (const line of renderAgoraDoctor(result, {
      verbose: flags.verbose,
      symbols: io.symbols,
      palette: io.palette,
    })) {
      io.out(line);
    }
  }
  return agoraDoctorExitCode(result, flags.strict === true);
}
