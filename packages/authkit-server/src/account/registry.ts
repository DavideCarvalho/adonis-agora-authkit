import {
  ACCOUNT_BLOCK_KINDS,
  ACCOUNT_EXTENSION_CONTRACT,
  type AccountAction,
  type AccountExtension,
  type AccountExtensionOverride,
  type AccountExtensionRegistry,
  type AccountPage,
} from './extension.js';

const EXTENSION_ID = /^[a-z0-9-]{2,16}$/;
const PAGE_LOCAL_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ACTION_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** Segments authkit itself uses under the account prefix, whatever the host renames. */
const RESERVED_SEGMENTS = new Set([
  'api',
  'login',
  'logout',
  'security',
  'mfa',
  'confirm',
  'tokens',
  'apps',
  'orgs',
  'email',
  'x',
  'assets',
]);

/** Built-in screen keys (an extension id may not shadow one). */
const BUILTIN_IDS = new Set([
  'login',
  'logout',
  'security',
  'mfa',
  'confirm',
  'tokens',
  'apps',
  'orgs',
  'account',
  'authkit',
]);

/** A page as the console serves it, after host overrides. */
export interface RegisteredAccountPage {
  extensionId: string;
  page: AccountPage;
  segment: string;
  order: number;
  scriptOrigins: readonly string[];
}

/** Thrown for an invalid extension; the message names it. */
export class AccountExtensionError extends Error {}

function fail(id: string, message: string): never {
  throw new AccountExtensionError(`authkit: account extension "${id}" — ${message}`);
}

function validateAction(id: string, pageId: string, name: string, action: AccountAction): void {
  if (!ACTION_NAME.test(name)) fail(id, `page "${pageId}" has an invalid action name "${name}".`);
  if (typeof action?.handle !== 'function') {
    fail(id, `action "${pageId}.${name}" has no handle().`);
  }
  for (const field of action.fields ?? []) {
    if (!FIELD_NAME.test(field?.name ?? '')) {
      fail(id, `action "${pageId}.${name}" has an invalid field name "${String(field?.name)}".`);
    }
    if (!['text', 'select', 'textarea'].includes(field.kind)) {
      fail(id, `field "${field.name}" of "${pageId}.${name}" has an unknown kind.`);
    }
    if (field.kind === 'select' && !(field.options && field.options.length > 0)) {
      fail(id, `select field "${field.name}" of "${pageId}.${name}" needs options.`);
    }
  }
}

/** Validates an extension's own shape (no knowledge of the other extensions). */
export function validateAccountExtension(extension: AccountExtension): void {
  const id = String(extension?.id);
  if (!EXTENSION_ID.test(id) || BUILTIN_IDS.has(id)) {
    fail(id, 'invalid id (2–16 of a-z, 0-9, -; not a built-in screen).');
  }
  if (typeof extension.contract !== 'number' || !Number.isInteger(extension.contract)) {
    fail(id, 'contract must be the major it was written against (1).');
  }
  if (extension.contract > ACCOUNT_EXTENSION_CONTRACT) {
    fail(
      id,
      `written against contract ${extension.contract}; this authkit implements ${ACCOUNT_EXTENSION_CONTRACT}. Upgrade @adonis-agora/authkit-server.`,
    );
  }
  for (const [locale, catalog] of Object.entries(extension.messages ?? {})) {
    for (const key of Object.keys(catalog ?? {})) {
      if (!key.startsWith(`${id}.`)) {
        fail(id, `message key "${key}" (${locale}) must start with "${id}.".`);
      }
    }
  }
  for (const origin of extension.scriptOrigins ?? []) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(origin);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== 'https:' || parsed.origin !== origin) {
      fail(id, `scriptOrigins entry "${origin}" must be an https origin (no path).`);
    }
  }
  if (!Array.isArray(extension.pages) || extension.pages.length === 0) {
    fail(id, 'needs at least one page.');
  }
  const pageIds = new Set<string>();
  const segments = new Set<string>();
  for (const page of extension.pages) {
    const pageId = String(page?.id);
    const [prefix, local, ...rest] = pageId.split('.');
    if (prefix !== id || !local || rest.length > 0 || !PAGE_LOCAL_ID.test(local)) {
      fail(id, `page id "${pageId}" must be "${id}.<page>" (a-z, 0-9, -).`);
    }
    if (pageIds.has(pageId)) fail(id, `page "${pageId}" is listed twice.`);
    pageIds.add(pageId);
    if (!SEGMENT.test(String(page.segment)) || RESERVED_SEGMENTS.has(page.segment)) {
      fail(id, `page "${pageId}" has an invalid or reserved segment "${String(page.segment)}".`);
    }
    if (segments.has(page.segment)) fail(id, `segment "${page.segment}" is used twice.`);
    segments.add(page.segment);
    if (typeof page.load !== 'function') fail(id, `page "${pageId}" has no load().`);
    for (const [name, action] of Object.entries(page.actions ?? {}) as Array<
      [string, AccountAction]
    >) {
      validateAction(id, pageId, name, action);
    }
  }
}

export interface FreezeOptions {
  /** `accountConsole.extensions` from `config/authkit.ts`. */
  overrides?: Readonly<Record<string, AccountExtensionOverride>>;
  /** Segments of the mounted built-in screens (after `accountRoutes` renames). */
  builtinSegments?: readonly string[];
  /** `true` → an invalid extension is skipped and logged instead of thrown. */
  production: boolean;
  log?: (message: string) => void;
}

/**
 * The registry bound at `authkit.accountExtensions`. Contributors call `register()` from their
 * provider's `boot()`; authkit freezes it when it mounts the console routes.
 */
export class AccountExtensionRegistryImpl implements AccountExtensionRegistry {
  readonly contract = ACCOUNT_EXTENSION_CONTRACT;
  readonly blockKinds: readonly string[] = ACCOUNT_BLOCK_KINDS;
  readonly #extensions: AccountExtension[] = [];
  #pages: RegisteredAccountPage[] | null = null;
  #production: () => boolean;
  #log: (message: string) => void;

  constructor(options: { production?: () => boolean; log?: (message: string) => void } = {}) {
    this.#production = options.production ?? (() => false);
    this.#log = options.log ?? ((message) => console.error(message));
  }

  /** Adds an extension. Throws outside production on an invalid one; skips it in production. */
  register(extension: AccountExtension): void {
    if (this.#pages !== null) {
      throw new AccountExtensionError(
        `authkit: account extension "${String(extension?.id)}" registered after the account console routes were mounted. Register it from your provider's boot(), not from a preload.`,
      );
    }
    try {
      validateAccountExtension(extension);
      if (this.#extensions.some((e) => e.id === extension.id)) {
        fail(extension.id, 'is registered twice.');
      }
      for (const other of this.#extensions) {
        for (const page of extension.pages) {
          if (other.pages.some((p) => p.segment === page.segment)) {
            fail(extension.id, `segment "${page.segment}" is already used by "${other.id}".`);
          }
        }
      }
    } catch (error) {
      if (!this.#production()) throw error;
      this.#log(`${(error as Error).message} The extension is skipped.`);
      return;
    }
    this.#extensions.push(extension);
  }

  get frozen(): boolean {
    return this.#pages !== null;
  }

  /** The registered extensions, in registration order. */
  extensions(): readonly AccountExtension[] {
    return this.#extensions;
  }

  /**
   * Applies the host overrides, checks the segments against the mounted screens and freezes the
   * registry. Returns the pages to serve. Idempotent.
   */
  freeze(options: FreezeOptions): RegisteredAccountPage[] {
    if (this.#pages !== null) return this.#pages;
    const log = options.log ?? this.#log;
    const builtin = new Set(options.builtinSegments ?? []);
    const used = new Map<string, string>();
    const out: RegisteredAccountPage[] = [];
    for (const extension of this.#extensions) {
      const override = options.overrides?.[extension.id];
      if (override === false) continue;
      const pages: RegisteredAccountPage[] = [];
      try {
        for (const page of extension.pages) {
          const pageOverride = override ? override.pages?.[page.id] : undefined;
          if (pageOverride === false) continue;
          const segment = pageOverride?.segment ?? page.segment;
          if (!SEGMENT.test(segment) || RESERVED_SEGMENTS.has(segment)) {
            fail(
              extension.id,
              `accountConsole.extensions renames "${page.id}" to an invalid segment "${segment}".`,
            );
          }
          if (builtin.has(segment)) {
            fail(
              extension.id,
              `segment "${segment}" of "${page.id}" collides with a built-in screen.`,
            );
          }
          const owner = used.get(segment);
          if (owner)
            fail(
              extension.id,
              `segment "${segment}" of "${page.id}" is already used by "${owner}".`,
            );
          used.set(segment, page.id);
          const nav = page.nav === false ? undefined : page.nav;
          pages.push({
            extensionId: extension.id,
            page,
            segment,
            order: pageOverride?.order ?? nav?.order ?? 100,
            scriptOrigins: extension.scriptOrigins ?? [],
          });
        }
      } catch (error) {
        for (const page of pages) used.delete(page.segment);
        if (!options.production) throw error;
        log(`${(error as Error).message} The extension is skipped.`);
        continue;
      }
      out.push(...pages);
    }
    for (const id of Object.keys(options.overrides ?? {})) {
      if (!this.#extensions.some((e) => e.id === id)) {
        log(
          `authkit: accountConsole.extensions names "${id}", which no installed package registered.`,
        );
      }
    }
    this.#pages = out;
    return out;
  }

  /** The served pages (empty until frozen). */
  pages(): readonly RegisteredAccountPage[] {
    return this.#pages ?? [];
  }
}
