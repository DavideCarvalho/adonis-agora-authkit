#!/usr/bin/env node
/**
 * `agora:doctor` is shipped by every @adonis-agora lib and must stay byte-identical across them
 * (Ace keeps whichever copy loads last). This compares our copies with the reference copies in
 * @adonis-agora/durable's default branch and fails on any difference.
 *
 * Until durable publishes its copies (404), the check reports that and passes; from then on any
 * drift fails. `AGORA_DOCTOR_REFERENCE` overrides the reference base (a URL or a local directory
 * laid out like durable's `packages/adonis`).
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const base =
  process.env.AGORA_DOCTOR_REFERENCE ??
  'https://raw.githubusercontent.com/DavideCarvalho/adonis-agora-durable/master/packages/adonis';
const FILES = ['src/doctor/agora_doctor.ts', 'commands/agora_doctor.ts'];

async function reference(file) {
  if (!/^https?:/.test(base)) {
    try {
      return await readFile(join(base, file), 'utf8');
    } catch {
      return null;
    }
  }
  const response = await fetch(`${base}/${file}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${base}/${file}: HTTP ${response.status}`);
  return response.text();
}

let failed = false;
for (const file of FILES) {
  const ours = await readFile(join(root, file), 'utf8');
  const theirs = await reference(file);
  if (theirs === null) {
    console.log(`agora-doctor drift: ${file} not published by durable yet; skipped`);
    continue;
  }
  if (theirs === ours) {
    console.log(`agora-doctor drift: ${file} identical`);
    continue;
  }
  failed = true;
  const a = ours.split('\n');
  const b = theirs.split('\n');
  const line = a.findIndex((text, i) => text !== b[i]);
  console.error(
    `agora-doctor drift: ${file} differs from durable's copy (first at line ${line + 1})`,
  );
  console.error(`  ours:    ${a[line] ?? '<eof>'}`);
  console.error(`  durable: ${b[line] ?? '<eof>'}`);
}
if (failed) {
  console.error('Copy the files from durable verbatim: they must stay identical across libs.');
  process.exit(1);
}
