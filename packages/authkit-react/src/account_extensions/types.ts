/**
 * Shapes of the account console extensions JSON API (`{prefix}/api/extensions`,
 * `{prefix}/api/x/:pageId`). Texts are already translated and values formatted by the server.
 */

/** A formatted value. */
export interface AccountExtensionValue {
  type: 'text' | 'money' | 'date' | 'badge' | 'number';
  text: string;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
  iso?: string;
  amount?: number;
  currency?: string;
  value?: number;
}

/** A button for one of the page's actions. */
export interface AccountExtensionActionButton {
  action: string;
  target: string | null;
  label: string;
  tone: 'default' | 'danger';
  sudo: boolean;
  /** The action has a confirmation text or fields. */
  step: boolean;
  /** Server-rendered form target or confirmation step (Edge). */
  href: string;
  /** Always the POST target of the action. */
  postHref: string;
  /** JSON endpoint of the action. */
  apiHref: string;
}

export type AccountExtensionBlock =
  | { kind: 'notice'; tone: 'info' | 'success' | 'warning' | 'danger'; text: string }
  | {
      kind: 'keyValue';
      title: string | null;
      rows: Array<{ label: string; value: AccountExtensionValue }>;
      actions: AccountExtensionActionButton[];
    }
  | {
      kind: 'list';
      title: string | null;
      empty: string;
      items: Array<{
        title: string;
        subtitle: string | null;
        meta: AccountExtensionValue[];
        badge: AccountExtensionValue | null;
        href: string | null;
        external: boolean;
        actions: AccountExtensionActionButton[];
      }>;
      nextHref: string | null;
      nextCursor: string | null;
    }
  | {
      kind: 'table';
      title: string | null;
      empty: string;
      columns: Array<{ id: string; label: string }>;
      rows: Array<{ cells: AccountExtensionValue[]; actions: AccountExtensionActionButton[] }>;
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
      resetsAt: AccountExtensionValue | null;
    }
  | { kind: 'actions'; items: AccountExtensionActionButton[] }
  | { kind: 'link'; label: string; href: string; external: boolean }
  | {
      kind: 'toolPreview';
      title: string;
      tool: string | null;
      subtitle: string | null;
      args: Array<{ label: string; value: AccountExtensionValue }>;
      body: { format: 'json' | 'text'; content: string } | null;
      actions: AccountExtensionActionButton[];
    }
  | {
      kind: 'component';
      provider: string;
      mountId: string;
      scripts: Array<{ src: string; integrity: string | null; module: boolean }>;
      propsJson: string;
      props: Record<string, unknown>;
      submit: AccountExtensionActionButton | null;
      fallback: { label: string; href: string; external: boolean } | null;
    };

/** One resolved page. */
export interface AccountExtensionPageView {
  id: string;
  extension: string;
  title: string;
  href: string;
  tabs: Array<{ id: string; label: string; href: string; active: boolean }>;
  blocks: AccountExtensionBlock[];
}

/** A field of an action's form. */
export interface AccountExtensionActionField {
  name: string;
  label: string;
  kind: 'text' | 'select' | 'textarea';
  required: boolean;
  maxLength: number | null;
  options: Array<{ value: string; label: string }>;
  value: string;
}

/** An action, as `GET {prefix}/api/x/:pageId` describes it. */
export interface AccountExtensionActionDefinition {
  label: string;
  tone: 'default' | 'danger';
  confirm: string | null;
  sudo: boolean;
  fields: AccountExtensionActionField[];
}

/** `GET {prefix}/api/x/:pageId`. */
export interface AccountExtensionPageResult {
  page: AccountExtensionPageView;
  actions: Record<string, AccountExtensionActionDefinition>;
}

/** One entry of the account console navigation. */
export interface AccountNavEntry {
  id: string;
  label: string;
  href: string;
  active: boolean;
  group: 'account' | 'billing' | 'ai' | 'content';
  order: number;
}

/** `GET {prefix}/api/extensions`. */
export interface AccountExtensionsResult {
  nav: AccountNavEntry[];
  pages: Array<{
    id: string;
    label: string;
    href: string;
    order: number;
    group: AccountNavEntry['group'];
  }>;
}

/** Body of `POST {prefix}/api/x/:pageId/actions/:action`. */
export interface AccountExtensionActionInput {
  target?: string | null;
  fields?: Record<string, string>;
}

/** Answer of an action. A refused one throws `AuthkitClientError` (`sudo_required`, …). */
export interface AccountExtensionActionResult {
  ok: true;
  flash: string;
  /** Another console page or an https URL to go to (`external`). */
  redirectTo: string | null;
  external: boolean;
}
