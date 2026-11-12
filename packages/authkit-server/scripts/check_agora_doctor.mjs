#!/usr/bin/env node
/**
 * `agora:doctor` is shipped by every @adonis-agora lib and its runner and command must stay
 * byte-identical to the reference copies @adonis-agora/durable publishes (Ace keeps whichever copy
 * loads last). Reference, first found:
 *
 *   1. `AGORA_DOCTOR_REFERENCE`: a directory holding `agora_doctor.ts.txt` and
 *      `agora_doctor_command.ts.txt`, or a URL base laid out like durable's `packages/adonis`;
 *   2. the installed `@adonis-agora/durable/dist/agora-doctor/` (published with durable);
 *   3. durable's default branch sources on GitHub.
 *
 * Until durable publishes them (no installed copy, 404 on GitHub) the check says so and passes;
 * from then on any drift fails.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const FILES = [
  { local: 'src/doctor/agora_doctor.ts', txt: 'agora_doctor.ts.txt' },
  { local: 'commands/agora_doctor.ts', txt: 'agora_doctor_command.ts.txt' },
];
const GITHUB =
  'https://raw.githubusercontent.com/DavideCarvalho/adonis-agora-durable/master/packages/adonis';

function installedReferenceDir() {
  try {
    const pkg = createRequire(join(root, 'package.json')).resolve(
      '@adonis-agora/durable/package.json',
    );
    return join(dirname(pkg), 'dist', 'agora-doctor');
  } catch {
    return null;
  }
}

async function fromDir(dir, file) {
  try {
    return await readFile(join(dir, file.txt), 'utf8');
  } catch {
    return null;
  }
}

async function fromUrl(base, file) {
  const response = await fetch(`${base}/${file.local}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${base}/${file.local}: HTTP ${response.status}`);
  return response.text();
}

async function reference(file) {
  const override = process.env.AGORA_DOCTOR_REFERENCE;
  if (override) {
    return /^https?:/.test(override) ? fromUrl(override, file) : fromDir(override, file);
  }
  const dir = installedReferenceDir();
  if (dir) {
    const text = await fromDir(dir, file);
    if (text !== null) return text;
  }
  return fromUrl(GITHUB, file);
}

let failed = false;
for (const file of FILES) {
  const ours = await readFile(join(root, file.local), 'utf8');
  const theirs = await reference(file);
  if (theirs === null) {
    console.log(`agora-doctor: ${file.local}: durable has not published its copy yet; skipped`);
    continue;
  }
  if (theirs === ours) {
    console.log(`agora-doctor: ${file.local} matches the reference.`);
    continue;
  }
  failed = true;
  console.error(`agora-doctor: ${file.local} differs from durable's reference. Copy it verbatim.`);
}
process.exit(failed ? 1 : 0);
