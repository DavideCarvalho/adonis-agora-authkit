import type { HttpContext } from '@adonisjs/core/http';
import type { AuthAccount } from '../accounts/account_store.js';
import { joinAccountPath } from '../host/account_paths.js';
import { resolveAccountRoles } from '../host/account_roles.js';
import { ACCOUNT_SESSION_KEY } from '../host/account_session_key.js';
import { readActiveOrgFromHostCtx, verifyActiveOrgMembership } from '../host/active_org_cookie.js';
import { impersonationState } from '../host/impersonation_session.js';
import type {
  AccountAction,
  AccountActiveOrg,
  AccountExtensionContext,
  AccountExtensionOverride,
  AccountPageView,
  AccountSubject,
  AccountTenantRef,
  ActionRef,
  Block,
  ComponentScript,
  ListItem,
  Text,
  Value,
} from './extension.js';
import type { AccountExtensionRegistryImpl, RegisteredAccountPage } from './registry.js';

// ── config ────────────────────────────────────────────────────────────────────────────────────────

/** `accountConsole` in `config/authkit.ts`. */
export interface AccountConsoleConfig {
  /**
   * Maps the signed-in account to the app's subject (what billing, media and agents key on).
   * Default `{ type: 'User', id: account.id }`. Every extension receives it as `ctx.subject`.
   */
  subject?: (
    account: { id: string; email: string | null; name: string | null; roles: readonly string[] },
    context: { activeOrg: AccountActiveOrg | null; tenant: AccountTenantRef | null },
  ) => AccountSubject | Promise<AccountSubject>;
  /** Turn off, rename or reorder extension pages, by extension id. */
  extensions?: Record<string, AccountExtensionOverride>;
  /** Budget of one page's `load()`, in ms. Default 5000. */
  loadTimeoutMs?: number;
}

// ── process state (set when the console routes are mounted) ──────────────────────────────────────

/** Built-in screens in the navigation, with their fixed order. */
export const BUILTIN_NAV = [
  { id: 'security', order: 10, label: 'account.security.title' },
  { id: 'mfa', order: 20, label: 'account.mfa.title' },
  { id: 'tokens', order: 30, label: 'account.tokens.title' },
  { id: 'apps', order: 40, label: 'account.apps.title' },
  { id: 'orgs', order: 50, label: 'account.orgs.title' },
] as const;

export type BuiltinNavId = (typeof BUILTIN_NAV)[number]['id'];

interface ConsoleState {
  pages: readonly RegisteredAccountPage[];
  builtins: Partial<Record<BuiltinNavId, string>>;
  registry: AccountExtensionRegistryImpl | null;
}

let state: ConsoleState = { pages: [], builtins: {}, registry: null };

/** Called by `registerAuthHost` with the mounted screens and the frozen pages. */
export function setAccountConsoleState(next: Partial<ConsoleState>): void {
  state = { ...state, ...next };
}

/** The served extension pages. */
export function accountExtensionPages(): readonly RegisteredAccountPage[] {
  return state.pages;
}

/** Resets the process state (tests). */
export function resetAccountConsoleState(): void {
  state = { pages: [], builtins: {}, registry: null };
}

export function findPageById(pageId: string): RegisteredAccountPage | undefined {
  return state.pages.find((p) => p.page.id === pageId);
}

export function findPageBySegment(segment: string): RegisteredAccountPage | undefined {
  return state.pages.find((p) => p.segment === segment);
}

/** Same-origin path of an extension page. */
export function pageHref(page: RegisteredAccountPage, query?: Record<string, string>): string {
  const base = joinAccountPath(page.segment);
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v !== '')) : null;
  const s = qs?.toString();
  return s ? `${base}?${s}` : base;
}

// ── text ──────────────────────────────────────────────────────────────────────────────────────────

/** Looks up a message: host catalog (overrides win), then the extension's own catalogs. */
export function makeTranslator(
  hostMessages: Record<string, string>,
  locale: string,
  catalogs: readonly (Readonly<Record<string, Readonly<Record<string, string>>>> | undefined)[],
): (text: Text | undefined | null) => string {
  const lookup = (key: string): string => {
    if (typeof hostMessages[key] === 'string') return hostMessages[key] as string;
    for (const catalog of catalogs) {
      const hit = catalog?.[locale]?.[key] ?? catalog?.[locale.split('-')[0] ?? '']?.[key];
      if (typeof hit === 'string') return hit;
    }
    for (const catalog of catalogs) {
      const hit = catalog?.en?.[key];
      if (typeof hit === 'string') return hit;
    }
    return key;
  };
  return (text) => {
    if (text === undefined || text === null) return '';
    if (typeof text === 'string') return text;
    if (typeof text !== 'object' || typeof text.key !== 'string') return '';
    const template = lookup(text.key);
    const params = text.params;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      params[name] === undefined ? match : String(params[name]),
    );
  };
}

// ── values ────────────────────────────────────────────────────────────────────────────────────────

/** A value ready to show: `text` is formatted for the locale. */
export interface ResolvedValue {
  type: Value['type'];
  text: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
  /** ISO timestamp of a date value. */
  iso?: string;
  amount?: number;
  currency?: string;
  value?: number;
}

function fractionDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

function toDate(at: Date | string): Date | null {
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

function relative(date: Date, now: Date, locale: string): string {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return rtf.format(seconds, 'second');
}

export function formatValue(
  value: Value,
  t: (text: Text | undefined) => string,
  locale: string,
  now: Date,
): ResolvedValue {
  try {
    switch (value?.type) {
      case 'text':
        return { type: 'text', text: t(value.text) };
      case 'badge':
        return { type: 'badge', text: t(value.text), tone: value.tone ?? 'neutral' };
      case 'money': {
        const digits = fractionDigits(value.currency);
        const major = value.amount / 10 ** digits;
        return {
          type: 'money',
          text: new Intl.NumberFormat(locale, {
            style: 'currency',
            currency: value.currency,
          }).format(major),
          amount: value.amount,
          currency: value.currency,
        };
      }
      case 'number': {
        const n = new Intl.NumberFormat(locale).format(value.value);
        const unit = value.unit ? t(value.unit) : '';
        return { type: 'number', text: unit ? `${n} ${unit}` : n, value: value.value };
      }
      case 'date': {
        const date = toDate(value.at);
        if (!date) return { type: 'date', text: '' };
        const style = value.style ?? 'date';
        const text =
          style === 'relative'
            ? relative(date, now, locale)
            : new Intl.DateTimeFormat(locale, {
                dateStyle: 'medium',
                ...(style === 'datetime' ? { timeStyle: 'short' } : {}),
              }).format(date);
        return { type: 'date', text, iso: date.toISOString() };
      }
      default:
        return { type: 'text', text: '' };
    }
  } catch {
    return { type: 'text', text: '' };
  }
}

// ── hrefs ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * A safe href: an https URL when `external`, else a same-origin path (`/…`, never `//…` nor
 * `/\…`). Anything else (`javascript:`, `data:`, protocol-relative) is `null`.
 */
export function safeHref(href: unknown, external?: boolean): string | null {
  if (typeof href !== 'string' || href === '') return null;
  if (external) {
    try {
      const url = new URL(href);
      return url.protocol === 'https:' ? url.toString() : null;
    } catch {
      return null;
    }
  }
  if (!href.startsWith('/') || href.startsWith('//') || href.startsWith('/\\')) return null;
  // Whitespace or control characters (code point < 0x20) never belong in a path.
  if ([...href].some((ch) => ch.charCodeAt(0) < 0x20 || /\s/.test(ch))) return null;
  return href;
}

/** A script `src` a component block may load: same-origin, or https on an allowed origin. */
export function safeScriptSrc(src: unknown, origins: readonly string[]): string | null {
  const local = safeHref(src, false);
  if (local) return local;
  if (typeof src !== 'string') return null;
  try {
    const url = new URL(src);
    return url.protocol === 'https:' && origins.includes(url.origin) ? url.toString() : null;
  } catch {
    return null;
  }
}

// ── resolved view (what Edge renders and the JSON API returns) ───────────────────────────────────

/** A button for an {@link ActionRef}. */
export interface ResolvedAction {
  action: string;
  target: string | null;
  label: string;
  tone: 'default' | 'danger';
  sudo: boolean;
  /** `confirm` or `fields`: the button opens the confirmation step (`href`, GET). */
  step: boolean;
  /** POST target (no step) or the confirmation step (step). */
  href: string;
  /** JSON endpoint for this action. */
  apiHref: string;
}

export type ResolvedBlock =
  | { kind: 'notice'; tone: 'info' | 'success' | 'warning' | 'danger'; text: string }
  | {
      kind: 'keyValue';
      title: string | null;
      rows: Array<{ label: string; value: ResolvedValue }>;
      actions: ResolvedAction[];
    }
  | {
      kind: 'list';
      title: string | null;
      empty: string;
      items: Array<{
        title: string;
        subtitle: string | null;
        meta: ResolvedValue[];
        badge: ResolvedValue | null;
        href: string | null;
        external: boolean;
        actions: ResolvedAction[];
      }>;
      nextHref: string | null;
      nextCursor: string | null;
    }
  | {
      kind: 'table';
      title: string | null;
      empty: string;
      columns: Array<{ id: string; label: string }>;
      rows: Array<{ cells: ResolvedValue[]; actions: ResolvedAction[] }>;
      hasActions: boolean;
      nextHref: string | null;
      nextCursor: string | null;
    }
  | {
      kind: 'meter';
      label: string;
      used: number;
      limit: number | null;
      percent: number | null;
      text: string;
      resetsAt: ResolvedValue | null;
    }
  | { kind: 'actions'; items: ResolvedAction[] }
  | { kind: 'link'; label: string; href: string; external: boolean }
  | {
      kind: 'toolPreview';
      title: string;
      tool: string | null;
      subtitle: string | null;
      args: Array<{ label: string; value: ResolvedValue }>;
      body: { format: 'json' | 'text'; content: string } | null;
      actions: ResolvedAction[];
    }
  | {
      kind: 'component';
      provider: string;
      mountId: string;
      scripts: Array<{ src: string; integrity: string | null; module: boolean }>;
      /** The props, serialized for a `<script type="application/json">` (`<` escaped). */
      propsJson: string;
      props: Record<string, unknown>;
      submit: ResolvedAction | null;
      fallback: { label: string; href: string; external: boolean } | null;
    };

export interface ResolvedAccountPage {
  id: string;
  extension: string;
  title: string;
  href: string;
  tabs: Array<{ id: string; label: string; href: string; active: boolean }>;
  blocks: ResolvedBlock[];
}

/** JSON for a `<script type="application/json">`: never closes the tag, never runs. */
export function jsonForDataBlock(value: unknown): string {
  return JSON.stringify(value ?? {})
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export interface ResolveInput {
  page: RegisteredAccountPage;
  view: AccountPageView;
  t: (text: Text | undefined | null) => string;
  locale: string;
  now: Date;
  query: { cursor?: string; tab?: string };
}

function resolveActions(
  input: ResolveInput,
  refs: readonly ActionRef[] | undefined,
): ResolvedAction[] {
  const out: ResolvedAction[] = [];
  for (const ref of refs ?? []) {
    const r = resolveAction(input.page, ref, input.t);
    if (r) out.push(r);
  }
  return out;
}

/** The button for `ref`, or `null` when the page has no such action. */
export function resolveAction(
  page: RegisteredAccountPage,
  ref: ActionRef,
  t: (text: Text | undefined | null) => string,
): ResolvedAction | null {
  const action: AccountAction | undefined = page.page.actions?.[ref?.action];
  if (!action || !Object.hasOwn(page.page.actions ?? {}, ref.action)) return null;
  const target = typeof ref.target === 'string' ? ref.target : null;
  const step = action.confirm !== undefined || (action.fields?.length ?? 0) > 0;
  const base = `${joinAccountPath(page.segment)}/actions/${encodeURIComponent(ref.action)}`;
  const qs = target !== null ? `?target=${encodeURIComponent(target)}` : '';
  return {
    action: ref.action,
    target,
    label: t(action.label),
    tone: action.tone === 'danger' ? 'danger' : 'default',
    sudo: action.sudo === true,
    step,
    href: step ? `${base}/confirm${qs}` : base,
    apiHref: `${joinAccountPath('api')}/x/${encodeURIComponent(page.page.id)}/actions/${encodeURIComponent(ref.action)}`,
  };
}

function nextLink(input: ResolveInput, cursor: string | null | undefined): string | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  return pageHref(input.page, {
    cursor,
    ...(input.query.tab ? { tab: input.query.tab } : {}),
  });
}

let mountCounter = 0;

/** Resolves one block; an unknown or malformed block becomes a warning notice. */
export function resolveBlock(input: ResolveInput, block: Block): ResolvedBlock {
  const { t, locale, now } = input;
  const value = (v: Value) => formatValue(v, t, locale, now);
  const fallback = (why: string): ResolvedBlock => ({ kind: 'notice', tone: 'warning', text: why });
  try {
    switch (block?.kind) {
      case 'notice':
        return {
          kind: 'notice',
          tone: ['info', 'success', 'warning', 'danger'].includes(block.tone) ? block.tone : 'info',
          text: t(block.text),
        };
      case 'keyValue':
        return {
          kind: 'keyValue',
          title: block.title ? t(block.title) : null,
          rows: (block.rows ?? []).map((row) => ({ label: t(row.label), value: value(row.value) })),
          actions: resolveActions(input, block.actions),
        };
      case 'list':
        return {
          kind: 'list',
          title: block.title ? t(block.title) : null,
          empty: t(block.empty),
          items: (block.items ?? []).map((item: ListItem) => ({
            title: t(item.title),
            subtitle: item.subtitle ? t(item.subtitle) : null,
            meta: (item.meta ?? []).map(value),
            badge: item.badge ? value(item.badge) : null,
            href: safeHref(item.href, item.external),
            external: item.external === true,
            actions: resolveActions(input, item.actions),
          })),
          nextHref: nextLink(input, block.nextCursor),
          nextCursor: block.nextCursor ?? null,
        };
      case 'table': {
        const columns = (block.columns ?? []).map((c) => ({ id: c.id, label: t(c.label) }));
        const rows = (block.rows ?? []).map((row) => ({
          cells: columns.map((c) =>
            row.cells?.[c.id]
              ? value(row.cells[c.id] as Value)
              : { type: 'text' as const, text: '' },
          ),
          actions: resolveActions(input, row.actions),
        }));
        return {
          kind: 'table',
          title: block.title ? t(block.title) : null,
          empty: t(block.empty),
          columns,
          rows,
          hasActions: rows.some((r) => r.actions.length > 0),
          nextHref: nextLink(input, block.nextCursor),
          nextCursor: block.nextCursor ?? null,
        };
      }
      case 'meter': {
        const used = Number(block.used) || 0;
        const limit = typeof block.limit === 'number' ? block.limit : null;
        const unit = block.unit ? ` ${t(block.unit)}` : '';
        const fmt = new Intl.NumberFormat(locale);
        return {
          kind: 'meter',
          label: t(block.label),
          used,
          limit,
          percent:
            limit !== null && limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null,
          text:
            limit !== null
              ? `${fmt.format(used)} / ${fmt.format(limit)}${unit}`
              : `${fmt.format(used)}${unit}`,
          resetsAt: block.resetsAt
            ? value({ type: 'date', at: block.resetsAt, style: 'relative' })
            : null,
        };
      }
      case 'actions':
        return { kind: 'actions', items: resolveActions(input, block.items) };
      case 'link': {
        const href = safeHref(block.href, block.external);
        if (!href) return fallback(t({ key: 'account.extension.unsafe_link' }));
        return { kind: 'link', label: t(block.label), href, external: block.external === true };
      }
      case 'toolPreview':
        return {
          kind: 'toolPreview',
          title: t(block.title),
          tool: typeof block.tool === 'string' ? block.tool : null,
          subtitle: block.subtitle ? t(block.subtitle) : null,
          args: (block.args ?? []).map((a) => ({ label: t(a.label), value: value(a.value) })),
          body:
            block.body && typeof block.body.content === 'string'
              ? {
                  format: block.body.format === 'json' ? 'json' : 'text',
                  content: block.body.content,
                }
              : null,
          actions: resolveActions(input, block.actions),
        };
      case 'component': {
        const provider = String(block.provider ?? '');
        if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(provider)) {
          return fallback(t({ key: 'account.extension.unknown_block' }));
        }
        const scripts: Array<{ src: string; integrity: string | null; module: boolean }> = [];
        for (const script of (block.scripts ?? []) as ComponentScript[]) {
          const src = safeScriptSrc(script?.src, input.page.scriptOrigins);
          if (!src) return fallback(t({ key: 'account.extension.unsafe_script' }));
          scripts.push({
            src,
            integrity: typeof script.integrity === 'string' ? script.integrity : null,
            module: script.module === true,
          });
        }
        const fb = block.fallback ? safeHref(block.fallback.href, block.fallback.external) : null;
        mountCounter = (mountCounter + 1) % 1_000_000;
        const props = (block.props ?? {}) as Record<string, unknown>;
        return {
          kind: 'component',
          provider,
          mountId: `authkit-component-${input.page.page.id.replace(/\./g, '-')}-${mountCounter}`,
          scripts,
          propsJson: jsonForDataBlock(props),
          props,
          submit: block.submit ? resolveAction(input.page, block.submit, t) : null,
          fallback:
            fb && block.fallback
              ? {
                  label: t(block.fallback.label),
                  href: fb,
                  external: block.fallback.external === true,
                }
              : null,
        };
      }
      default:
        return fallback(t({ key: 'account.extension.unknown_block' }));
    }
  } catch {
    return fallback(t({ key: 'account.extension.unknown_block' }));
  }
}

export function resolvePageView(input: ResolveInput): ResolvedAccountPage {
  const tabs = (input.view.tabs ?? []).map((tab, index) => ({
    id: tab.id,
    label: input.t(tab.label),
    href: pageHref(input.page, { tab: tab.id }),
    active: input.query.tab ? input.query.tab === tab.id : index === 0,
  }));
  return {
    id: input.page.page.id,
    extension: input.page.extensionId,
    title: input.t(input.page.page.title),
    href: pageHref(input.page),
    tabs,
    blocks: (Array.isArray(input.view.blocks) ? input.view.blocks : []).map((b) =>
      resolveBlock(input, b),
    ),
  };
}

// ── per-request context ──────────────────────────────────────────────────────────────────────────

export interface ConsoleRequest {
  /** The base context (no `query`); each page call gets its own. */
  base: Omit<AccountExtensionContext, 'query'>;
  hostMessages: Record<string, string>;
  locale: string;
  config: AccountConsoleConfig;
  cfg: any;
  /** Memoized `visible()` per page id. */
  visible: Map<string, Promise<boolean>>;
}

const perRequest = new WeakMap<object, Promise<ConsoleRequest | null>>();

function tenantFrom(activeOrg: AccountActiveOrg | null): AccountTenantRef | null {
  if (!activeOrg) return null;
  return {
    id: activeOrg.id,
    kind: 'organization',
    source: 'authkit',
    slug: activeOrg.slug,
    role: activeOrg.role,
  };
}

async function readActiveOrg(ctx: HttpContext, cfg: any, accountId: string) {
  try {
    const claimed = readActiveOrgFromHostCtx(ctx, { appKey: cfg.appKey });
    const verified = await verifyActiveOrgMembership(cfg.accountStore, accountId, claimed);
    return verified ? { id: verified.orgId, slug: verified.orgSlug, role: verified.orgRole } : null;
  } catch {
    return null;
  }
}

/** The console context of this request, built once. `null` without a signed-in account. */
export function consoleRequest(ctx: HttpContext): Promise<ConsoleRequest | null> {
  const key = ctx as unknown as object;
  const existing = perRequest.get(key);
  if (existing) return existing;
  const built = (async (): Promise<ConsoleRequest | null> => {
    const accountId = ctx.session?.get(ACCOUNT_SESSION_KEY) as string | undefined;
    if (!accountId) return null;
    const service = await ctx.containerResolver.make('authkit.server' as never);
    const cfg = (service as any).config;
    const account = (await cfg.accountStore.findById(accountId)) as AuthAccount | null;
    if (!account) return null;
    const roles = await resolveAccountRoles(cfg, account);
    const activeOrg = await readActiveOrg(ctx, cfg, accountId);
    const tenant = tenantFrom(activeOrg);
    const config: AccountConsoleConfig = cfg.accountConsole ?? {};
    const summary = {
      id: String(account.id),
      email: (account as any).email ?? null,
      name: (account as any).name ?? null,
      roles,
    };
    const subject = config.subject
      ? await config.subject(summary, { activeOrg, tenant })
      : { type: 'User', id: summary.id };
    const impersonation = impersonationState(ctx);
    const locale = typeof cfg.locale === 'string' ? cfg.locale : 'en';
    const base: Omit<AccountExtensionContext, 'query'> = {
      account: summary,
      activeOrg,
      tenant,
      subject,
      impersonatedBy: impersonation.active ? (impersonation.impersonatorId ?? 'unknown') : null,
      locale,
      url(pageId, query) {
        const page = findPageById(pageId);
        return page ? pageHref(page, query) : joinAccountPath('');
      },
      make: (binding: string) => ctx.containerResolver.make(binding as never),
      now: () => new Date(),
    };
    return {
      base,
      hostMessages: (cfg.messages ?? {}) as Record<string, string>,
      locale,
      config,
      cfg,
      visible: new Map(),
    };
  })();
  perRequest.set(key, built);
  return built;
}

/** Validated query: `cursor` and `tab` only. */
export function validatedQuery(raw: Record<string, unknown>): { cursor?: string; tab?: string } {
  const out: { cursor?: string; tab?: string } = {};
  const cursor = raw.cursor;
  if (typeof cursor === 'string' && cursor.length > 0 && cursor.length <= 512) out.cursor = cursor;
  const tab = raw.tab;
  if (typeof tab === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(tab)) out.tab = tab;
  return out;
}

export function extensionContext(
  request: ConsoleRequest,
  query: { cursor?: string; tab?: string },
): AccountExtensionContext {
  return { ...request.base, query };
}

/** The translator for one page (its extension's catalogs). */
export function translatorFor(
  request: ConsoleRequest,
  page: RegisteredAccountPage | null,
): (text: Text | undefined | null) => string {
  const registry = state.registry;
  const catalogs = page
    ? [registry?.extensions().find((e) => e.id === page.extensionId)?.messages]
    : (registry?.extensions().map((e) => e.messages) ?? []);
  return makeTranslator(request.hostMessages, request.locale, catalogs);
}

/** `page.visible(ctx)`, once per request; a throw hides the page. */
export function isPageVisible(
  request: ConsoleRequest,
  page: RegisteredAccountPage,
): Promise<boolean> {
  const cached = request.visible.get(page.page.id);
  if (cached) return cached;
  const decided = (async () => {
    if (typeof page.page.visible !== 'function') return true;
    try {
      return (await page.page.visible(extensionContext(request, {}))) !== false;
    } catch (error) {
      logExtensionError(page, 'visible', error);
      return false;
    }
  })();
  request.visible.set(page.page.id, decided);
  return decided;
}

export function logExtensionError(
  page: RegisteredAccountPage,
  where: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `authkit: account extension "${page.extensionId}" page "${page.page.id}" ${where}() failed: ${message}`,
  );
}

/** Runs `fn` with a time budget. */
export async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
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

/** Loads and resolves a page; a throw or timeout becomes a danger notice. */
export async function loadResolvedPage(
  request: ConsoleRequest,
  page: RegisteredAccountPage,
  query: { cursor?: string; tab?: string },
): Promise<ResolvedAccountPage> {
  const t = translatorFor(request, page);
  let view: AccountPageView;
  try {
    view = await withTimeout(
      page.page.load(extensionContext(request, query)),
      request.config.loadTimeoutMs ?? 5000,
      'load()',
    );
  } catch (error) {
    logExtensionError(page, 'load', error);
    view = {
      blocks: [{ kind: 'notice', tone: 'danger', text: { key: 'account.extension.load_failed' } }],
    };
  }
  return resolvePageView({ page, view, t, locale: request.locale, now: request.base.now(), query });
}

// ── navigation ────────────────────────────────────────────────────────────────────────────────────

/** One navigation entry of the account console. */
export interface AccountNavEntry {
  id: string;
  label: string;
  href: string;
  active: boolean;
  group: 'account' | 'billing' | 'ai' | 'content';
  order: number;
}

const GROUP_ORDER = ['account', 'billing', 'ai', 'content'] as const;

/** Mounted built-in screens (id → path). */
export function mountedBuiltins(): Partial<Record<BuiltinNavId, string>> {
  return state.builtins;
}

/**
 * The account console navigation: mounted built-in screens plus the extension pages visible to
 * this account, sorted by `(group, order, id)`.
 */
export async function buildAccountNav(
  ctx: HttpContext,
  activeId: string | null,
): Promise<AccountNavEntry[]> {
  const request = await consoleRequest(ctx).catch(() => null);
  const t = request
    ? translatorFor(request, null)
    : (text: Text | undefined | null) => (typeof text === 'string' ? text : (text?.key ?? ''));
  const host = (key: string) => (request ? (request.hostMessages[key] ?? key) : key);
  const entries: AccountNavEntry[] = [];
  for (const builtin of BUILTIN_NAV) {
    const href = state.builtins[builtin.id];
    if (!href) continue;
    entries.push({
      id: builtin.id,
      label: host(builtin.label),
      href,
      active: activeId === builtin.id,
      group: 'account',
      order: builtin.order,
    });
  }
  if (request) {
    const visible = await Promise.all(state.pages.map((p) => isPageVisible(request, p)));
    state.pages.forEach((page, index) => {
      if (!visible[index] || page.page.nav === false) return;
      const nav = page.page.nav ?? {};
      entries.push({
        id: page.page.id,
        label: t(nav.label ?? page.page.title),
        href: pageHref(page),
        active: activeId === page.page.id,
        group: nav.group ?? 'account',
        order: page.order,
      });
    });
  }
  return entries.sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
      a.order - b.order ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

const NAV_VIEWS: Record<string, BuiltinNavId | 'extension'> = {
  'account/security': 'security',
  'account/mfa': 'mfa',
  'account/tokens': 'tokens',
  'account/apps': 'apps',
  'account/orgs': 'orgs',
  'account/extension': 'extension',
};

/**
 * The `accountNav` prop of an account screen (`null` for other views). Never throws: a broken
 * extension leaves the built-in entries.
 */
export async function accountNavFor(
  ctx: HttpContext,
  view: string,
  props: Record<string, unknown>,
): Promise<AccountNavEntry[] | null> {
  const active = NAV_VIEWS[view];
  if (!active) return null;
  const activeId =
    active === 'extension' ? ((props.page as { id?: string } | undefined)?.id ?? null) : active;
  try {
    return await buildAccountNav(ctx, activeId);
  } catch {
    return [];
  }
}
