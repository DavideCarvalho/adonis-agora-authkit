import {
  ACCOUNT_BLOCK_KINDS,
  ACCOUNT_EXTENSION_CONTRACT,
  type AccountAction,
  type AccountExtension,
  type AccountExtensionRegistry,
} from './contract.js';

const EXTENSION_ID = /^[a-z0-9-]{2,16}$/;
const PAGE_LOCAL_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const ACCOUNT_SEGMENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ACTION_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** Segments authkit itself uses under the account prefix, whatever the host renames. */
export const ACCOUNT_RESERVED_SEGMENTS = new Set([
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

export class AccountExtensionError extends Error {}

export function failAccountExtension(id: string, message: string): never {
  throw new AccountExtensionError(`authkit: account extension "${id}" — ${message}`);
}

function validateAction(id: string, pageId: string, name: string, action: AccountAction): void {
  if (!ACTION_NAME.test(name))
    failAccountExtension(id, `page "${pageId}" has an invalid action name "${name}".`);
  if (typeof action?.handle !== 'function') {
    failAccountExtension(id, `action "${pageId}.${name}" has no handle().`);
  }
  for (const field of action.fields ?? []) {
    if (!FIELD_NAME.test(field?.name ?? '')) {
      failAccountExtension(
        id,
        `action "${pageId}.${name}" has an invalid field name "${String(field?.name)}".`,
      );
    }
    if (!['text', 'select', 'textarea'].includes(field.kind)) {
      failAccountExtension(id, `field "${field.name}" of "${pageId}.${name}" has an unknown kind.`);
    }
    if (field.kind === 'select' && !(field.options && field.options.length > 0)) {
      failAccountExtension(
        id,
        `select field "${field.name}" of "${pageId}.${name}" needs options.`,
      );
    }
  }
}

/** Validates an extension's own shape (no knowledge of the other extensions). */
export function validateAccountExtension(extension: AccountExtension): void {
  const id = String(extension?.id);
  if (!EXTENSION_ID.test(id) || BUILTIN_IDS.has(id)) {
    failAccountExtension(id, 'invalid id (2–16 of a-z, 0-9, -; not a built-in screen).');
  }
  if (typeof extension.contract !== 'number' || !Number.isInteger(extension.contract)) {
    failAccountExtension(id, 'contract must be the major it was written against (1).');
  }
  if (extension.contract > ACCOUNT_EXTENSION_CONTRACT) {
    failAccountExtension(
      id,
      `written against contract ${extension.contract}; this authkit implements ${ACCOUNT_EXTENSION_CONTRACT}. Upgrade @adonis-agora/authkit.`,
    );
  }
  for (const [locale, catalog] of Object.entries(extension.messages ?? {})) {
    for (const key of Object.keys(catalog ?? {})) {
      if (!key.startsWith(`${id}.`)) {
        failAccountExtension(id, `message key "${key}" (${locale}) must start with "${id}.".`);
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
      failAccountExtension(
        id,
        `scriptOrigins entry "${origin}" must be an https origin (no path).`,
      );
    }
  }
  if (!Array.isArray(extension.pages) || extension.pages.length === 0) {
    failAccountExtension(id, 'needs at least one page.');
  }
  const pageIds = new Set<string>();
  const segments = new Set<string>();
  for (const page of extension.pages) {
    const pageId = String(page?.id);
    const [prefix, local, ...rest] = pageId.split('.');
    if (prefix !== id || !local || rest.length > 0 || !PAGE_LOCAL_ID.test(local)) {
      failAccountExtension(id, `page id "${pageId}" must be "${id}.<page>" (a-z, 0-9, -).`);
    }
    if (pageIds.has(pageId)) failAccountExtension(id, `page "${pageId}" is listed twice.`);
    pageIds.add(pageId);
    if (
      !ACCOUNT_SEGMENT.test(String(page.segment)) ||
      ACCOUNT_RESERVED_SEGMENTS.has(page.segment)
    ) {
      failAccountExtension(
        id,
        `page "${pageId}" has an invalid or reserved segment "${String(page.segment)}".`,
      );
    }
    if (segments.has(page.segment))
      failAccountExtension(id, `segment "${page.segment}" is used twice.`);
    segments.add(page.segment);
    if (typeof page.load !== 'function')
      failAccountExtension(id, `page "${pageId}" has no load().`);
    for (const [name, action] of Object.entries(page.actions ?? {}) as Array<
      [string, AccountAction]
    >) {
      validateAction(id, pageId, name, action);
    }
  }
}

/**
 * The registry an authkit package binds at `authkit.accountExtensions`: validates each extension
 * and keeps them in registration order. Throws on an invalid one outside production; in
 * production it is skipped and logged, so one bad contributor cannot take the console down.
 */
export class BaseAccountExtensionRegistry implements AccountExtensionRegistry {
  readonly contract = ACCOUNT_EXTENSION_CONTRACT;
  readonly blockKinds: readonly string[] = ACCOUNT_BLOCK_KINDS;
  protected readonly registered: AccountExtension[] = [];
  protected readonly isProduction: () => boolean;
  protected readonly log: (message: string) => void;

  constructor(options: { production?: () => boolean; log?: (message: string) => void } = {}) {
    this.isProduction = options.production ?? (() => false);
    this.log = options.log ?? ((message) => console.error(message));
  }

  /** Hook for subclasses: throw to refuse a registration (e.g. after a freeze). */
  protected beforeRegister(_extension: AccountExtension): void {}

  register(extension: AccountExtension): void {
    this.beforeRegister(extension);
    try {
      validateAccountExtension(extension);
      if (this.registered.some((e) => e.id === extension.id)) {
        failAccountExtension(extension.id, 'is registered twice.');
      }
      for (const other of this.registered) {
        for (const page of extension.pages) {
          if (other.pages.some((p) => p.segment === page.segment)) {
            failAccountExtension(
              extension.id,
              `segment "${page.segment}" is already used by "${other.id}".`,
            );
          }
        }
      }
    } catch (error) {
      if (!this.isProduction()) throw error;
      this.log(`${(error as Error).message} The extension is skipped.`);
      return;
    }
    this.registered.push(extension);
  }

  /** The registered extensions, in registration order. */
  extensions(): readonly AccountExtension[] {
    return this.registered;
  }
}
