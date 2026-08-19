/**
 * Guard against the audit union drifting away from what the code emits.
 *
 * `AuditEventType` used to be a hand-written union. Nothing checked it against
 * the `audit.record({ type: ... })` call sites, so five event types shipped
 * without ever entering the union — `login.magic_link_sent`, `session.revoked`,
 * `account.signed_out_all`, `client.secret_regenerated` and
 * `roles_catalog.updated`. A consumer writing an exhaustive `switch` over
 * `AuditEventType` silently dropped all five, and TypeScript had no way to say
 * so: the events only exist as string literals inside the library.
 *
 * The union is now derived from {@link AUDIT_EVENT_TYPES}, which exists at
 * runtime — so this spec can scan `src/` and compare. The check runs in the
 * direction that matters: every type the library EMITS must be declared. The
 * reverse (a declared type nothing emits) is deliberately not an error — rows
 * already written to a host's audit table keep their historical types long
 * after the emitter is gone.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@japa/runner';
import { AUDIT_EVENT_TYPES } from '../../src/audit/audit_sink.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (full.endsWith('.ts')) yield full;
  }
}

interface Emission {
  type: string;
  file: string;
}

/**
 * Slice out the argument list of the call whose opening paren is at `open`,
 * respecting nesting and string literals.
 *
 * A fixed-size window is not good enough: it runs past the end of the call and
 * picks up unrelated literals from the code that follows — an i18n key handed
 * to `renderOtpError`, a route segment in `accountPath('orgs')`. Both looked
 * like undeclared audit events on the first run of this scan.
 */
function callArguments(source: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(' || char === '{' || char === '[') depth++;
    else if (char === ')' || char === '}' || char === ']') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

interface Emission {
  type: string;
  file: string;
}

/**
 * Collect the event types passed to audit sinks across `src/`.
 *
 * Anchored on `.record(` preceded by `audit`, which is how every emission in
 * this package reaches a sink (`cfg.audit?.record`, `this.cfg.audit?.record`,
 * `deps.audit?.record`, `audit?.sink?.record`, …). Anchoring on the sink rather
 * than on a bare `type:` is what keeps unrelated `type:` fields — the sudo
 * method's `type: 'password' | 'text'` form field, for one — out of the scan.
 *
 * Both branches of a ternary are captured, because `user.disabled` /
 * `user.enabled` are emitted as `type: disable ? '…' : '…'`.
 */
function collectEmissions(): Emission[] {
  const found: Emission[] = [];
  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf8');
    const rel = relative(SRC, file);
    const recordCall = /\.record\(/g;
    let call: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
    while ((call = recordCall.exec(source)) !== null) {
      const before = source.slice(Math.max(0, call.index - 48), call.index);
      if (!before.includes('audit')) continue;

      const args = callArguments(source, call.index + '.record'.length);
      const typeField = /\btype:\s*([^\n]*(?:\n[^\n]*)?)/.exec(args);
      if (!typeField) continue;
      // Stop at the end of the property, so a later string field is not read as a type.
      const value = typeField[1].split(/,\s*$|,\n/)[0];
      for (const literal of value.matchAll(/'([^']+)'/g)) {
        found.push({ type: literal[1], file: rel });
      }
    }
  }
  return found;
}

test.group('audit event union', () => {
  test('the scan finds the call sites at all', ({ assert }) => {
    const emissions = collectEmissions();
    // A scanner that silently matches nothing would make every assertion below
    // vacuously true, which is the classic way a guard like this rots.
    assert.isAbove(
      emissions.length,
      50,
      'the scanner stopped finding audit.record() call sites — fix the scan, not the threshold',
    );
    assert.includeMembers(
      emissions.map((e) => e.type),
      ['login.success', 'impersonation', 'user.disabled', 'user.enabled'],
      'the scan must reach plain literals and both branches of a ternary',
    );
  });

  test('every emitted audit event type is declared in AUDIT_EVENT_TYPES', ({ assert }) => {
    const declared = new Set<string>(AUDIT_EVENT_TYPES);
    const undeclared = [...new Map(collectEmissions().map((e) => [e.type, e])).values()]
      .filter((e) => !declared.has(e.type))
      .map((e) => `${e.type} (emitted in src/${e.file})`)
      .sort();

    assert.deepEqual(
      undeclared,
      [],
      'these event types are emitted but missing from AUDIT_EVENT_TYPES — add them to the list',
    );
  });

  test('AUDIT_EVENT_TYPES has no duplicates', ({ assert }) => {
    const seen = new Set<string>();
    const duplicates = AUDIT_EVENT_TYPES.filter((t) => (seen.has(t) ? true : (seen.add(t), false)));
    assert.deepEqual(duplicates, []);
  });
});
