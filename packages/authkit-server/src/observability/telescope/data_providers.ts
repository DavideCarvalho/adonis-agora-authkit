import type { DataProvider, ExtensionContext } from '@adonis-agora/telescope';
import type { AuditEvent, AuditEventType } from '../../audit/audit_sink.js';

/**
 * Data providers for the authkit "Security" Telescope dashboard.
 *
 * They are 100% ENTRY-backed: the authkit provider already republishes every
 * audit event on the Agora diagnostics bus as `agora:authkit:<AuditEventType>`,
 * and Telescope's generic diagnostics watcher records each one as a `diagnostic`
 * entry (`tag: 'lib:authkit'`, `content.event` = the `AuditEventType`,
 * `content.payload` = a PII-free projection of the {@link AuditEvent}). The bridge
 * REDACTS the projection before it hits the bus — `email`, `ip` and the free-form
 * `metadata` are dropped, leaving only `type` + the opaque `accountId`/`actorId`/
 * `clientId` — so Telescope never stores raw PII for a (possibly deleted) account.
 * See `redactAuditEventForDiagnostics` in events/dispatcher.ts. These providers
 * roll those captured entries up — no host service is resolved from the container.
 *
 * The entry slice each provider reads (a structural subset of a Telescope
 * `Entry`, so the providers stay decoupled from the entry's concrete shape).
 */
interface AuthkitEntry {
  content?: {
    event?: string;
    payload?: AuditEvent;
  };
  createdAt?: Date | string;
}

/** The Telescope entry `type` the generic diagnostics watcher records under. */
const DIAGNOSTIC_TYPE = 'diagnostic';
/** The tag the diagnostics watcher stamps for authkit-emitted events. */
const AUTHKIT_TAG = 'lib:authkit';
/** Default rolling window for the entry-backed providers (24h). */
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Fetch captured `agora:authkit:*` audit entries from Telescope (newest-first). */
async function fetchEntries(ctx: ExtensionContext, limit = 5_000): Promise<AuthkitEntry[]> {
  return ctx.store.list({
    type: DIAGNOSTIC_TYPE,
    tag: AUTHKIT_TAG,
    limit,
  }) as unknown as Promise<AuthkitEntry[]>;
}

/** The `AuditEventType` an entry carries (under `content.event`), or `''`. */
function eventOf(e: AuthkitEntry): string {
  return e.content?.event ?? '';
}

/** Epoch millis the entry was recorded at, or `0` when absent/unparsable. */
function timeOf(e: AuthkitEntry): number {
  return e.createdAt ? +new Date(e.createdAt) : 0;
}

/** Count entries whose `content.event` is one of `types`. */
function countByType(entries: AuthkitEntry[], types: readonly string[]): number {
  const set = new Set(types);
  let n = 0;
  for (const e of entries) if (set.has(eventOf(e))) n += 1;
  return n;
}

/** Split entries into the current `(now-window, now]` and previous window. */
function splitWindows(
  entries: AuthkitEntry[],
  windowMs: number,
  now: number,
): { current: AuthkitEntry[]; previous: AuthkitEntry[] } {
  const start = now - windowMs;
  const prevStart = start - windowMs;
  return {
    current: entries.filter((e) => timeOf(e) > start && timeOf(e) <= now),
    previous: entries.filter((e) => timeOf(e) > prevStart && timeOf(e) <= start),
  };
}

// The audit event groupings the dashboard rolls up.
const LOGIN_SUCCESS: readonly AuditEventType[] = ['login.success'];
const LOGIN_FAILURE: readonly AuditEventType[] = ['login.failure', 'bot_protection.rejected'];
const MFA_ENROLLMENTS: readonly AuditEventType[] = ['mfa.enabled', 'passkey.registered'];
const LOCKOUTS: readonly AuditEventType[] = ['account.locked', 'otp.locked'];
const PAT_EVENTS: readonly AuditEventType[] = ['pat.issued', 'pat.revoked', 'pat.used'];
const IMPERSONATION_EVENTS: readonly AuditEventType[] = [
  'impersonation',
  'impersonation.panel_viewed',
];

/**
 * A stat (`{ value, delta?, spark? }`) over a window for a set of event types.
 * `query.metric` chooses the grouping; `query.windowMs` the window (default 24h).
 */
export function authkitEventCountProvider(): DataProvider {
  return {
    name: 'authkit.eventCount',
    async resolve(query, ctx) {
      const entries = await fetchEntries(ctx);
      const windowMs = Number(query?.windowMs ?? DEFAULT_WINDOW_MS);
      const now = Date.now();
      const types = typesForMetric(query?.metric as string | undefined);
      const { current, previous } = splitWindows(entries, windowMs, now);
      const value = countByType(current, types);
      const delta = previous.length > 0 ? value - countByType(previous, types) : undefined;
      const sparkBuckets = 8;
      const bucketSize = windowMs / sparkBuckets;
      const sparkStart = now - windowMs;
      const spark = Array.from({ length: sparkBuckets }, (_, i) => {
        const bStart = sparkStart + i * bucketSize;
        const bEntries = current.filter((e) => {
          const t = timeOf(e);
          return t > bStart && t <= bStart + bucketSize;
        });
        return countByType(bEntries, types);
      });
      return delta === undefined ? { value, spark } : { value, delta, spark };
    },
  };
}

/** Map a panel `metric` to the set of `AuditEventType`s it aggregates. */
function typesForMetric(metric: string | undefined): readonly string[] {
  switch (metric) {
    case 'loginFailure':
      return LOGIN_FAILURE;
    case 'mfaEnrollments':
      return MFA_ENROLLMENTS;
    case 'lockouts':
      return LOCKOUTS;
    case 'pat':
      return PAT_EVENTS;
    case 'impersonation':
      return IMPERSONATION_EVENTS;
    default:
      return LOGIN_SUCCESS;
  }
}

/**
 * Login success rate as a gauge (`{ value, min, max }`), over `query.windowMs`
 * (default 24h). `1` when there were no logins in the window.
 */
export function authkitLoginSuccessRateProvider(): DataProvider {
  return {
    name: 'authkit.loginSuccessRate',
    async resolve(query, ctx) {
      const entries = await fetchEntries(ctx);
      const windowMs = Number(query?.windowMs ?? DEFAULT_WINDOW_MS);
      const { current } = splitWindows(entries, windowMs, Date.now());
      const ok = countByType(current, LOGIN_SUCCESS);
      const bad = countByType(current, LOGIN_FAILURE);
      const total = ok + bad;
      return { value: total === 0 ? 1 : ok / total, min: 0, max: 1 };
    },
  };
}

/**
 * Logins over time as `timeseries` rows (`{ rows: [{ label, success, failure }] }`),
 * bucketed into `query.buckets ?? 24` equal time buckets across the captured span.
 */
export function authkitLoginsOverTimeProvider(): DataProvider {
  return {
    name: 'authkit.loginsOverTime',
    async resolve(query, ctx) {
      const entries = await fetchEntries(ctx);
      const n = Math.max(1, Number(query?.buckets ?? 24));
      const now = Date.now();
      let minT = now;
      for (const e of entries) {
        const t = timeOf(e);
        if (t > 0) minT = Math.min(minT, t);
      }
      const span = Math.max(now - minT, 1);
      const bucketSize = span / n;
      const rows = Array.from({ length: n }, (_, i) => ({
        label: new Date(minT + i * bucketSize).toISOString().slice(11, 16),
        success: 0,
        failure: 0,
      }));
      const successSet = new Set<string>(LOGIN_SUCCESS);
      const failureSet = new Set<string>(LOGIN_FAILURE);
      for (const e of entries) {
        const event = eventOf(e);
        const isSuccess = successSet.has(event);
        const isFailure = failureSet.has(event);
        if (!isSuccess && !isFailure) continue;
        const row = rows[Math.min(n - 1, Math.floor((timeOf(e) - minT) / bucketSize))];
        if (row) {
          if (isSuccess) row.success += 1;
          else row.failure += 1;
        }
      }
      return { rows };
    },
  };
}

/** Donut/bar `breakdown` segments — a count per top-level audit event family. */
const BREAKDOWN_GROUPS: Array<{
  label: string;
  types: readonly string[];
  color: string;
}> = [
  { label: 'Login OK', types: LOGIN_SUCCESS, color: '#34d399' },
  { label: 'Login fail', types: LOGIN_FAILURE, color: '#f87171' },
  { label: 'MFA', types: MFA_ENROLLMENTS, color: '#38bdf8' },
  { label: 'Lockouts', types: LOCKOUTS, color: '#fbbf24' },
  { label: 'PAT', types: PAT_EVENTS, color: '#a78bfa' },
  { label: 'Impersonation', types: IMPERSONATION_EVENTS, color: '#fb923c' },
];

export function authkitEventBreakdownProvider(): DataProvider {
  return {
    name: 'authkit.eventBreakdown',
    async resolve(query, ctx) {
      const entries = await fetchEntries(ctx);
      const windowMs = Number(query?.windowMs ?? DEFAULT_WINDOW_MS);
      const { current } = splitWindows(entries, windowMs, Date.now());
      const segments = BREAKDOWN_GROUPS.map((g) => ({
        label: g.label,
        value: countByType(current, g.types),
        color: g.color,
      }));
      return { segments };
    },
  };
}

/**
 * Recent PAT + impersonation activity as `table` rows (newest-first), bounded by
 * `query.limit` (default 50). Each row exposes the event, subject and actor.
 */
export function authkitTokenActivityProvider(): DataProvider {
  return {
    name: 'authkit.tokenActivity',
    async resolve(query, ctx) {
      const entries = await fetchEntries(ctx);
      const limit = Math.min(200, Math.max(10, Number(query?.limit ?? 50)));
      const watched = new Set<string>([...PAT_EVENTS, ...IMPERSONATION_EVENTS]);
      const rows = entries
        .filter((e) => watched.has(eventOf(e)))
        .slice(0, limit)
        .map((e) => {
          const p = e.content?.payload;
          return {
            at: e.createdAt
              ? `${new Date(e.createdAt).toISOString().replace('T', ' ').slice(0, 16)}Z`
              : '',
            event: eventOf(e),
            subject: p?.accountId ?? '',
            actor: p?.actorId ?? '',
            // `ip` is intentionally NOT surfaced: the diagnostics bridge emits a
            // PII-free projection of each audit event (no `email`/`ip`/`metadata`)
            // so a deleted account's PII never lands in Telescope's store. See
            // `redactAuditEventForDiagnostics` in events/dispatcher.ts.
          };
        });
      return { rows };
    },
  };
}

/** Every authkit data provider, in registration order. */
export function authkitDataProviders(): DataProvider[] {
  return [
    authkitEventCountProvider(),
    authkitLoginSuccessRateProvider(),
    authkitLoginsOverTimeProvider(),
    authkitEventBreakdownProvider(),
    authkitTokenActivityProvider(),
  ];
}
