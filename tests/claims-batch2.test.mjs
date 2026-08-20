// Guards for the claims the census found UNGUARDED — batch 2.
//
// Both of these live in scanners.mjs, and both had a guard somewhere else in
// the program that made them LOOK tested.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scannerVersion, scanPortedReaders } from "../src/scanners.mjs";
import { record, lifetime } from "../src/ledger.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "claims2-"));
const session = (o = {}) => ({
  cli: "claude", session_id: "sess-abc", total: 1000,
  tokens: { input_tokens: 600, cache_creation_input_tokens: 100,
            cache_read_input_tokens: 200, output_tokens: 100 },
  start: "2026-07-01T10:00:00Z", model: "claude-opus-5", ...o,
});

// ── the scanner fingerprint is NULL, never the string "unknown" ─────────────
//
// scannerVersion() hashes the counting sources. When it cannot — a file it
// reads is missing or unreadable — the honest answer is "I do not know", and a
// value meaning that MUST NOT BEHAVE LIKE A VALUE.
//
// The previous version returned "unknown" from a bare catch, and
// "unknown" === "unknown": two machines running DIFFERENT code, both failing
// to hash, compared EQUAL, and every skew check passed. ledger.record() takes
// a whole separate path for null precisely so two unhashable scans get unique
// tags and lifetime() never max-merges them into one number. Return "unknown"
// and that path is never taken.

test("the fingerprint is a 12-hex digest, or null — never a word", () => {
  const v = scannerVersion();
  assert.ok(v === null || /^[0-9a-f]{12}$/.test(v), `got ${JSON.stringify(v)}`);
  assert.notEqual(v, "unknown");
});

test("the catch returns null rather than a sentinel string", () => {
  const src = readFileSync(new URL("../src/scanners.mjs", import.meta.url), "utf8");
  const i = src.indexOf("export function scannerVersion()");
  assert.ok(i > 0);
  const body = src.slice(i, i + 700);
  assert.match(body, /catch\s*\{\s*return null;/,
    "a string here compares equal to itself across two different codebases");
  assert.ok(!/catch\s*\{\s*return "unknown"/.test(body));
});

test("two scans that could not hash themselves are NEVER merged", () => {
  // THE CONSEQUENCE, not the spelling. Two different machines, both unable to
  // fingerprint, recording the same session id with different totals.
  const home = tmp();
  try {
    record([session({ session_id: "s1", total: 1000 })], null, home);
    record([session({ session_id: "s1", total: 4000 })], null, home);
    const lt = lifetime(home);
    // If both rows carried one shared tag they would land in the same rank
    // bucket and be field-wise-maxed into a single 4000. They must not: two
    // numbers from two unknown codebases are two observations, not one.
    assert.notEqual(lt.total, 0, "the ledger recorded nothing at all");
    const rowsOnDisk = readFileSync(join(home, ".starreckon", "token_ledger.jsonl"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    const tags = new Set(rowsOnDisk.map((r) => r.scanner_version ?? r.scanner));
    assert.equal(tags.size, rowsOnDisk.length,
      `two null-scanner rows shared a tag (${[...tags].join(", ")}) — that is `
      + `what "unknown" would do to every machine that cannot hash itself`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a REAL version does share its tag, which is the whole contrast", () => {
  const home = tmp();
  try {
    record([session({ session_id: "s1", total: 1000 })], "ver-a", home);
    record([session({ session_id: "s1", total: 4000 })], "ver-a", home);
    const lt = lifetime(home);
    assert.equal(lt.total, 4000,
      "same version, same session: the higher observation replaces the lower");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── knownClaudeIds is REQUIRED ──────────────────────────────────────────────
//
// The orphan reader counts Claude sessions whose transcripts are gone, using
// the live session ids to exclude the ones still on disk. Without that set
// EVERY LIVE SESSION IS COUNTED TWICE — once from its transcript and once from
// its surviving counter. On this fleet that is 4,172,332,033 tokens of orphan
// data sitting next to the live ones.
//
// conformance.test.mjs asserts readClaudeOrphans throws without it. It does not
// touch scanPortedReaders, which carries the same guard in scanners.mjs — two
// functions, one rule, and only one of them tested. Deleting the guard here
// left every suite green.

test("scanPortedReaders refuses to run without the live Claude ids", async () => {
  // ASSERTED ON THE MESSAGE, NOT JUST THE THROW. readClaudeOrphans carries the
  // same rule one layer down and its message also matches /must be the Set/,
  // so a check written that loosely passed with THIS guard deleted — the
  // census caught exactly that and called the claim unguarded while every test
  // was green. The outer guard's value is that it fires BEFORE the dynamic
  // import and before any reader touches the disk, and it names itself.
  await assert.rejects(() => scanPortedReaders([tmp()]), (e) => {
    assert.ok(e instanceof TypeError, `got ${e.constructor.name}`);
    assert.match(e.message, /^scanPortedReaders:/,
      "the refusal must come from the outer guard, not from a reader deeper in");
    assert.match(e.message, /orphan reader re-counts every live session/);
    return true;
  });
});

test("and refuses anything that is not a Set", async () => {
  for (const bad of [[], null, "s1", new Map(), { size: 0 }]) {
    await assert.rejects(() => scanPortedReaders([tmp()], { knownClaudeIds: bad }),
      (e) => {
        assert.match(e.message, /^scanPortedReaders:/,
          `an ${typeof bad} got past the outer guard and was refused deeper in`);
        return true;
      });
  }
});

test("an EMPTY Set is accepted — it is an answer, not a missing argument", () => {
  // The distinction the guard exists to make: "no live sessions" is a fact,
  // "nobody passed the set" is a mistake, and defaulting the second to the
  // first is how every live session gets counted twice.
  return scanPortedReaders([tmp()], { knownClaudeIds: new Set() });
});
