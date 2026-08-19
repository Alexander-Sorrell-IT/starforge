// tests/ledger.test.mjs — pure-logic tests for src/ledger.mjs
//
// All tests use temporary directories. No real ~/.starreckon is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  rows, lifetime, record, compare, ledgerPath, FIELDS,
} from "../src/ledger.mjs";

// ── helpers ───────────────────────────────────────────────────────────────────

function tmp() {
  const d = join(tmpdir(), "ledger-test-" + Math.floor(Math.random() * 1e9));
  mkdirSync(join(d, ".starreckon"), { recursive: true });
  return d;
}

function makeSession(overrides = {}) {
  return {
    cli: "claude",
    session_id: "sess-abc",
    total: 1000,
    tokens: {
      input_tokens: 600,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 200,
      output_tokens: 100,
    },
    start: "2026-07-01T10:00:00Z",
    model: "claude-opus-5",
    ...overrides,
  };
}

// ── rows() ────────────────────────────────────────────────────────────────────

test("rows returns [] for missing ledger file", () => {
  const home = tmp();
  assert.deepEqual(rows(home), []);
  rmSync(home, { recursive: true, force: true });
});

test("rows parses valid JSONL", () => {
  const home = tmp();
  const line = JSON.stringify({ cli: "claude", session_id: "s1", total: 100 });
  writeFileSync(ledgerPath(home), line + "\n");
  const r = rows(home);
  assert.equal(r.length, 1);
  assert.equal(r[0].total, 100);
  rmSync(home, { recursive: true, force: true });
});

test("rows skips malformed lines without crashing", () => {
  const home = tmp();
  writeFileSync(ledgerPath(home), [
    JSON.stringify({ cli: "claude", session_id: "s1", total: 100 }),
    "not valid json {{{{",
    JSON.stringify({ cli: "gemini", session_id: "s2", total: 200 }),
  ].join("\n") + "\n");
  const r = rows(home);
  assert.equal(r.length, 2);
  assert.equal(r[0].total, 100);
  assert.equal(r[1].total, 200);
  rmSync(home, { recursive: true, force: true });
});

test("rows handles empty file", () => {
  const home = tmp();
  writeFileSync(ledgerPath(home), "");
  assert.deepEqual(rows(home), []);
  rmSync(home, { recursive: true, force: true });
});

// ── lifetime() ───────────────────────────────────────────────────────────────

test("lifetime returns 0 for empty ledger", () => {
  const home = tmp();
  const lt = lifetime(home);
  assert.equal(lt.total, 0);
  assert.equal(lt.sessions, 0);
  rmSync(home, { recursive: true, force: true });
});

test("lifetime sums correctly across sessions", () => {
  const home = tmp();
  record([
    makeSession({ session_id: "s1", total: 1000 }),
    makeSession({ session_id: "s2", total: 2000 }),
    makeSession({ cli: "gemini", session_id: "g1", total: 500 }),
  ], "ver-a", home);
  const lt = lifetime(home);
  assert.equal(lt.total, 3500);
  assert.equal(lt.sessions, 3);
  assert.equal(lt.by_cli.claude, 3000);
  assert.equal(lt.by_cli.gemini, 500);
  rmSync(home, { recursive: true, force: true });
});

test("lifetime uses newest-scanner-version max rule", () => {
  // ver-a records 1000, ver-b (newer) records 800 — ver-b wins (it's the
  // newest scanner that saw this session, even though its number is lower).
  const home = tmp();
  // Simulate: first ver-a, then ver-b
  writeFileSync(ledgerPath(home), [
    JSON.stringify({ cli: "claude", session_id: "s1", total: 1000, scanner: "ver-a" }),
    JSON.stringify({ cli: "claude", session_id: "s1", total: 800, scanner: "ver-b" }),
  ].join("\n") + "\n");
  const lt = lifetime(home);
  // ver-b is last-seen, so 800 wins
  assert.equal(lt.total, 800);
  rmSync(home, { recursive: true, force: true });
});

test("lifetime: deleting a transcript cannot lower the total (old row stays)", () => {
  // Record with ver-a. Then 'transcript deleted' — record with ver-a again
  // but only 0 (nothing on disk). The old 1000 should still win because
  // we don't re-record a zero.
  const home = tmp();
  record([makeSession({ session_id: "s1", total: 1000 })], "ver-a", home);
  // Now the 'transcript is gone' so we record nothing for s1
  record([makeSession({ session_id: "s2", total: 500 })], "ver-a", home);
  const lt = lifetime(home);
  // s1 is still 1000 (we never wrote a zero for it)
  assert.ok(lt.total >= 1500, `expected >= 1500 but got ${lt.total}`);
  rmSync(home, { recursive: true, force: true });
});

test("lifetime: fixing the scanner lowers an inflated total", () => {
  // ver-a inflated: 10000. ver-b fixed: 800. ver-b is last, wins.
  const home = tmp();
  writeFileSync(ledgerPath(home), [
    JSON.stringify({ cli: "claude", session_id: "s1", total: 10000, scanner: "ver-a" }),
    JSON.stringify({ cli: "claude", session_id: "s1", total: 800, scanner: "ver-b" }),
  ].join("\n") + "\n");
  const lt = lifetime(home);
  assert.equal(lt.total, 800);
  rmSync(home, { recursive: true, force: true });
});

test("lifetime: same scanner version, take field-wise max", () => {
  // Two observations from the same scanner — the second is a re-scan after
  // more turns. The higher number per field should win.
  const home = tmp();
  writeFileSync(ledgerPath(home), [
    JSON.stringify({ cli: "claude", session_id: "s1", total: 800,
      input_tokens: 600, output_tokens: 200, scanner: "ver-a" }),
    JSON.stringify({ cli: "claude", session_id: "s1", total: 1200,
      input_tokens: 900, output_tokens: 300, scanner: "ver-a" }),
  ].join("\n") + "\n");
  const lt = lifetime(home);
  assert.equal(lt.total, 1200);
  rmSync(home, { recursive: true, force: true });
});

// ── record() ─────────────────────────────────────────────────────────────────

test("record on empty ledger creates the file and appends", () => {
  const home = tmp();
  const r = record([makeSession()], "ver-1", home);
  assert.equal(r.appended, 1);
  assert.equal(r.unchanged, 0);
  const r2 = rows(home);
  assert.equal(r2.length, 1);
  assert.equal(r2[0].session_id, "sess-abc");
  rmSync(home, { recursive: true, force: true });
});

test("record appends multiple sessions", () => {
  const home = tmp();
  const result = record([
    makeSession({ session_id: "s1" }),
    makeSession({ session_id: "s2" }),
    makeSession({ cli: "gemini", session_id: "g1" }),
  ], "ver-1", home);
  assert.equal(result.appended, 3);
  assert.equal(rows(home).length, 3);
  rmSync(home, { recursive: true, force: true });
});

test("record skips session already in ledger at same version with equal total", () => {
  const home = tmp();
  record([makeSession({ session_id: "s1", total: 1000 })], "ver-1", home);
  const r2 = record([makeSession({ session_id: "s1", total: 1000 })], "ver-1", home);
  assert.equal(r2.appended, 0);
  assert.equal(r2.unchanged, 1);
  assert.equal(rows(home).length, 1);
  rmSync(home, { recursive: true, force: true });
});

test("record appends when same session has higher total (more turns)", () => {
  const home = tmp();
  record([makeSession({ session_id: "s1", total: 1000 })], "ver-1", home);
  const r2 = record([makeSession({ session_id: "s1", total: 1500 })], "ver-1", home);
  assert.equal(r2.appended, 1);
  assert.equal(rows(home).length, 2);
  rmSync(home, { recursive: true, force: true });
});

test("record appends when newer scanner version sees same session", () => {
  const home = tmp();
  record([makeSession({ session_id: "s1", total: 1000 })], "ver-a", home);
  const r2 = record([makeSession({ session_id: "s1", total: 800 })], "ver-b", home);
  // Different scanner version — always record it
  assert.equal(r2.appended, 1);
  assert.equal(rows(home).length, 2);
  rmSync(home, { recursive: true, force: true });
});

test("record skips sessions with zero total", () => {
  const home = tmp();
  const result = record([
    makeSession({ session_id: "s1", total: 0, tokens: {} }),
  ], "ver-1", home);
  assert.equal(result.appended, 0);
  assert.equal(rows(home).length, 0);
  rmSync(home, { recursive: true, force: true });
});

test("record skips sessions missing cli or session_id", () => {
  const home = tmp();
  const result = record([
    { total: 1000, tokens: { input_tokens: 1000 } },             // no cli
    { cli: "claude", total: 1000, tokens: { input_tokens: 1000 } }, // no session_id
  ], "ver-1", home);
  assert.equal(result.appended, 0);
  rmSync(home, { recursive: true, force: true });
});

test("record stores all four token fields", () => {
  const home = tmp();
  record([makeSession()], "ver-1", home);
  const r = rows(home)[0];
  assert.equal(r.input_tokens, 600);
  assert.equal(r.cache_creation_input_tokens, 100);
  assert.equal(r.cache_read_input_tokens, 200);
  assert.equal(r.output_tokens, 100);
  rmSync(home, { recursive: true, force: true });
});

test("record handles empty sessions array", () => {
  const home = tmp();
  const result = record([], "ver-1", home);
  assert.equal(result.appended, 0);
  assert.equal(result.unchanged, 0);
  rmSync(home, { recursive: true, force: true });
});

// ── compare() ────────────────────────────────────────────────────────────────

test("compare returns zero totals when ledger is empty and no sessions", () => {
  const home = tmp();
  const c = compare([], home);
  assert.equal(c.ledger_total, 0);
  assert.equal(c.disk_total, 0);
  assert.equal(c.ledger_only, 0);
  assert.equal(c.sessions_on_disk, 0);
  rmSync(home, { recursive: true, force: true });
});

test("compare correctly identifies ledger-only sessions (transcripts deleted)", () => {
  const home = tmp();
  // Record two sessions
  record([
    makeSession({ session_id: "s1", total: 1000 }),
    makeSession({ session_id: "s2", total: 2000 }),
  ], "ver-1", home);
  // Now only s1 is 'on disk'
  const c = compare([makeSession({ session_id: "s1", total: 1000 })], home);
  assert.equal(c.ledger_only, 1); // s2 is gone from disk
  assert.equal(c.both, 1);        // s1 is in both
  assert.equal(c.sessions_on_disk, 1);
  rmSync(home, { recursive: true, force: true });
});

test("compare disk_total sums current on-disk sessions", () => {
  const home = tmp();
  record([makeSession({ session_id: "s1", total: 1000 })], "ver-1", home);
  const c = compare([
    makeSession({ session_id: "s1", total: 1000 }),
    makeSession({ session_id: "s2", total: 500 }),
  ], home);
  assert.equal(c.disk_total, 1500);
  rmSync(home, { recursive: true, force: true });
});

// ── lifetime() by_cli_marked — the display code in cli.mjs iterates this ─────

test("lifetime by_cli_marked carries marker per cli", () => {
  const home = tmp();
  record([
    makeSession({ cli: "claude",  session_id: "c1", total: 1000 }),
    makeSession({ cli: "gemini",  session_id: "g1", total: 500 }),
  ], "ver-1", home);
  const lt = lifetime(home);
  // "claude" has a native lifetime counter → ★; others → †
  assert.equal(lt.by_cli_marked.claude.marker, "★");
  assert.equal(lt.by_cli_marked.gemini.marker, "†");
  assert.equal(lt.by_cli_marked.claude.total, 1000);
  assert.equal(lt.by_cli_marked.gemini.total, 500);
  // The cli.mjs display code: Object.entries(lt.by_cli_marked).sort(...)
  // must not throw on a multi-cli result.
  const byCli = Object.entries(lt.by_cli_marked)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([cli, v]) => `${cli}${v.marker} ${v.total}`)
    .join(", ");
  assert.ok(byCli.includes("claude★"));
  assert.ok(byCli.includes("gemini†"));
  rmSync(home, { recursive: true, force: true });
});
