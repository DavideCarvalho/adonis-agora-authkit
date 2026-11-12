import { useQuery } from '@tanstack/react-query';
import { type ComponentType, createElement, type ReactNode, useEffect, useState } from 'react';
import type { AuthkitClientError } from '../client/client.js';
import { useAuthkitClient } from '../client/context.js';
import { authkitKeys } from '../queries/keys.js';
import type {
  AccountExtensionActionButton,
  AccountExtensionActionInput,
  AccountExtensionBlock,
  AccountExtensionPageView,
  AccountExtensionsResult,
  AccountExtensionValue,
} from './types.js';

// ── query helpers ────────────────────────────────────────────────────────────────────────────────

/** Query options of the account console navigation (built-in screens + extension pages). */
export function useAccountExtensionsQueryOptions() {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.account.extensions(),
    queryFn: () => client.account.extensions.list(),
  };
}

/** Query options of one extension page (`pageId` like `'payments.subscription'`). */
export function useAccountExtensionPageQueryOptions(
  pageId: string,
  query?: { cursor?: string; tab?: string },
) {
  const client = useAuthkitClient();
  return {
    queryKey: authkitKeys.account.extensionPage(pageId, query),
    queryFn: () => client.account.extensions.page(pageId, query),
  };
}

/** Mutation options that run an action of `pageId`. */
export function useAccountExtensionActionMutationOptions(pageId: string) {
  const client = useAuthkitClient();
  return {
    mutationKey: ['authkit', 'account', 'extensions', pageId, 'action'] as const,
    mutationFn: (input: { action: string } & AccountExtensionActionInput) =>
      client.account.extensions.action(pageId, input.action, {
        target: input.target ?? null,
        fields: input.fields ?? {},
      }),
  };
}

/** The account console navigation and the extension pages (`GET {prefix}/api/extensions`). */
export function useAccountExtensions() {
  return useQuery<AccountExtensionsResult, AuthkitClientError>(useAccountExtensionsQueryOptions());
}

// ── rendering ─────────────────────────────────────────────────────────────────────────────────────

/** What a provider component (`component` block) receives. */
export interface AccountExtensionProviderComponentProps {
  provider: string;
  props: Record<string, unknown>;
  /** The action the provider submits to (its fields go in `input.fields`). */
  submit: AccountExtensionActionButton | null;
  /** Runs `submit` (when an `onAction` handler was given to the page). */
  onSubmit?: (input: AccountExtensionActionInput) => void;
}

export interface AccountExtensionPageProps {
  /** The page (`useAccountExtensionPageQueryOptions(...).data.page`, or the Inertia prop `page`). */
  view: AccountExtensionPageView;
  /**
   * Runs an action button. Without it, buttons are plain forms posting to the server-rendered
   * routes (`csrfToken` is required then) and confirmation steps are links.
   */
  onAction?: (button: AccountExtensionActionButton, input?: AccountExtensionActionInput) => void;
  /** CSRF token for the plain forms (Inertia: the `csrfToken` prop). */
  csrfToken?: string;
  /**
   * Loads the React component of a provider (`'stripe'`, `'asaas'`…) for `component` blocks.
   * Without it (or when it returns `null`), the block shows its fallback link.
   */
  loadComponent?: (
    provider: string,
  ) =>
    | ComponentType<AccountExtensionProviderComponentProps>
    | null
    | Promise<ComponentType<AccountExtensionProviderComponentProps> | null>;
  /** Text of the "next page" links. */
  nextLabel?: string;
  className?: string;
}

const e = createElement;

function Value({ value }: { value: AccountExtensionValue }) {
  if (value.type === 'date' && value.iso) {
    return e('time', { dateTime: value.iso, 'data-value': 'date' }, value.text);
  }
  return e(
    'span',
    {
      'data-value': value.type,
      ...(value.type === 'badge' ? { 'data-tone': value.tone ?? 'neutral' } : {}),
    },
    value.text,
  );
}

function ActionButtons({
  actions,
  onAction,
  csrfToken,
}: {
  actions: AccountExtensionActionButton[];
  onAction: AccountExtensionPageProps['onAction'];
  csrfToken: string | undefined;
}) {
  if (actions.length === 0) return null;
  return e(
    'span',
    { 'data-actions': '' },
    actions.map((button) => {
      const key = `${button.action}:${button.target ?? ''}`;
      const common = { 'data-action': button.action, 'data-tone': button.tone };
      if (onAction) {
        return e(
          'button',
          { key, type: 'button', ...common, onClick: () => onAction(button) },
          button.label,
        );
      }
      if (button.step) return e('a', { key, href: button.href, ...common }, button.label);
      return e(
        'form',
        { key, method: 'post', action: button.href },
        e('input', { type: 'hidden', name: '_csrf', value: csrfToken ?? '' }),
        button.target !== null
          ? e('input', { type: 'hidden', name: 'target', value: button.target })
          : null,
        e('button', { type: 'submit', ...common }, button.label),
      );
    }),
  );
}

function ProviderComponent({
  block,
  loadComponent,
  onAction,
}: {
  block: Extract<AccountExtensionBlock, { kind: 'component' }>;
  loadComponent: AccountExtensionPageProps['loadComponent'];
  onAction: AccountExtensionPageProps['onAction'];
}) {
  const [Loaded, setLoaded] =
    useState<ComponentType<AccountExtensionProviderComponentProps> | null>(null);
  useEffect(() => {
    let alive = true;
    if (!loadComponent) return;
    Promise.resolve(loadComponent(block.provider))
      .then((component) => {
        if (alive && component) setLoaded(() => component);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [block.provider, loadComponent]);
  const fallback = block.fallback
    ? e(
        'a',
        {
          href: block.fallback.href,
          'data-component-fallback': '',
          ...(block.fallback.external ? { rel: 'noopener' } : {}),
        },
        block.fallback.label,
      )
    : null;
  return e(
    'div',
    { 'data-block': 'component', 'data-provider': block.provider },
    Loaded
      ? e(Loaded, {
          provider: block.provider,
          props: block.props,
          submit: block.submit,
          ...(onAction && block.submit
            ? {
                onSubmit: (input: AccountExtensionActionInput) =>
                  onAction(block.submit as AccountExtensionActionButton, input),
              }
            : {}),
        })
      : fallback,
  );
}

function Block({
  block,
  props,
}: {
  block: AccountExtensionBlock;
  props: AccountExtensionPageProps;
}): ReactNode {
  const actions = (list: AccountExtensionActionButton[]) =>
    e(ActionButtons, { actions: list, onAction: props.onAction, csrfToken: props.csrfToken });
  const next = (href: string | null) =>
    href ? e('a', { href, rel: 'next', 'data-next': '' }, props.nextLabel ?? 'Next page') : null;
  switch (block.kind) {
    case 'notice':
      return e(
        'div',
        { 'data-block': 'notice', 'data-tone': block.tone, role: 'status' },
        block.text,
      );
    case 'keyValue':
      return e(
        'section',
        { 'data-block': 'keyValue' },
        block.title ? e('h2', null, block.title) : null,
        e(
          'dl',
          null,
          block.rows.map((row, i) =>
            e(
              'div',
              { key: i },
              e('dt', null, row.label),
              e('dd', null, e(Value, { value: row.value })),
            ),
          ),
        ),
        actions(block.actions),
      );
    case 'list':
      return e(
        'section',
        { 'data-block': 'list' },
        block.title ? e('h2', null, block.title) : null,
        block.items.length === 0
          ? e('p', { 'data-empty': '' }, block.empty)
          : e(
              'ul',
              null,
              block.items.map((item, i) =>
                e(
                  'li',
                  { key: i },
                  item.href
                    ? e(
                        'a',
                        {
                          href: item.href,
                          ...(item.external ? { rel: 'noopener', target: '_blank' } : {}),
                        },
                        item.title,
                      )
                    : e('span', null, item.title),
                  item.subtitle ? e('small', null, item.subtitle) : null,
                  item.meta.map((value, j) => e(Value, { key: j, value })),
                  item.badge ? e(Value, { value: item.badge }) : null,
                  actions(item.actions),
                ),
              ),
            ),
        next(block.nextHref),
      );
    case 'table':
      return e(
        'section',
        { 'data-block': 'table' },
        block.title ? e('h2', null, block.title) : null,
        block.rows.length === 0
          ? e('p', { 'data-empty': '' }, block.empty)
          : e(
              'table',
              null,
              e(
                'thead',
                null,
                e(
                  'tr',
                  null,
                  block.columns.map((c) => e('th', { key: c.id, scope: 'col' }, c.label)),
                  block.hasActions ? e('th', { scope: 'col' }) : null,
                ),
              ),
              e(
                'tbody',
                null,
                block.rows.map((row, i) =>
                  e(
                    'tr',
                    { key: i },
                    row.cells.map((value, j) => e('td', { key: j }, e(Value, { value }))),
                    block.hasActions ? e('td', null, actions(row.actions)) : null,
                  ),
                ),
              ),
            ),
        next(block.nextHref),
      );
    case 'meter':
      return e(
        'section',
        { 'data-block': 'meter' },
        e('span', null, block.label),
        e('span', null, block.text),
        block.percent !== null ? e('progress', { max: 100, value: block.percent }) : null,
        block.resetsAt ? e(Value, { value: block.resetsAt }) : null,
      );
    case 'actions':
      return e('div', { 'data-block': 'actions' }, actions(block.items));
    case 'link':
      return e(
        'a',
        {
          'data-block': 'link',
          href: block.href,
          ...(block.external ? { rel: 'noopener', target: '_blank' } : {}),
        },
        block.label,
      );
    case 'toolPreview':
      return e(
        'section',
        { 'data-block': 'toolPreview' },
        e('h2', null, block.title),
        block.tool ? e('code', null, block.tool) : null,
        block.subtitle ? e('small', null, block.subtitle) : null,
        block.args.length > 0
          ? e(
              'dl',
              null,
              block.args.map((arg, i) =>
                e(
                  'div',
                  { key: i },
                  e('dt', null, arg.label),
                  e('dd', null, e(Value, { value: arg.value })),
                ),
              ),
            )
          : null,
        block.body ? e('pre', { 'data-format': block.body.format }, block.body.content) : null,
        actions(block.actions),
      );
    case 'component':
      return e(ProviderComponent, {
        block,
        loadComponent: props.loadComponent,
        onAction: props.onAction,
      });
    default:
      return null;
  }
}

/**
 * Renders an account console extension page from its resolved view: unstyled elements carrying
 * `data-block` / `data-value` / `data-action` attributes for the host's CSS.
 */
export function AccountExtensionPage(props: AccountExtensionPageProps) {
  const { view } = props;
  return e(
    'div',
    { className: props.className, 'data-account-extension': view.id },
    view.tabs.length > 0
      ? e(
          'nav',
          { role: 'tablist', 'data-block': 'tabs' },
          view.tabs.map((tab) =>
            e(
              'a',
              { key: tab.id, href: tab.href, role: 'tab', 'aria-selected': tab.active },
              tab.label,
            ),
          ),
        )
      : null,
    view.blocks.map((block, i) => e(Block, { key: i, block, props })),
  );
}
