/**
 * Peer ranges on `@adonis-agora/*` must not use a caret while the dependency is
 * still on 0.x.
 *
 * In semver, `^0.22.0` does NOT mean "0.22 and up" — below 1.0.0 the caret stops
 * at the next minor, so it expands to `>=0.22.0 <0.23.0`. Every sibling package
 * in this ecosystem ships minors constantly, so a caret peer goes stale the day
 * after it is written: a consumer on `@adonis-agora/durable@0.24.0` got an
 * outright `ERESOLVE` install failure from npm, not merely a warning.
 *
 * All four `@adonis-agora/*` peers in this repo were simultaneously unsatisfiable
 * against the current release of the package they name. The shape that survives a
 * minor bump is `>=X.Y.0 <1.0.0`, with the floor chosen from what the code
 * actually needs.
 *
 * This guard is deliberately scoped to `@adonis-agora/*`. A caret on a 1.x
 * dependency behaves the way people expect, and third-party peers are not ours to
 * police.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@japa/runner';

const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

interface PeerRange {
  pkg: string;
  peer: string;
  range: string;
}

function readPeerRanges(): PeerRange[] {
  const found: PeerRange[] = [];
  for (const dir of readdirSync(PACKAGES)) {
    let manifest: { name?: string; peerDependencies?: Record<string, string> };
    try {
      manifest = JSON.parse(readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8'));
    } catch {
      continue; // not a package directory
    }
    for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!peer.startsWith('@adonis-agora/')) continue;
      found.push({ pkg: manifest.name ?? dir, peer, range });
    }
  }
  return found;
}

/** `^0.x.y` / `~0.x.y` — a range that cannot survive the peer's next minor. */
function isCaretOnZero(range: string): boolean {
  return /(^|\|\|)\s*[\^~]\s*0\./.test(range);
}

test.group('@adonis-agora peer ranges', () => {
  test('the scan finds the peer ranges at all', ({ assert }) => {
    const ranges = readPeerRanges();
    // A scan that silently matches nothing would make the assertion below
    // vacuously true — the way this guard would rot without anyone noticing.
    assert.isAbove(
      ranges.length,
      3,
      'the scan stopped finding @adonis-agora peers — fix the scan, not the threshold',
    );
    assert.includeMembers(
      ranges.map((r) => r.peer),
      ['@adonis-agora/durable'],
    );
  });

  test('no @adonis-agora peer pins a caret on a 0.x range', ({ assert }) => {
    const offenders = readPeerRanges()
      .filter((r) => isCaretOnZero(r.range))
      .map((r) => `${r.pkg} → ${r.peer}: "${r.range}"`)
      .sort();

    assert.deepEqual(
      offenders,
      [],
      'a caret below 1.0.0 stops at the next minor, so these go stale on the peer\'s next release — use ">=X.Y.0 <1.0.0"',
    );
  });
});
