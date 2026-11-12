import { createHash } from 'node:crypto';
import type {
  AccountActionField,
  AccountActionResult,
  AccountActiveOrg,
  AccountExtension,
  AccountExtensionContext,
  AccountPageNav,
  AccountPageView,
  AccountSubject,
  AccountTenantLevel,
  AccountTenantRef,
  Text,
} from './contract.js';

/**
 * Remote account extensions: the wire between an authkit IdP (which renders the account console)
 * and an app that signs in through it (which owns the extensions: billing, files, agents…).
 *
 * The app serves `GET {WELL_KNOWN}` (the manifest) and `POST {WELL_KNOWN}` (one call: visible,
 * load or action). The IdP calls both with a short-lived JWT it signs with its own keys:
 * `typ` {@link ACCOUNT_EXTENSIONS_TOKEN_TYP}, `aud` = the app's client id, `scope`
 * {@link ACCOUNT_EXTENSIONS_SCOPE}, `sub` = the account (or {@link ACCOUNT_EXTENSIONS_MANIFEST_SUBJECT}
 * for the manifest) and `bh` = {@link accountExtensionsBodyHash} of the POST body.
 */

/** Wire version of the manifest and calls. */
export const ACCOUNT_EXTENSIONS_WIRE_VERSION = 1;
/** The scope every remote-extension token carries. */
export const ACCOUNT_EXTENSIONS_SCOPE = 'authkit:account-extensions';
/** The JWT `typ` of a remote-extension token (never accepted as an access token elsewhere). */
export const ACCOUNT_EXTENSIONS_TOKEN_TYP = 'agora-account-ext+jwt';
/** Path the app serves the manifest (GET) and the calls (POST) at. */
export const ACCOUNT_EXTENSIONS_WELL_KNOWN = '/.well-known/agora-account-extensions';
/** `sub` of the token that fetches the manifest (no account involved). */
export const ACCOUNT_EXTENSIONS_MANIFEST_SUBJECT = 'authkit:account-console';
/** Longest lifetime (seconds) a remote-extension token may have. */
export const ACCOUNT_EXTENSIONS_TOKEN_MAX_TTL = 300;

/** One action, as the manifest describes it (the handler stays in the app). */
export interface RemoteActionManifest {
  label: Text;
  tone: 'default' | 'danger';
  confirm: Text | null;
  sudo: boolean;
  fields: AccountActionField[];
}

/** One page, as the manifest describes it. */
export interface RemotePageManifest {
  id: string;
  segment: string;
  title: Text;
  nav: AccountPageNav | false;
  /** The page has a `visible()`: the IdP asks before showing it. */
  conditional: boolean;
  actions: Record<string, RemoteActionManifest>;
}

/** One extension, as the manifest describes it. */
export interface RemoteExtensionManifest {
  id: string;
  contract: number;
  messages: Record<string, Record<string, string>>;
  scriptOrigins: string[];
  pages: RemotePageManifest[];
}

/** What `GET {WELL_KNOWN}` answers. */
export interface AccountExtensionsManifest {
  version: 1;
  contract: number;
  extensions: RemoteExtensionManifest[];
}

/** The signed-in account, as the IdP sends it. */
export interface RemoteAccount {
  id: string;
  email: string | null;
  name: string | null;
  roles: string[];
}

interface RemoteCallBase {
  account: RemoteAccount;
  activeOrg: AccountActiveOrg | null;
  tenant: AccountTenantRef | null;
  impersonatedBy: string | null;
  locale: string;
  /** IdP paths of this app's pages (`pageId → /account/billing`), for `ctx.url()`. */
  urls: Record<string, string>;
}

/** The body of `POST {WELL_KNOWN}`. */
export type RemoteCall =
  | (RemoteCallBase & { op: 'visible'; pageIds: string[] })
  | (RemoteCallBase & {
      op: 'load';
      pageId: string;
      query: { cursor?: string; tab?: string };
    })
  | (RemoteCallBase & {
      op: 'action';
      pageId: string;
      action: string;
      query: { cursor?: string; tab?: string };
      input: { target: string | null; fields: Record<string, string> };
    });

/** What a call answers (status 200), or an `error` with another status. */
export type RemoteCallResponse =
  | { visible: string[] }
  | { view: AccountPageView }
  | { result: AccountActionResult }
  | { error: { code: string; message: string } };

/** `bh` claim: base64url SHA-256 of the exact POST body. */
export function accountExtensionsBodyHash(body: string): string {
  return createHash('sha256').update(body).digest('base64url');
}

/** The manifest of these extensions. */
export function buildAccountExtensionsManifest(
  extensions: readonly AccountExtension[],
  contract: number,
): AccountExtensionsManifest {
  return {
    version: ACCOUNT_EXTENSIONS_WIRE_VERSION,
    contract,
    extensions: extensions.map((extension) => ({
      id: extension.id,
      contract: extension.contract,
      messages: Object.fromEntries(
        Object.entries(extension.messages ?? {}).map(([locale, catalog]) => [
          locale,
          { ...catalog },
        ]),
      ),
      scriptOrigins: [...(extension.scriptOrigins ?? [])],
      pages: extension.pages.map((page) => ({
        id: page.id,
        segment: page.segment,
        title: page.title,
        nav: page.nav === false ? false : { ...(page.nav ?? {}) },
        conditional: typeof page.visible === 'function',
        actions: Object.fromEntries(
          Object.entries(page.actions ?? {}).map(([name, action]) => [
            name,
            {
              label: action.label,
              tone: action.tone === 'danger' ? 'danger' : 'default',
              confirm: action.confirm ?? null,
              sudo: action.sudo === true,
              fields: (action.fields ?? []).map((field) => ({ ...field })),
            },
          ]),
        ),
      })),
    })),
  };
}

// ── parsing a call ────────────────────────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 512): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
const strOrNull = (v: unknown, max = 512): string | null => (v === null ? null : str(v, max));

function parseQuery(raw: unknown): { cursor?: string; tab?: string } {
  const out: { cursor?: string; tab?: string } = {};
  if (!isObject(raw)) return out;
  const cursor = str(raw.cursor);
  if (cursor) out.cursor = cursor;
  const tab = raw.tab;
  if (typeof tab === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(tab)) out.tab = tab;
  return out;
}

function parseOrg(raw: unknown): AccountActiveOrg | null {
  if (!isObject(raw)) return null;
  const id = str(raw.id);
  if (!id) return null;
  return { id, slug: String(raw.slug ?? ''), role: String(raw.role ?? '') };
}

function parseTenant(raw: unknown): AccountTenantRef | null {
  if (!isObject(raw)) return null;
  const id = str(raw.id);
  const kind = str(raw.kind, 64);
  if (!id || !kind) return null;
  const tenant: AccountTenantRef = { id, kind, source: str(raw.source, 64) ?? 'authkit' };
  const slug = str(raw.slug);
  if (slug) tenant.slug = slug;
  const role = str(raw.role, 128);
  if (role) tenant.role = role;
  if (Array.isArray(raw.chain)) {
    tenant.chain = raw.chain.filter(isObject).flatMap((level) => {
      const levelId = str(level.id);
      const levelKind = str(level.kind, 64);
      if (!levelId || !levelKind) return [];
      const out: AccountTenantLevel = { id: levelId, kind: levelKind };
      const levelSlug = str(level.slug);
      if (levelSlug) out.slug = levelSlug;
      const levelRole = str(level.role, 128);
      if (levelRole) out.role = levelRole;
      return [out];
    });
  }
  return tenant;
}

/** Validates a call body; `null` when it is malformed. */
export function parseAccountExtensionCall(raw: unknown): RemoteCall | null {
  if (!isObject(raw) || !isObject(raw.account)) return null;
  const accountId = str(raw.account.id);
  if (!accountId) return null;
  const roles = Array.isArray(raw.account.roles)
    ? raw.account.roles.filter((r): r is string => typeof r === 'string')
    : [];
  const urls: Record<string, string> = {};
  if (isObject(raw.urls)) {
    for (const [pageId, path] of Object.entries(raw.urls)) {
      if (typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')) {
        urls[pageId] = path;
      }
    }
  }
  const base: RemoteCallBase = {
    account: {
      id: accountId,
      email: strOrNull(raw.account.email ?? null),
      name: strOrNull(raw.account.name ?? null),
      roles,
    },
    activeOrg: parseOrg(raw.activeOrg),
    tenant: parseTenant(raw.tenant),
    impersonatedBy: strOrNull(raw.impersonatedBy ?? null),
    locale: str(raw.locale, 35) ?? 'en',
    urls,
  };
  if (raw.op === 'visible') {
    const pageIds = Array.isArray(raw.pageIds)
      ? raw.pageIds.filter((id): id is string => typeof id === 'string').slice(0, 100)
      : [];
    return { ...base, op: 'visible', pageIds };
  }
  const pageId = str(raw.pageId, 128);
  if (!pageId) return null;
  if (raw.op === 'load') return { ...base, op: 'load', pageId, query: parseQuery(raw.query) };
  if (raw.op === 'action') {
    const action = str(raw.action, 64);
    if (!action || !isObject(raw.input)) return null;
    const fields: Record<string, string> = {};
    if (isObject(raw.input.fields)) {
      for (const [name, value] of Object.entries(raw.input.fields)) {
        if (typeof value === 'string' && value.length <= 10_000) fields[name] = value;
      }
    }
    return {
      ...base,
      op: 'action',
      pageId,
      action,
      query: parseQuery(raw.query),
      input: { target: strOrNull(raw.input.target ?? null), fields },
    };
  }
  return null;
}

// ── running a call (the app side) ─────────────────────────────────────────────────────────────────

export interface RunAccountExtensionCallOptions {
  /** Maps the account to the app's subject. Default `{ type: 'User', id: account.id }`. */
  subject?: (
    account: RemoteAccount,
    context: { activeOrg: AccountActiveOrg | null; tenant: AccountTenantRef | null },
  ) => AccountSubject | Promise<AccountSubject>;
  /** Resolves a container binding for the extensions. */
  make: (binding: string) => Promise<any>;
  loadTimeoutMs?: number;
  actionTimeoutMs?: number;
  now?: () => Date;
  /** Where a throwing extension is reported (never sent to the IdP). */
  log?: (message: string) => void;
}

async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const err = (status: number, code: string, message: string) => ({
  status,
  body: { error: { code, message } } as RemoteCallResponse,
});

/**
 * Runs one call against the app's extensions with the same rules as in the IdP's own process:
 * time budgets, declared action fields only, and a failure that stays inside the page.
 */
export async function runAccountExtensionCall(
  extensions: readonly AccountExtension[],
  call: RemoteCall,
  options: RunAccountExtensionCallOptions,
): Promise<{ status: number; body: RemoteCallResponse }> {
  const log = options.log ?? ((message: string) => console.error(message));
  const subject = options.subject
    ? await options.subject(call.account, { activeOrg: call.activeOrg, tenant: call.tenant })
    : { type: 'User', id: call.account.id };
  const base: Omit<AccountExtensionContext, 'query'> = {
    account: call.account,
    activeOrg: call.activeOrg,
    tenant: call.tenant,
    subject,
    impersonatedBy: call.impersonatedBy,
    locale: call.locale,
    url(pageId, query) {
      const path = call.urls[pageId] ?? '/';
      const qs = query
        ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '')).toString()
        : '';
      return qs ? `${path}?${qs}` : path;
    },
    make: options.make,
    now: options.now ?? (() => new Date()),
  };
  const pages = new Map(extensions.flatMap((e) => e.pages.map((p) => [p.id, p] as const)));

  if (call.op === 'visible') {
    const visible: string[] = [];
    await Promise.all(
      call.pageIds.map(async (pageId) => {
        const page = pages.get(pageId);
        if (!page) return;
        if (typeof page.visible !== 'function') {
          visible.push(pageId);
          return;
        }
        try {
          const shown = await within(
            Promise.resolve(page.visible({ ...base, query: {} })),
            options.loadTimeoutMs ?? 5000,
            'visible()',
          );
          if (shown !== false) visible.push(pageId);
        } catch (error) {
          log(`authkit: account extension page "${pageId}" visible() failed: ${String(error)}`);
        }
      }),
    );
    return { status: 200, body: { visible: visible.sort() } };
  }

  const page = pages.get(call.pageId);
  if (!page) return err(404, 'not_found', 'No such page.');
  const ctx: AccountExtensionContext = { ...base, query: call.query };

  if (call.op === 'load') {
    try {
      const view = await within(page.load(ctx), options.loadTimeoutMs ?? 5000, 'load()');
      if (!view || typeof view !== 'object' || !Array.isArray(view.blocks)) {
        throw new Error('load() must return { blocks: [...] }');
      }
      return { status: 200, body: { view } };
    } catch (error) {
      log(`authkit: account extension page "${call.pageId}" load() failed: ${String(error)}`);
      return err(502, 'load_failed', 'The page could not be loaded.');
    }
  }

  const actions = page.actions ?? {};
  const action = Object.hasOwn(actions, call.action) ? actions[call.action] : undefined;
  if (!action) return err(404, 'not_found', 'No such action.');
  const fields: Record<string, string> = {};
  for (const field of action.fields ?? []) {
    const value = call.input.fields[field.name];
    if (typeof value === 'string') fields[field.name] = value;
  }
  try {
    const result = await within(
      action.handle(ctx, { target: call.input.target, fields }),
      options.actionTimeoutMs ?? 15_000,
      'handle()',
    );
    if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean') {
      throw new Error('handle() must return { ok: true | false, … }');
    }
    return { status: 200, body: { result } };
  } catch (error) {
    log(
      `authkit: account extension action "${call.pageId}.${call.action}" failed: ${String(error)}`,
    );
    return err(502, 'action_failed', 'The action failed.');
  }
}
