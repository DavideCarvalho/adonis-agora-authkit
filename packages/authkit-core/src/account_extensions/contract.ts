/** Account console extensions: the contract every authkit package and contributor shares. */
/**
 * Account console extensions — the surface another package (or the app) uses to add pages to the
 * signed-in user's own console (`/account/*`).
 *
 * **Stable for all of 1.x.** A 1.x release only adds optional members and new block kinds. This
 * module holds types and constants only, so a contributor can `import type` it from an internal
 * module without a runtime dependency on authkit.
 *
 * A contributor registers itself from its provider's `boot()`:
 *
 * ```ts
 * if (this.app.container.hasBinding('authkit.accountExtensions')) {
 *   const registry = await this.app.container.make('authkit.accountExtensions')
 *   if (registry.contract >= 1) registry.register(myAccountExtension)
 * }
 * ```
 *
 * Everything a page returns ({@link AccountPageView}, {@link AccountActionResult}) is plain JSON
 * (dates may be `Date` or ISO strings), so the same page can also be served from another app.
 */

/** The container binding the registry is bound at. */
export const ACCOUNT_EXTENSIONS_BINDING = 'authkit.accountExtensions';

/** The contract major this authkit implements. */
export const ACCOUNT_EXTENSION_CONTRACT = 1;

/** Block kinds this authkit renders. A contributor degrades when one it needs is missing. */
export const ACCOUNT_BLOCK_KINDS = [
  'notice',
  'keyValue',
  'list',
  'table',
  'meter',
  'actions',
  'link',
  'toolPreview',
  'component',
] as const;

/** One of {@link ACCOUNT_BLOCK_KINDS}. */
export type AccountBlockKind = (typeof ACCOUNT_BLOCK_KINDS)[number];

/** A message key (looked up in the merged catalog) or literal text. Always escaped. */
export type Text = string | { key: string; params?: Record<string, string | number> };

/** The active organization (signed cookie), when organizations are on. */
export interface AccountActiveOrg {
  id: string;
  slug: string;
  role: string;
}

/** One level of a tenant chain (outermost first). */
export interface AccountTenantLevel {
  id: string;
  kind: string;
  slug?: string;
  role?: string;
}

/** The tenant of the request, in the shape `@adonis-agora/context` uses. */
export interface AccountTenantRef {
  id: string;
  kind: 'organization' | 'user' | (string & {});
  source: 'authkit' | 'app' | 'carrier' | 'legacy' | (string & {});
  slug?: string;
  role?: string;
  /** The nested chain, outermost first, ending with this tenant. */
  chain?: readonly AccountTenantLevel[];
}

/** Who the account is in the app: what billing, media or agents key their rows on. */
export interface AccountSubject {
  type: string;
  id: string;
}

/** What every `visible`, `load` and action `handle` receives. */
export interface AccountExtensionContext {
  account: { id: string; email: string | null; name: string | null; roles: readonly string[] };
  /** The active org (signed cookie, membership re-checked), when organizations are on. */
  activeOrg: AccountActiveOrg | null;
  /** The tenant of the request: the active organization, when there is one. */
  tenant?: AccountTenantRef | null;
  /**
   * The account mapped to the app's subject by `accountConsole.subject` in `config/authkit.ts`
   * (default `{ type: 'User', id: account.id }`). A lib may still map it its own way.
   */
  subject: AccountSubject;
  /** The admin acting as this account, when an impersonation is active. Sensitive actions refuse it. */
  impersonatedBy: string | null;
  /** The console locale (`'en'`, `'pt-BR'`…). */
  locale: string;
  /** Validated query: `cursor` and `tab` only. */
  query: { cursor?: string; tab?: string };
  /** Same-origin path of a console page (`url('payments.invoices', { cursor })`). */
  url(pageId: string, query?: Record<string, string>): string;
  /** Resolves a container binding. */
  make(binding: string): Promise<any>;
  now(): Date;
}

/** A formatted value. Money is in minor units; dates are `Date` or ISO strings. */
export type Value =
  | { type: 'text'; text: Text }
  | { type: 'money'; amount: number; currency: string }
  | { type: 'date'; at: Date | string; style?: 'date' | 'datetime' | 'relative' }
  | { type: 'badge'; text: Text; tone?: 'neutral' | 'success' | 'warning' | 'danger' }
  | { type: 'number'; value: number; unit?: Text };

/** Points at `page.actions[action]`; `target` is an opaque id the handler MUST re-authorize. */
export interface ActionRef {
  action: string;
  target?: string;
}

/** An item of a `list` block. */
export interface ListItem {
  title: Text;
  subtitle?: Text;
  meta?: Value[];
  badge?: Value;
  /** Same-origin path, or an https URL with `external: true`. */
  href?: string;
  external?: boolean;
  actions?: ActionRef[];
}

/** A script a `component` block loads. */
export interface ComponentScript {
  /** Same-origin path (`/payments/assets/card.js`) or an https URL on one of `scriptOrigins`. */
  src: string;
  /** Subresource integrity (`sha384-…`). */
  integrity?: string;
  /** Load as an ES module. */
  module?: boolean;
}

/** One block of a page. Unknown kinds render as a notice. */
export type Block =
  | { kind: 'notice'; tone: 'info' | 'success' | 'warning' | 'danger'; text: Text }
  | {
      kind: 'keyValue';
      title?: Text;
      rows: ReadonlyArray<{ label: Text; value: Value }>;
      actions?: ActionRef[];
    }
  | {
      kind: 'list';
      title?: Text;
      empty: Text;
      items: ReadonlyArray<ListItem>;
      nextCursor?: string | null;
    }
  | {
      kind: 'table';
      title?: Text;
      empty: Text;
      columns: ReadonlyArray<{ id: string; label: Text }>;
      rows: ReadonlyArray<{ cells: Record<string, Value>; actions?: ActionRef[] }>;
      nextCursor?: string | null;
    }
  | {
      kind: 'meter';
      label: Text;
      used: number;
      limit: number | null;
      unit?: Text;
      resetsAt?: Date | string;
    }
  | { kind: 'actions'; items: ActionRef[] }
  | { kind: 'link'; label: Text; href: string; external?: boolean }
  /**
   * A structured preview of something waiting for a decision (an agent's tool call): its title,
   * the arguments as rows, and an optional body shown verbatim (escaped).
   */
  | {
      kind: 'toolPreview';
      title: Text;
      tool?: string;
      subtitle?: Text;
      args?: ReadonlyArray<{ label: Text; value: Value }>;
      body?: { format: 'json' | 'text'; content: string };
      actions?: ActionRef[];
    }
  /**
   * A provider's own UI (card fields of Stripe Elements, Asaas, Efí, PayPal…). authkit renders
   * the mount point, the props as a JSON data block and the scripts with the request's CSP nonce.
   * The script mounts into `[data-block="component"][data-provider="<provider>"]`, reads its props
   * from the `<script type="application/json">` the mount point names in `data-props`, and submits
   * the mount point's `<form>` (the `submit` action) with the fields it adds. Until it mounts (or
   * when scripts are blocked) the `fallback` link shows.
   */
  | {
      kind: 'component';
      provider: string;
      scripts: ReadonlyArray<ComponentScript>;
      props?: Record<string, unknown>;
      submit?: ActionRef;
      fallback?: { label: Text; href: string; external?: boolean };
    };

/** What `load` returns. */
export interface AccountPageView {
  blocks: readonly Block[];
  /** Tabs inside one page (`query.tab`). */
  tabs?: ReadonlyArray<{ id: string; label: Text }>;
}

/** A field of an action's form. Values arrive validated, as strings. */
export interface AccountActionField {
  name: string;
  label: Text;
  kind: 'text' | 'select' | 'textarea';
  options?: ReadonlyArray<{ value: string; label: Text }>;
  required?: boolean;
  maxLength?: number;
}

/** What an action returns. */
export type AccountActionResult =
  | { ok: true; flash?: Text; redirectTo?: { page: string } | { external: string } }
  | { ok: false; error: Text; status?: 400 | 403 | 404 | 409 };

/** An action a page offers. */
export interface AccountAction {
  label: Text;
  tone?: 'default' | 'danger';
  /** Confirmation text, shown on a second step page (no inline JS). */
  confirm?: Text;
  /** Needs recent re-authentication: authkit sends the user through `/account/confirm` first. */
  sudo?: boolean;
  /** Simple form fields, shown on the confirmation step. */
  fields?: ReadonlyArray<AccountActionField>;
  handle(
    ctx: AccountExtensionContext,
    input: { target: string | null; fields: Record<string, string> },
  ): Promise<AccountActionResult>;
}

/** Where a page sits in the console's navigation. */
export interface AccountPageNav {
  label?: Text;
  order?: number;
  group?: 'account' | 'billing' | 'ai' | 'content';
}

/** One page of an extension. */
export interface AccountPage {
  /** Stable id `<extension>.<page>` (`'payments.subscription'`). */
  id: string;
  /** URL segment under the account prefix (`'billing'` → `/account/billing`). The host can rename it. */
  segment: string;
  title: Text;
  /** `false` hides it from the navigation (still reachable by URL and `url()`). */
  nav?: AccountPageNav | false;
  /** Show this page (and its nav entry) for this account? Default: yes. Runs once per request. */
  visible?(ctx: AccountExtensionContext): boolean | Promise<boolean>;
  /** Builds the page on every GET. */
  load(ctx: AccountExtensionContext): Promise<AccountPageView>;
  actions?: Readonly<Record<string, AccountAction>>;
}

/** An account console extension. */
export interface AccountExtension {
  /** 2–16 of `a-z`, `0-9`, `-`; unique; not a built-in screen. */
  readonly id: string;
  /** The contract major it was written against. authkit skips a higher one. */
  readonly contract: number;
  /** `locale → key → text`; keys start with `<id>.`. The host's `i18n.messages` still win. */
  messages?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** https origins its `component` blocks may load scripts from (`'https://js.stripe.com'`). */
  scriptOrigins?: readonly string[];
  pages: readonly AccountPage[];
}

/** The registry bound at {@link ACCOUNT_EXTENSIONS_BINDING}. */
export interface AccountExtensionRegistry {
  readonly contract: number;
  /** Block kinds this authkit renders. */
  readonly blockKinds: readonly string[];
  register(extension: AccountExtension): void;
}

/** Host controls for one extension (`accountConsole.extensions` in `config/authkit.ts`). */
export type AccountExtensionOverride =
  | false
  | { pages?: Record<string, false | { segment?: string; order?: number }> };
