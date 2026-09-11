#!/usr/bin/env node
// Turns a Renovate dependency bump that landed on the release branch into a patch changeset,
// so the publish step that follows has something to release.
//
// It writes nothing unless the push actually moved a published package's runtime dependencies:
// lockfile maintenance, devDependency bumps and GitHub Actions bumps change nothing consumers
// install, and a release per each of those is noise.
//
// Invoked from the release workflow with BEFORE/AFTER set to the pushed range.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";

const before = process.env.BEFORE;
const after = process.env.AFTER || "HEAD";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const skip = (why) => {
  console.log(`No dependency release: ${why}`);
  process.exit(0);
};

// A changeset already waiting means a hand-written release is queued behind it. Versioning now
// would drag that unreleased work out under a dependency bump's name.
const pending = existsSync(".changeset")
  ? readdirSync(".changeset").filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
  : [];
if (pending.length > 0) skip(`changeset(s) already pending (${pending.join(", ")})`);

if (!before || /^0+$/.test(before)) skip("no previous commit to compare against");

const changed = git("diff", "--name-only", `${before}..${after}`)
  .split("\n")
  .filter((f) => f === "package.json" || f.endsWith("/package.json"));
if (changed.length === 0) skip("no package.json changed");

const readAt = (rev, path) => {
  try {
    return JSON.parse(git("show", `${rev}:${path}`));
  } catch {
    return null;
  }
};

const RUNTIME = ["dependencies", "peerDependencies"];
const bumped = [];
for (const file of changed) {
  const now = readAt(after, file);
  if (!now || !now.name || now.private === true) continue;
  const then = readAt(before, file) || {};
  const moved = RUNTIME.some(
    (field) => JSON.stringify(now[field] || {}) !== JSON.stringify(then[field] || {}),
  );
  if (moved) bumped.push(now.name);
}
if (bumped.length === 0) skip("no published package changed a runtime dependency");

const summary = git("log", "-1", "--pretty=%s", after).trim();
writeFileSync(
  `.changeset/renovate-${after.slice(0, 12)}.md`,
  ["---", ...bumped.map((name) => `"${name}": patch`), "---", "", summary, ""].join("\n"),
);
console.log(`Patch release queued for ${bumped.join(", ")}`);
