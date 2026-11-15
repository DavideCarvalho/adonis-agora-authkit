/**
 * Receives authkit-server's signed event webhook on another server and re-emits each
 * event on the local `@adonis-agora/diagnostics` bus as `agora:authkit:<type>`, with the
 * same payload authkit-server emits in-process. Listeners such as authz provisioning
 * (`onDiagnostic('authkit', 'organization.created', ...)`) then work unchanged when
 * authkit runs elsewhere.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { HttpContext, Router } from '@adonisjs/core/http';

/** The event as authkit-server's webhook sends it (the signed JSON body). */
export interface AuthkitWebhookEvent {
  /** Unique per event; a repeated id is ignored. */
  id: string;
  /** The audit event type, e.g. `organization.created`, `member.added`. */
  type: string;
  accountId: string | null;
  actorId: string | null;
  email: string | null;
  clientId: string | null;
  orgId: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  /** When authkit dispatched it (ISO 8601). */
  ts: string;
}

/** What is emitted on the diagnostics bus: authkit-server's in-process payload (no PII). */
export interface AuthkitDiagnosticPayload {
  type: string;
  accountId: string | null;
  actorId: string | null;
  clientId: string | null;
  orgId: string | null;
}

/** Remembers delivered ids for replay protection. */
export interface WebhookReplayStore {
  /**
   * Records `id` for `ttlMs`. Returns `false` when it was already recorded (a replay).
   * Shared stores (Redis `SET NX PX`) protect every instance of the app.
   */
  claim(id: string, ttlMs: number): boolean | Promise<boolean>;
}

export interface AuthkitWebhookOptions {
  /** The secret configured in authkit-server's `events.webhook.secret`. */
  secret: string;
  /** Accept events whose `ts` is at most this many seconds away from now. Default: 300. */
  toleranceSec?: number;
  /** Where delivered ids are remembered. Default: in memory, per process. */
  replayStore?: WebhookReplayStore;
  /** Also receive the full event (with `email`, `ip`, `metadata`). Runs before the bus emit. */
  onEvent?: (event: AuthkitWebhookEvent) => void | Promise<void>;
  /** Re-emit on the diagnostics bus. Default: `true`. */
  emit?: boolean;
}

/** Why a delivery was refused. */
export type WebhookRejection = 'signature' | 'malformed' | 'expired' | 'replay';

/** The verdict of {@link verifyAuthkitWebhook}. */
export type WebhookVerification =
  | { ok: true; event: AuthkitWebhookEvent }
  | { ok: false; reason: WebhookRejection };

/** In-memory replay store: ids live for their TTL, at most `max` at a time. */
export function memoryReplayStore(max = 10_000): WebhookReplayStore {
  const seen = new Map<string, number>();
  return {
    claim(id, ttlMs) {
      const now = Date.now();
      const expiresAt = seen.get(id);
      if (expiresAt !== undefined && expiresAt > now) return false;
      seen.delete(id);
      seen.set(id, now + ttlMs);
      if (seen.size > max) {
        for (const [key, exp] of seen) {
          if (exp <= now || seen.size > max) seen.delete(key);
          else break;
        }
      }
      return true;
    },
  };
}

function validSignature(body: string, header: string | undefined | null, secret: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('hex'));
  const given = Buffer.from(header.slice('sha256='.length));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/**
 * Checks one delivery: the `x-authkit-signature` HMAC over the raw body, the shape, the
 * `ts` window and the `id` (each id is accepted once). Pure apart from the replay store.
 */
export async function verifyAuthkitWebhook(
  input: { body: string; signature: string | undefined | null },
  options: Pick<AuthkitWebhookOptions, 'secret' | 'toleranceSec'> & {
    replayStore: WebhookReplayStore;
  },
): Promise<WebhookVerification> {
  if (!validSignature(input.body, input.signature, options.secret)) {
    return { ok: false, reason: 'signature' };
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(input.body) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const id = str(raw?.id);
  const type = str(raw?.type);
  const ts = str(raw?.ts);
  if (!id || !type || !ts) return { ok: false, reason: 'malformed' };
  const at = Date.parse(ts);
  if (Number.isNaN(at)) return { ok: false, reason: 'malformed' };
  const toleranceMs = (options.toleranceSec ?? 300) * 1000;
  if (Math.abs(Date.now() - at) > toleranceMs) return { ok: false, reason: 'expired' };
  // Remember the id for as long as its `ts` stays acceptable.
  if (!(await options.replayStore.claim(id, toleranceMs * 2))) {
    return { ok: false, reason: 'replay' };
  }
  const metadata =
    raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
      ? (raw.metadata as Record<string, unknown>)
      : {};
  return {
    ok: true,
    event: {
      id,
      type,
      accountId: str(raw.accountId),
      actorId: str(raw.actorId),
      email: str(raw.email),
      clientId: str(raw.clientId),
      orgId: str(raw.orgId),
      ip: str(raw.ip),
      metadata,
      ts,
    },
  };
}

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
type EmitFn = (lib: string, event: string, payload: unknown) => void;

/**
 * Emits `event` on the diagnostics bus as `agora:authkit:<type>` with authkit-server's
 * redacted payload (`type`, `accountId`, `actorId`, `clientId`, `orgId`). No-op without
 * `@adonis-agora/diagnostics`.
 */
export function emitAuthkitEvent(event: AuthkitWebhookEvent): void {
  try {
    const emit = (globalThis as Record<symbol, unknown>)[EMIT_SLOT] as EmitFn | undefined;
    emit?.('authkit', event.type, {
      type: event.type,
      accountId: event.accountId,
      actorId: event.actorId,
      clientId: event.clientId,
      orgId: event.orgId,
    } satisfies AuthkitDiagnosticPayload);
  } catch {
    // best effort
  }
}

/**
 * The route handler for authkit-server's webhook. Answers `204` for an accepted (or
 * replayed) delivery, `401` for a bad signature, `400` for a malformed or expired one.
 * Needs the raw body: keep the route under the JSON body parser (the default) and out of
 * CSRF (shield's `csrf.exceptRoutes`).
 */
export function authkitWebhookHandler(options: AuthkitWebhookOptions) {
  if (!options?.secret) throw new TypeError('authkitWebhookHandler: secret is required');
  const replayStore = options.replayStore ?? memoryReplayStore();
  return async (ctx: HttpContext): Promise<unknown> => {
    const body = ctx.request.raw();
    if (typeof body !== 'string' || !body) {
      return ctx.response.badRequest({ error: 'malformed' });
    }
    const verdict = await verifyAuthkitWebhook(
      { body, signature: ctx.request.header('x-authkit-signature') },
      { secret: options.secret, toleranceSec: options.toleranceSec, replayStore },
    );
    if (!verdict.ok) {
      if (verdict.reason === 'replay') return ctx.response.noContent();
      if (verdict.reason === 'signature') {
        return ctx.response.unauthorized({ error: 'invalid_signature' });
      }
      return ctx.response.badRequest({ error: verdict.reason });
    }
    if (options.onEvent) await options.onEvent(verdict.event);
    if (options.emit !== false) emitAuthkitEvent(verdict.event);
    return ctx.response.noContent();
  };
}

/**
 * Mounts `POST path` (default `/authkit/webhook`) with {@link authkitWebhookHandler}:
 *
 * ```ts
 * // start/routes.ts
 * registerAuthkitWebhook(router, { secret: env.get('AUTHKIT_WEBHOOK_SECRET') })
 * ```
 *
 * Point authkit-server's `events.webhook` at `https://<this app>/authkit/webhook` with the
 * same secret, and add the path to shield's `csrf.exceptRoutes`.
 */
export function registerAuthkitWebhook(
  router: Router,
  options: AuthkitWebhookOptions & { path?: string },
): void {
  const { path = '/authkit/webhook', ...rest } = options;
  router.post(path, authkitWebhookHandler(rest)).as('authkit.webhook');
}
