import type { HttpContext } from '@adonisjs/core/http';
import { accountPath } from '../host/account_paths.js';
import { redirectExact } from '../host/redirect_exact.js';
import { resolveRuntimeSettings } from '../host/runtime_settings.js';
import { isSudoSatisfied } from '../host/sudo_mode.js';
import type { AccountAction, AccountActionResult, Text } from './extension.js';
import type { RegisteredAccountPage } from './registry.js';
import {
  accountExtensionPages,
  buildAccountNav,
  type ConsoleRequest,
  consoleRequest,
  extensionContext,
  findPageById,
  isPageVisible,
  loadResolvedPage,
  logExtensionError,
  pageHref,
  type ResolvedAccountPage,
  resolveAction,
  safeHref,
  translatorFor,
  validatedQuery,
  withTimeout,
} from './runtime.js';

/** Flash key of an action's outcome. */
const FLASH_KEY = 'authkit_account_extension';

/** The confirmation step of an action, as the view renders it. */
export interface ResolvedActionStep {
  action: string;
  title: string;
  text: string | null;
  tone: 'default' | 'danger';
  sudo: boolean;
  /** POST target of the form. */
  href: string;
  target: string | null;
  cancelHref: string;
  submitLabel: string;
  fields: Array<{
    name: string;
    label: string;
    kind: 'text' | 'select' | 'textarea';
    required: boolean;
    maxLength: number | null;
    options: Array<{ value: string; label: string }>;
    value: string;
  }>;
}

/** An action as the JSON API describes it. */
export interface ResolvedActionDefinition {
  label: string;
  tone: 'default' | 'danger';
  confirm: string | null;
  sudo: boolean;
  fields: ResolvedActionStep['fields'];
}

function apiError(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message, ...extra } };
}

function notFound(ctx: HttpContext, json: boolean) {
  if (json) return ctx.response.status(404).send(apiError('not_found', 'Not found.'));
  return ctx.response.status(404).send('Not found');
}

async function requestOr404(
  ctx: HttpContext,
  page: RegisteredAccountPage | undefined,
  json: boolean,
): Promise<{ request: ConsoleRequest; page: RegisteredAccountPage } | null> {
  const request = await consoleRequest(ctx);
  if (!request || !page || !(await isPageVisible(request, page))) {
    notFound(ctx, json);
    return null;
  }
  return { request, page };
}

function actionOf(page: RegisteredAccountPage, name: string): AccountAction | null {
  const actions = page.page.actions ?? {};
  return Object.hasOwn(actions, name) ? (actions[name] ?? null) : null;
}

function resolveFields(
  action: AccountAction,
  t: (text: Text | undefined | null) => string,
  values: Record<string, string> = {},
): ResolvedActionStep['fields'] {
  return (action.fields ?? []).map((field) => ({
    name: field.name,
    label: t(field.label),
    kind: field.kind,
    required: field.required === true,
    maxLength: typeof field.maxLength === 'number' ? field.maxLength : null,
    options: (field.options ?? []).map((o) => ({ value: o.value, label: t(o.label) })),
    value: values[field.name] ?? '',
  }));
}

function definitionOf(
  action: AccountAction,
  t: (text: Text | undefined | null) => string,
): ResolvedActionDefinition {
  return {
    label: t(action.label),
    tone: action.tone === 'danger' ? 'danger' : 'default',
    confirm: action.confirm !== undefined ? t(action.confirm) : null,
    sudo: action.sudo === true,
    fields: resolveFields(action, t),
  };
}

const DEFAULT_MAX_LENGTH = 2000;

/** Validates the posted fields against the action's declaration. */
export function validateActionInput(
  action: AccountAction,
  raw: { target?: unknown; fields?: unknown },
  t: (text: Text | undefined | null) => string,
):
  | { ok: true; target: string | null; fields: Record<string, string> }
  | { ok: false; error: string } {
  const target =
    typeof raw.target === 'string' && raw.target !== '' && raw.target.length <= 512
      ? raw.target
      : null;
  const posted = (raw.fields && typeof raw.fields === 'object' ? raw.fields : {}) as Record<
    string,
    unknown
  >;
  const fields: Record<string, string> = {};
  for (const field of action.fields ?? []) {
    const value = posted[field.name];
    const text = typeof value === 'string' ? value : '';
    const name = t(field.label);
    if (field.required && text.trim() === '') {
      return {
        ok: false,
        error: t({ key: 'account.extension.field_required', params: { field: name } }),
      };
    }
    if (text.length > (field.maxLength ?? DEFAULT_MAX_LENGTH)) {
      return {
        ok: false,
        error: t({ key: 'account.extension.field_too_long', params: { field: name } }),
      };
    }
    if (
      field.kind === 'select' &&
      text !== '' &&
      !(field.options ?? []).some((o) => o.value === text)
    ) {
      return {
        ok: false,
        error: t({ key: 'account.extension.field_invalid', params: { field: name } }),
      };
    }
    fields[field.name] = text;
  }
  return { ok: true, target, fields };
}

/** The page's flash (set by the last action), read once. */
function takeFlash(ctx: HttpContext): { tone: 'success' | 'danger'; text: string } | null {
  try {
    const flash = (ctx.session as any)?.flashMessages?.get(FLASH_KEY);
    if (flash && typeof flash.text === 'string') {
      return { tone: flash.tone === 'danger' ? 'danger' : 'success', text: flash.text };
    }
  } catch {
    /* no session */
  }
  return null;
}

function flash(ctx: HttpContext, tone: 'success' | 'danger', text: string): void {
  try {
    ctx.session.flash(FLASH_KEY, { tone, text });
  } catch {
    /* no session */
  }
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The `<script>` tag of a `component` block's script: the response's CSP nonce when shield set
 * one, `integrity` + `crossorigin` when the block gave one, `type="module"` when asked.
 */
export function componentScriptTag(
  script: { src: string; integrity: string | null; module: boolean },
  nonce: string | null,
): string {
  const attrs = [`src="${escapeAttr(script.src)}"`];
  if (script.module) attrs.push('type="module"');
  else attrs.push('defer');
  if (nonce) attrs.push(`nonce="${escapeAttr(nonce)}"`);
  if (script.integrity) {
    attrs.push(`integrity="${escapeAttr(script.integrity)}"`, 'crossorigin="anonymous"');
  }
  return `<script ${attrs.join(' ')}></script>`;
}

async function render(ctx: HttpContext, request: ConsoleRequest, props: Record<string, unknown>) {
  const render = request.cfg.render as (
    c: HttpContext,
    v: string,
    p: Record<string, unknown>,
  ) => unknown;
  const nonce = cspNonceOf(ctx);
  return render(ctx, 'account/extension', {
    csrfToken: (ctx.request as any).csrfToken ?? '',
    cspNonce: nonce,
    htmlLang: request.locale.toLowerCase(),
    scriptTag: (script: { src: string; integrity: string | null; module: boolean }) =>
      componentScriptTag(script, nonce),
    ...props,
  });
}

/** `GET {prefix}/{segment}` — renders an extension page. */
export async function showPage(ctx: HttpContext, page: RegisteredAccountPage) {
  const found = await requestOr404(ctx, page, false);
  if (!found) return;
  const query = validatedQuery(ctx.request.qs());
  const resolved = await loadResolvedPage(found.request, found.page, query);
  return render(ctx, found.request, {
    page: resolved,
    step: null,
    flash: takeFlash(ctx),
  });
}

/** `GET {prefix}/{segment}/actions/:action/confirm` — the no-JS confirmation step. */
export async function showActionStep(ctx: HttpContext, page: RegisteredAccountPage) {
  const found = await requestOr404(ctx, page, false);
  if (!found) return;
  const name = String(ctx.request.param('action') ?? '');
  const action = actionOf(found.page, name);
  if (!action) return notFound(ctx, false);
  const t = translatorFor(found.request, found.page);
  const target =
    typeof ctx.request.qs().target === 'string' ? (ctx.request.qs().target as string) : null;
  const button = resolveAction(found.page, { action: name, ...(target ? { target } : {}) }, t);
  const step: ResolvedActionStep = {
    action: name,
    title: t(action.label),
    text: action.confirm !== undefined ? t(action.confirm) : null,
    tone: action.tone === 'danger' ? 'danger' : 'default',
    sudo: action.sudo === true,
    href: button ? button.href.replace(/\/confirm(\?.*)?$/, '') : pageHref(found.page),
    target,
    cancelHref: pageHref(found.page),
    submitLabel: t(action.label),
    fields: resolveFields(action, t),
  };
  const resolved: ResolvedAccountPage = {
    id: found.page.page.id,
    extension: found.page.extensionId,
    title: t(found.page.page.title),
    href: pageHref(found.page),
    tabs: [],
    blocks: [],
  };
  return render(ctx, found.request, {
    page: resolved,
    step,
    flash: takeFlash(ctx),
  });
}

/** The CSP nonce shield put on this response, when there is one. */
export function cspNonceOf(ctx: HttpContext): string | null {
  const nonce = (ctx.response as any)?.nonce;
  return typeof nonce === 'string' && nonce !== '' ? nonce : null;
}

interface ActionOutcome {
  status: number;
  body: Record<string, unknown>;
  /** Where an HTML form submission goes next. */
  location: string;
  flash: { tone: 'success' | 'danger'; text: string } | null;
}

async function runAction(
  ctx: HttpContext,
  request: ConsoleRequest,
  page: RegisteredAccountPage,
  name: string,
  raw: { target?: unknown; fields?: unknown },
  json: boolean,
): Promise<ActionOutcome | 'sudo'> {
  const t = translatorFor(request, page);
  const action = actionOf(page, name);
  const back = pageHref(page);
  if (!action) {
    const text = t({ key: 'account.extension.action_not_found' });
    return {
      status: 404,
      body: { ok: false, error: apiError('not_found', text).error },
      location: back,
      flash: { tone: 'danger', text },
    };
  }
  const sensitive = action.sudo === true || action.tone === 'danger';
  if (sensitive && request.base.impersonatedBy !== null) {
    const text = t({ key: 'account.extension.impersonation_refused' });
    return {
      status: 403,
      body: { ok: false, error: apiError('impersonation_refused', text).error },
      location: back,
      flash: { tone: 'danger', text },
    };
  }
  if (action.sudo === true) {
    const settings = await resolveRuntimeSettings(ctx);
    if (!(await isSudoSatisfied(ctx, settings))) return 'sudo';
  }
  const input = validateActionInput(action, raw, t);
  // The step keeps the posted target even when the fields were refused, so the user can fix them.
  const rawTarget =
    typeof raw.target === 'string' && raw.target !== '' && raw.target.length <= 512
      ? raw.target
      : null;
  const button = resolveAction(
    page,
    { action: name, ...(rawTarget ? { target: rawTarget } : {}) },
    t,
  );
  const stepHref = button?.step ? button.href : back;
  if (!input.ok) {
    return {
      status: 422,
      body: { ok: false, error: apiError('invalid_input', input.error).error },
      location: stepHref,
      flash: { tone: 'danger', text: input.error },
    };
  }
  let result: AccountActionResult;
  try {
    result = await withTimeout(
      action.handle(extensionContext(request, {}), { target: input.target, fields: input.fields }),
      request.config.actionTimeoutMs ?? 15_000,
      'handle()',
    );
  } catch (error) {
    logExtensionError(page, `actions.${name}.handle`, error);
    result = { ok: false, error: { key: 'account.extension.action_failed' } };
  }
  const audit = async (
    type: 'account.extension.action' | 'account.extension.redirect',
    extra = {},
  ) => {
    try {
      await request.cfg.audit?.record({
        type,
        accountId: request.base.account.id,
        ip: (ctx.request as any).ip?.() ?? null,
        metadata: { page: page.page.id, action: name, target: input.target, ...extra },
      });
    } catch {
      /* best effort */
    }
  };
  if (sensitive) await audit('account.extension.action', { ok: result?.ok === true });
  if (!result || result.ok !== true) {
    const failure = result as Extract<AccountActionResult, { ok: false }> | undefined;
    const text = t(failure?.error ?? { key: 'account.extension.action_failed' });
    const status = [400, 403, 404, 409].includes(failure?.status ?? 0)
      ? (failure?.status as number)
      : 400;
    return {
      status,
      body: { ok: false, error: apiError('action_failed', text).error },
      location: json ? back : button?.step ? stepHref : back,
      flash: { tone: 'danger', text },
    };
  }
  let location = back;
  let external = false;
  const redirectTo = result.redirectTo;
  if (redirectTo && 'page' in redirectTo) {
    const other = findPageById(redirectTo.page);
    if (other) location = pageHref(other);
  } else if (redirectTo && 'external' in redirectTo) {
    const href = safeHref(redirectTo.external, true);
    if (href) {
      location = href;
      external = true;
      await audit('account.extension.redirect', { url: href });
    }
  }
  const text = t(result.flash ?? { key: 'account.extension.done' });
  return {
    status: 200,
    body: { ok: true, flash: text, redirectTo: location === back ? null : location, external },
    location,
    flash: external ? null : { tone: 'success', text },
  };
}

function sudoUrl(returnTo: string): string {
  return `${accountPath('confirm')}?return_to=${encodeURIComponent(returnTo)}`;
}

/** `POST {prefix}/{segment}/actions/:action` — a form submission (`_csrf` checked by shield). */
export async function postAction(ctx: HttpContext, page: RegisteredAccountPage) {
  const found = await requestOr404(ctx, page, false);
  if (!found) return;
  const name = String(ctx.request.param('action') ?? '');
  const body = ctx.request.body() as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith('field_')) fields[key.slice('field_'.length)] = value;
  }
  const outcome = await runAction(
    ctx,
    found.request,
    found.page,
    name,
    { target: body.target, fields },
    false,
  );
  if (outcome === 'sudo') {
    const t = translatorFor(found.request, found.page);
    const target = typeof body.target === 'string' ? body.target : undefined;
    const button = resolveAction(found.page, { action: name, ...(target ? { target } : {}) }, t);
    return redirectExact(ctx.response, sudoUrl(button?.step ? button.href : pageHref(found.page)));
  }
  if (outcome.flash) flash(ctx, outcome.flash.tone, outcome.flash.text);
  return redirectExact(ctx.response, outcome.location);
}

// ── JSON API ──────────────────────────────────────────────────────────────────────────────────────

/** `GET {prefix}/api/extensions` — the navigation for React hosts. */
export async function apiExtensions(ctx: HttpContext) {
  const nav = await buildAccountNav(ctx, null);
  const ids = new Set(accountExtensionPages().map((p) => p.page.id));
  return ctx.response.send({
    nav,
    pages: nav
      .filter((entry) => ids.has(entry.id))
      .map(({ id, label, href, order, group }) => ({ id, label, href, order, group })),
  });
}

/** `GET {prefix}/api/x/:pageId` — one page, resolved. */
export async function apiPage(ctx: HttpContext) {
  const found = await requestOr404(ctx, findPageById(String(ctx.request.param('pageId'))), true);
  if (!found) return;
  const query = validatedQuery(ctx.request.qs());
  const page = await loadResolvedPage(found.request, found.page, query);
  const t = translatorFor(found.request, found.page);
  const actions: Record<string, ResolvedActionDefinition> = {};
  for (const [name, action] of Object.entries(found.page.page.actions ?? {})) {
    actions[name] = definitionOf(action, t);
  }
  return ctx.response.header('cache-control', 'private, no-store').send({ page, actions });
}

/** `POST {prefix}/api/x/:pageId/actions/:action` — runs an action, answers JSON. */
export async function apiAction(ctx: HttpContext) {
  const found = await requestOr404(ctx, findPageById(String(ctx.request.param('pageId'))), true);
  if (!found) return;
  const name = String(ctx.request.param('action') ?? '');
  const body = ctx.request.body() as Record<string, unknown>;
  const outcome = await runAction(ctx, found.request, found.page, name, body, true);
  if (outcome === 'sudo') {
    // Back to the action's confirmation step (target included) when it has one, like the forms.
    const t = translatorFor(found.request, found.page);
    const target = typeof body.target === 'string' && body.target !== '' ? body.target : undefined;
    const button = resolveAction(found.page, { action: name, ...(target ? { target } : {}) }, t);
    return ctx.response.status(403).send(
      apiError('sudo_required', 'Identity confirmation required.', {
        confirmUrl: sudoUrl(button?.step ? button.href : pageHref(found.page)),
      }),
    );
  }
  return ctx.response.status(outcome.status).send(outcome.body);
}
