/**
 * Contract fixture: structural copies of the extensions payments, agent and media contribute. Each
 * is written against a LOCAL re-declaration of the shapes it uses (as a contributor does, without
 * importing authkit at runtime) and must still be assignable to the published `AccountExtension`.
 * A change to the contract that breaks a contributor fails `typecheck:tests` here.
 */
import { test } from '@japa/runner';
import type { AccountExtension } from '../../src/account/extension.js';
import { AccountExtensionRegistryImpl } from '../../src/account/registry.js';

// ── what a contributor re-declares locally ───────────────────────────────────────────────────────
type LocalText = string | { key: string; params?: Record<string, string | number> };
interface LocalCtx {
  account: { id: string; email: string | null; roles: readonly string[] };
  activeOrg: { id: string; slug: string; role: string } | null;
  subject: { type: string; id: string };
  impersonatedBy: string | null;
  query: { cursor?: string; tab?: string };
  url(pageId: string, query?: Record<string, string>): string;
}
type LocalResult =
  | { ok: true; flash?: LocalText; redirectTo?: { page: string } | { external: string } }
  | { ok: false; error: LocalText; status?: 400 | 403 | 404 | 409 };
interface LocalAction {
  label: LocalText;
  tone?: 'default' | 'danger';
  confirm?: LocalText;
  sudo?: boolean;
  handle(
    ctx: LocalCtx,
    input: { target: string | null; fields: Record<string, string> },
  ): Promise<LocalResult>;
}

const payments = {
  id: 'payments',
  contract: 1,
  scriptOrigins: ['https://js.stripe.com'],
  messages: { en: { 'payments.billing': 'Billing' }, 'pt-BR': { 'payments.billing': 'Cobrança' } },
  pages: [
    {
      id: 'payments.subscription',
      segment: 'billing',
      title: { key: 'payments.billing' },
      nav: { group: 'billing' as const, order: 100 },
      visible: async (ctx: LocalCtx) => ctx.subject.id !== '',
      load: async (ctx: LocalCtx) => ({
        blocks: [
          {
            kind: 'keyValue' as const,
            rows: [
              { label: 'Plan', value: { type: 'money' as const, amount: 1000, currency: 'BRL' } },
            ],
            actions: [{ action: 'cancel', target: ctx.subject.id }],
          },
          {
            kind: 'component' as const,
            provider: 'stripe',
            scripts: [{ src: 'https://js.stripe.com/v3/' }],
            props: { publishableKey: 'pk' },
            submit: { action: 'updateMethod' },
            fallback: { label: 'Update', href: 'https://billing.stripe.com', external: true },
          },
        ],
      }),
      actions: {
        cancel: {
          label: 'Cancel',
          tone: 'danger',
          confirm: 'Sure?',
          sudo: true,
          handle: async () => ({ ok: true }),
        } satisfies LocalAction,
        updateMethod: {
          label: 'Update card',
          sudo: true,
          handle: async () => ({ ok: true, redirectTo: { external: 'https://x.example' } }),
        } satisfies LocalAction,
      },
    },
    {
      id: 'payments.invoices',
      segment: 'invoices',
      title: 'Invoices',
      load: async (ctx: LocalCtx) => ({
        blocks: [
          {
            kind: 'table' as const,
            empty: 'None',
            columns: [{ id: 'amount', label: 'Amount' }],
            rows: [{ cells: { amount: { type: 'money' as const, amount: 1, currency: 'USD' } } }],
            nextCursor: ctx.query.cursor ?? null,
          },
        ],
      }),
    },
  ],
};

const agent = {
  id: 'agent',
  contract: 1,
  pages: [
    {
      id: 'agent.usage',
      segment: 'ai',
      title: 'AI usage',
      nav: { group: 'ai' as const },
      load: async () => ({
        blocks: [
          { kind: 'meter' as const, label: 'Tokens', used: 1, limit: 10, resetsAt: new Date() },
        ],
      }),
    },
    {
      id: 'agent.approvals',
      segment: 'approvals',
      title: 'Approvals',
      nav: { group: 'ai' as const },
      load: async () => ({
        blocks: [
          {
            kind: 'toolPreview' as const,
            title: 'Send email',
            tool: 'send_email',
            args: [{ label: 'to', value: { type: 'text' as const, text: 'a@b.c' } }],
            body: { format: 'json' as const, content: '{}' },
            actions: [
              { action: 'approve', target: 'p1' },
              { action: 'reject', target: 'p1' },
            ],
          },
        ],
      }),
      actions: {
        approve: { label: 'Approve', handle: async () => ({ ok: true }) } satisfies LocalAction,
        reject: {
          label: 'Reject',
          tone: 'danger',
          handle: async () => ({ ok: true }),
        } satisfies LocalAction,
      },
    },
  ],
};

const media = {
  id: 'media',
  contract: 1,
  pages: [
    {
      id: 'media.files',
      segment: 'files',
      title: 'My files',
      nav: { group: 'content' as const },
      load: async () => ({
        tabs: [{ id: 'avatars', label: 'Avatars' }],
        blocks: [
          {
            kind: 'list' as const,
            empty: 'No files',
            items: [
              { title: 'a.png', href: '/media/x', actions: [{ action: 'delete', target: 'm1' }] },
            ],
            nextCursor: null,
          },
        ],
      }),
      actions: {
        delete: {
          label: 'Delete',
          tone: 'danger',
          sudo: true,
          confirm: 'Delete?',
          handle: async () => ({ ok: false, error: 'Not found', status: 404 }),
        } satisfies LocalAction,
      },
    },
  ],
};

const fixtures: AccountExtension[] = [payments, agent, media];

test.group('account extensions | contract fixture', () => {
  test('payments, agent and media shapes register together', ({ assert }) => {
    const registry = new AccountExtensionRegistryImpl();
    for (const fixture of fixtures) registry.register(fixture);
    const pages = registry.freeze({ production: false, builtinSegments: ['security', 'mfa'] });
    assert.deepEqual(
      pages.map((p) => p.segment),
      ['billing', 'invoices', 'ai', 'approvals', 'files'],
    );
  });
});
