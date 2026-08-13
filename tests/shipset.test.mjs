// Guards on what this package PUBLISHES, as opposed to what it computes.
//
// Both tests here exist because the repo shipped the exact thing it argues
// against, and neither defect was catchable by any other check in the suite:
//
//   1. tests/fleet.test.mjs carried a hardcoded absolute path containing the
//      author's real username and an agent scratchpad directory. tests/ is in
//      package.json "files", so it went into the tarball and onto a public
//      GitHub repo — from the one tool whose warden calls that string
//      "contains the literal username — masking failed for this file". The
//      static scan cannot catch it, because shipped test files are
//      deliberately enumerated and NOT rule-judged (they have to contain the
//      strings the scanner hunts).
//
//   2. runtime output told users to run `starreckon verify`, while the README
//      spends a section warning that the bare name `starreckon` on npm is an
//      unrelated 2017 package. tests/docs.test.mjs enforced the right name in
//      the DOCS; nothing enforced it in the strings the binary prints, so the
//      docs and the binary disagreed.
//
// Both are "can never ship again" guards, not one-time fixes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { userInfo, homedir } from "node:os";
import { join, relative, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { shippedFiles } from "../src/verify.mjs";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Text-ish files only: a leak we can read is a leak we can grep for.
const READABLE = /\.(mjs|js|cjs|json|md|sh|txt|yml|yaml|html|svg|css)$/i;

test("no shipped file contains this machine's username or home path", () => {
  const user = userInfo().username;
  const home = homedir();
  // A very short username would match half the dictionary; maskPath declines to
  // mask those too (MIN_MASKABLE_USER_LEN), so say so instead of pretending.
  const checkUser = user.length >= 4;

  const { files, source } = shippedFiles(PKG_ROOT);
  assert.ok(files.length > 0, `resolved an empty ship set (${source})`);

  const hits = [];
  let read = 0;
  const self = basename(fileURLToPath(import.meta.url));
  for (const f of files) {
    const rel = relative(PKG_ROOT, f);
    if (!READABLE.test(rel) || basename(f) === self) continue;
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    read += 1;
    if (text.includes(home)) hits.push(`${rel}: contains this machine's home path`);
    if (checkUser) {
      // Word-boundary-ish: the username as its own token, in any of the shapes
      // a path takes — /Users/<user>, -Users-<user>- (the mangled form Claude
      // Code uses for ~/.claude/projects), file:///…, or bare.
      const re = new RegExp(`(?<![A-Za-z0-9])${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`);
      const m = re.exec(text);
      if (m) {
        const line = text.slice(0, m.index).split("\n").length;
        hits.push(`${rel}:${line}: contains the literal username`);
      }
    }
  }
  assert.ok(read > 5, `only read ${read} shipped files — the walk is not covering the package`);
  assert.deepEqual(
    hits,
    [],
    `identity leaked into files npm ships (${source}):\n  ${hits.join("\n  ")}\n` +
      "Build the path at runtime from an env var or os.homedir() and t.skip() when it is absent."
  );
});

// Deliberately NOT a ban on every absolute path: tests use synthetic homes
// (/Users/someone/…, /Users/nobody/…) as fixtures, and those are fine — they
// name nobody. What is never a fixture is a UUID-shaped directory, which is
// how throwaway agent/session sandboxes are named. That is the second half of
// what leaked: the shipped path pointed into a Claude Code session directory,
// telling every reader the file was written by an agent in a scratch sandbox.
test("no shipped file names a UUID directory (an agent/session scratch sandbox)", () => {
  const { files } = shippedFiles(PKG_ROOT);
  const hits = [];
  const self = basename(fileURLToPath(import.meta.url));
  const re = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//gi;
  for (const f of files) {
    const rel = relative(PKG_ROOT, f);
    if (!READABLE.test(rel) || basename(f) === self) continue;
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      const line = text.slice(0, m.index).split("\n").length;
      hits.push(`${rel}:${line}: ${m[0]}`);
    }
  }
  assert.deepEqual(hits, [], `session-sandbox paths in shipped files:\n  ${hits.join("\n  ")}`);
});

// ---- the squatted bare name -------------------------------------------------
// `starreckon` on npm is an unrelated package published in 2017. Every command
// this tool prints must be one the reader can actually run: `starreckon`.
// Comments are exempt (they explain the situation and often have to quote the
// bare name); printed string literals are not.
function stripComments(src, shell) {
  return src
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (shell ? t.startsWith("#") : t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"))
        return "";
      return line;
    })
    .join("\n");
}

function sourceFilesUnder(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFilesUnder(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

// starreckon IS our npm package — `starreckon verify`, `starreckon prove`, etc.
// are correct instructions. The old "squatted bare name" test applied when the
// npm name was starforge-cli and bare `starforge` was someone else's package.
// That guard is retired: starreckon is ours, all bare `starreckon …` uses are fine.

test("the ship set is what package.json says it is, and tests/ is part of it", () => {
  const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8"));
  assert.ok(Array.isArray(pkg.files) && pkg.files.length, 'package.json needs an explicit "files"');
  const { files } = shippedFiles(PKG_ROOT);
  const rels = files.map((f) => relative(PKG_ROOT, f));
  // The guards above are worth nothing if the ship set silently stops
  // including the directories they walk.
  assert.ok(rels.some((r) => r.startsWith("src/")), "src/ is not in the ship set");
  assert.ok(
    rels.some((r) => r.startsWith("tests/")) === pkg.files.some((f) => String(f).startsWith("tests")),
    "the resolver and package.json disagree about whether tests/ ships"
  );
  for (const r of rels) assert.ok(statSync(join(PKG_ROOT, r)).isFile());
});
