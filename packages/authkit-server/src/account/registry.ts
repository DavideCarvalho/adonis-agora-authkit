import {
  ACCOUNT_RESERVED_SEGMENTS,
  ACCOUNT_SEGMENT,
  AccountExtensionError,
  BaseAccountExtensionRegistry,
  failAccountExtension as fail,
  validateAccountExtension,
} from '@adonis-agora/authkit-core';
import type { AccountExtensionOverride, AccountPage } from './extension.js';

export { AccountExtensionError, validateAccountExtension };

/** A page as the console serves it, after host overrides. */
export interface RegisteredAccountPage {
  extensionId: string;
  page: AccountPage;
  segment: string;
  order: number;
  scriptOrigins: readonly string[];
  /** Client id of the app serving it, for a remote page. */
  remote?: string;
}

/** Thrown for an invalid extension; the message names it. */
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
export class AccountExtensionRegistryImpl extends BaseAccountExtensionRegistry {
  #pages: RegisteredAccountPage[] | null = null;

  protected override beforeRegister(extension: { id?: unknown }): void {
    if (this.#pages !== null) {
      throw new AccountExtensionError(
        `authkit: account extension "${String(extension?.id)}" registered after the account console routes were mounted. Register it from your provider's boot(), not from a preload.`,
      );
    }
  }

  get frozen(): boolean {
    return this.#pages !== null;
  }

  /**
   * Applies the host overrides, checks the segments against the mounted screens and freezes the
   * registry. Returns the pages to serve. Idempotent.
   */
  freeze(options: FreezeOptions): RegisteredAccountPage[] {
    if (this.#pages !== null) return this.#pages;
    const log = options.log ?? this.log;
    const builtin = new Set(options.builtinSegments ?? []);
    const used = new Map<string, string>();
    const out: RegisteredAccountPage[] = [];
    for (const extension of this.registered) {
      const override = options.overrides?.[extension.id];
      if (override === false) continue;
      const pages: RegisteredAccountPage[] = [];
      try {
        for (const page of extension.pages) {
          const pageOverride = override ? override.pages?.[page.id] : undefined;
          if (pageOverride === false) continue;
          const segment = pageOverride?.segment ?? page.segment;
          if (!ACCOUNT_SEGMENT.test(segment) || ACCOUNT_RESERVED_SEGMENTS.has(segment)) {
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
      if (!this.registered.some((e) => e.id === id)) {
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
