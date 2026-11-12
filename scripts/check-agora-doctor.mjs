#!/usr/bin/env node
/**
 * agora-doctor drift check v1 — keep identical across libs.
 *
 * Every @adonis-agora lib ships the same `agora:doctor` runner and command, byte for byte
 * (whichever copy Ace loads last runs every lib's checks). This fails when this repo's copies
 * differ from the canonical v1 files pinned below.
 *
 * Usage: node scripts/check-agora-doctor.mjs <package dir> [<package dir> ...]
 * e.g.   node scripts/check-agora-doctor.mjs packages/core
 *
 * Never edit the copies or the hashes in one repo: update the canonical files, then re-copy the
 * three files (runner, command, this script) into every lib.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FROZEN = {
  'src/doctor/agora_doctor.ts': {
    header: '// agora-doctor runner v1 — keep identical across libs',
    sha256: 'add876a2b951aa31eb46382f8468e8d0de3f134db48cfff94cc8bc59fcdfd8f0',
  },
  'commands/agora_doctor.ts': {
    header: '// agora-doctor command v1 — keep identical across libs',
    sha256: 'e6efe88f3c81910f3ddabf4d69c353f8d79f540ff38beecc136f8158bf9c8005',
  },
};

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: node scripts/check-agora-doctor.mjs <package dir> [<package dir> ...]');
  process.exit(2);
}

let failed = false;
for (const dir of dirs) {
  for (const [file, { header, sha256 }] of Object.entries(FROZEN)) {
    const path = join(resolve(dir), file);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      console.error(`✖ ${path}: missing`);
      failed = true;
      continue;
    }
    const actual = createHash('sha256').update(text).digest('hex');
    if (!text.startsWith(header)) {
      console.error(`✖ ${path}: missing the header "${header}"`);
      failed = true;
    } else if (actual !== sha256) {
      console.error(
        `✖ ${path}: differs from the canonical v1 copy (sha256 ${actual}, expected ${sha256})`,
      );
      failed = true;
    } else {
      console.log(`✔ ${path}`);
    }
  }
}
process.exit(failed ? 1 : 0);
