import type { AuditPage, ListAuditParams, StoredAuditEvent } from '../../src/audit/audit_sink.js';

/**
 * `AuditSink.list` over an in-memory array, for test sinks: filters by `type` / `subject`
 * and pages by cursor (the cursor is the offset, as a string). `events` is taken as already
 * newest first.
 */
export function memoryAuditList(
  events: readonly StoredAuditEvent[],
  params: ListAuditParams = {},
): AuditPage {
  const types = params.type === undefined ? [] : ([] as string[]).concat(params.type);
  const rows = events
    .filter((e) => types.length === 0 || types.includes(e.type))
    .filter((e) => !params.subject || e.accountId === params.subject);
  const size = params.size ?? 20;
  let start = 0;
  if (params.after) start = Number(params.after);
  else if (params.before) start = Math.max(0, Number(params.before) - size);
  const end = params.before && !params.after ? Number(params.before) : start + size;
  const data = rows.slice(start, end);
  const hasNext = end < rows.length;
  const hasPrev = start > 0;
  return {
    data,
    nextCursor: hasNext ? String(end) : null,
    prevCursor: hasPrev ? String(start) : null,
    hasNext,
    hasPrev,
  };
}

/** An `AuditPage` holding exactly `data` (no other page). */
export function auditPageOf(data: StoredAuditEvent[]): AuditPage {
  return { data, nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false };
}
