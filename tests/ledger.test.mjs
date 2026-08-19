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

// ── null-scanner sentinel tests ───────────────────────────────────────────────
// These tests enforce the discipline: a value meaning "I do not know" (null
// scanner version) must not behave like a value.  Two unhashable rows must
// never field-wise-max into each other, must not merge with real-hash rows, and
// must not merge with pre-versioning rows.

test("null-scanner (a): two rows for same session that both failed to hash do NOT field-wise-max", () => {
  // Two separate record() calls with null scannerVersion simulate two machines
  // (or two runs) that both failed to compute the scanner hash.  Each call gets
  // its own unique unhashable-<uuid> sentinel, so they land in different rank
  // buckets and the LAST-SEEN one wins rather than their numbers being maxed.
  const home = tmp();
  // First failed-hash scan: inflated count 9000
  record([makeSession({ session_id: "s1", total: 9000,
    tokens: { input_tokens: 9000, cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0, output_tokens: 0 } })],
    null, home);
  // Second failed-hash scan: lower count 1000 (the "real" number after the bug
  // was fixed in the source, but the hash still can't be computed)
  record([makeSession({ session_id: "s1", total: 1000,
    tokens: { input_tokens: 1000, cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0, output_tokens: 0 } })],
    null, home);
  const lt = lifetime(home);
  // The second unhashable sentinel is last-seen, so 1000 wins — NOT max(9000,1000).
  assert.equal(lt.total, 1000, `expected 1000 (last-seen sentinel wins) but got ${lt.total}`);
  rmSync(home, { recursive: true, force: true });
});

test("null-scanner (b): a row that failed to hash does NOT merge with a real-hash row", () => {
  const home = tmp();
  // Real-hash scan first: count 5000
  record([makeSession({ session_id: "s1", total: 5000,
    tokens: { input_tokens: 5000, cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0, output_tokens: 0 } })],
    "sha256-abc123def456", home);
  // Failed-hash scan second: count 9999
  record([makeSession({ session_id: "s1", total: 9999,
    tokens: { input_tokens: 9999, cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0, output_tokens: 0 } })],
    null, home);
  const lt = lifetime(home);
  // The unhashable sentinel is last-seen, so its 9999 is what lifetime returns.
  // The critical assertion: the two rows are in DIFFERENT buckets — they were
  // NOT maxed together.  We verify by checking the rows directly.
  const r = rows(home);
  assert.equal(r.length, 2, "expected exactly 2 rows");
  const scanners = r.map(row => row.scanner);
  assert.ok(scanners.includes("sha256-abc123def456"), "real-hash row must be present");
  assert.ok(scanners.some(s => s.startsWith("unhashable-")), "unhashable row must be present");
  // They must carry different scanner tags (different buckets)
  assert.notEqual(scanners[0], scanners[1], "real-hash and unhashable must have different scanner tags");
  rmSync(home, { recursive: true, force: true });
});

test("null-scanner (c): a row that failed to hash does NOT merge with a pre-versioning row", () => {
  // A pre-versioning row has no scanner field (written before versioning existed).
  // It maps to the "pre-versioning" sentinel in lifetime().
  // A null-scanner row must NOT collapse into that same bucket.
  const home = tmp();
  // Write a pre-versioning row directly (no scanner field) — writeFileSync is
  // already imported at the top of this file.
  const lp = ledgerPath(home);
  writeFileSync(lp,
    JSON.stringify({ cli: "claude", session_id: "s1", total: 8000,
      input_tokens: 8000, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0, output_tokens: 0 }) + "\n");
  // Now record with null scannerVersion — must get its own unique sentinel
  record([makeSession({ session_id: "s1", total: 200,
    tokens: { input_tokens: 200, cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0, output_tokens: 0 } })],
    null, home);
  const r = rows(home);
  assert.equal(r.length, 2, "expected exactly 2 rows");
  const scanners = r.map(row => row.scanner);
  // Pre-versioning row has scanner === undefined (absent in JSON → undefined in JS)
  assert.ok(scanners[0] === undefined || scanners[0] === null,
    "first row must be pre-versioning (no scanner field)");
  assert.ok(scanners[1]?.startsWith("unhashable-"),
    "second row must carry an unhashable-<uuid> sentinel");
  rmSync(home, { recursive: true, force: true });
});

test("null-scanner (d): same real hash — field-wise-max unchanged (existing behaviour)", () => {
  // Two observations from the SAME real scanner hash — this is a re-scan after
  // more turns.  The higher number per field must still win (correct, deliberate).
  const home = tmp();
  const REAL_HASH = "sha256-deadbeef1234567890";
  record([makeSession({ session_id: "s1", total: 800,
    tokens: { input_tokens: 600, cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0, output_tokens: 200 } })],
    REAL_HASH, home);
  record([makeSession({ session_id: "s1", total: 1200,
    tokens: { input_tokens: 900, cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0, output_tokens: 300 } })],
    REAL_HASH, home);
  const lt = lifetime(home);
  // Both rows share the same real hash → same rank → field-wise max → 1200
  assert.equal(lt.total, 1200,
    `expected field-wise-max of 1200 for same real hash, got ${lt.total}`);
  rmSync(home, { recursive: true, force: true });
});

test("null-scanner (e): record() called 3 times with null and same session appends ONE row, not three", () => {
  // Regression: the original fix used randomUUID() per call, making every call
  // look like a new version that had never been recorded.  result: appended=1,1,1
  // and the file grew without bound.  The correct behaviour: first call writes,
  // subsequent calls with the same total are unchanged.
  const home = tmp();
  const sess = makeSession({ session_id: "s-repeat", total: 1000,
    tokens: { input_tokens: 1000, cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0, output_tokens: 0 } });

  const r1 = record([sess], null, home);
  const r2 = record([sess], null, home);
  const r3 = record([sess], null, home);

  assert.equal(r1.appended, 1, "first call must append");
  assert.equal(r1.unchanged, 0);
  assert.equal(r2.appended, 0, "second call must not append (same total)");
  assert.equal(r2.unchanged, 1);
  assert.equal(r3.appended, 0, "third call must not append (same total)");
  assert.equal(r3.unchanged, 1);
  assert.equal(rows(home).length, 1, "file must contain exactly one row");
  rmSync(home, { recursive: true, force: true });
});

test("null-scanner (f): null, real-hash, null — three distinct observations, no field-wise-max between null runs", () => {
  // Three interleaved records: first null (total 1000), a real-hash run
  // (total 2000), then a second null with a DIFFERENT total (1500, simulating
  // more turns discovered by a machine that cannot hash).  All three must land
  // as separate rows; the two null rows must NOT field-wise-max together.
  const home = tmp();
  const REAL_HASH = "sha256-realversion001";

  const r1 = record([makeSession({ session_id: "sf", total: 1000,
    tokens: { input_tokens: 1000, cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0, output_tokens: 0 } })],
    null, home);
  const r2 = record([makeSession({ session_id: "sf", total: 2000,
    tokens: { input_tokens: 2000, cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0, output_tokens: 0 } })],
    REAL_HASH, home);
  const r3 = record([makeSession({ session_id: "sf", total: 1500,
    tokens: { input_tokens: 1500, cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0, output_tokens: 0 } })],
    null, home);

  assert.equal(r1.appended, 1);
  assert.equal(r2.appended, 1);
  assert.equal(r3.appended, 1, "second null with different total must be appended");

  const allRows = rows(home);
  assert.equal(allRows.length, 3, "all three observations must be distinct rows");

  const scanners = allRows.map(row => row.scanner);
  // First null row: unhashable-<uuid>
  assert.ok(scanners[0].startsWith("unhashable-"), "first row must be an unhashable sentinel");
  // Real-hash row
  assert.equal(scanners[1], REAL_HASH, "second row must carry the real hash");
  // Second null row: a DIFFERENT unhashable-<uuid>
  assert.ok(scanners[2].startsWith("unhashable-"), "third row must be an unhashable sentinel");
  assert.notEqual(scanners[0], scanners[2], "the two null rows must have DIFFERENT sentinel tags");

  // lifetime() must not merge the two unhashable rows — last-seen wins
  const lt = lifetime(home);
  // The second null row (total 1500) is last-seen, so it beats the first (1000).
  // The real-hash row (2000) is at index 1, null-uuid2 is at index 2 → higher rank.
  assert.equal(lt.total, 1500,
    `expected 1500 (last null row wins over earlier null, real-hash is older), got ${lt.total}`);
  rmSync(home, { recursive: true, force: true });
});

// ── the conditional in lifetime()'s docstring ────────────────────────────────
// src/ledger.mjs used to promise, flat: "Among all rows from that version, take
// the field-wise maximum so a partial write cannot shrink a session." The max
// is real, but only among rows that SHARE a scanner tag. Rows whose scanner
// version could not be determined are tagged unhashable-<uuid>, fresh per row,
// so they share a bucket with nothing and are SUPERSEDED, never maxed — the
// deliberate trade that stops a corrected over-count from freezing forever.
//
// This pins both halves in one test, with the SAME two numbers in the SAME
// order, so the only thing that differs is whether the version was knowable:
// 9000 then 1000 → 9000 when the tag is known, 1000 when it is not.
//
// Instruments differ on purpose. Half 1 writes rows directly, because the claim
// under test is lifetime()'s merge branch and record() would refuse the lower
// second row before it ever got there. Half 2 goes through record(), because
// record() is the only producer of unknown-version tags and the guarantee is
// worthless if it stops holding end-to-end.
test("lifetime: max WITHIN one known scanner tag, supersede ACROSS unknown ones", () => {
  // Half 1 — one known tag, two observations. The higher survives: the floor.
  const known = tmp();
  writeFileSync(ledgerPath(known), [
    JSON.stringify({ cli: "claude", session_id: "s1", total: 9000,
      input_tokens: 9000, scanner: "sha256-known-version" }),
    JSON.stringify({ cli: "claude", session_id: "s1", total: 1000,
      input_tokens: 1000, scanner: "sha256-known-version" }),
  ].join("\n") + "\n");
  const ltKnown = lifetime(known);
  assert.equal(ltKnown.total, 9000,
    `same scanner tag must MAX (a partial write cannot shrink a session): expected 9000, got ${ltKnown.total}`);
  assert.equal(ltKnown.sessions, 1, "one (cli, session_id) pair is one session");
  rmSync(known, { recursive: true, force: true });

  // Half 1, other order. Both orders are needed or the pin does not bite:
  // descending alone still reads 9000 if the merge branch is deleted outright
  // (the first row simply stays), so ascending is what proves a MAX happened
  // and descending is what proves it was not a supersede.
  const knownAsc = tmp();
  writeFileSync(ledgerPath(knownAsc), [
    JSON.stringify({ cli: "claude", session_id: "s1", total: 1000,
      input_tokens: 1000, scanner: "sha256-known-version" }),
    JSON.stringify({ cli: "claude", session_id: "s1", total: 9000,
      input_tokens: 9000, scanner: "sha256-known-version" }),
  ].join("\n") + "\n");
  assert.equal(lifetime(knownAsc).total, 9000,
    "same scanner tag, ascending: the re-scan that saw more must win");
  rmSync(knownAsc, { recursive: true, force: true });

  // Half 2 — same numbers, same order, but neither scan could name its version.
  const unknown = tmp();
  record([makeSession({ session_id: "s1", total: 9000,
    tokens: { input_tokens: 9000, cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0, output_tokens: 0 } })],
    null, unknown);
  record([makeSession({ session_id: "s1", total: 1000,
    tokens: { input_tokens: 1000, cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0, output_tokens: 0 } })],
    null, unknown);

  const r = rows(unknown);
  assert.equal(r.length, 2, "both observations must be on disk — nothing is overwritten");
  assert.ok(r.every(row => typeof row.scanner === "string" && row.scanner.startsWith("unhashable-")),
    `unknown-version rows must carry an unhashable-<uuid> tag, got ${JSON.stringify(r.map(x => x.scanner))}`);
  assert.notEqual(r[0].scanner, r[1].scanner,
    "the tags must differ, or the two rows would share a rank bucket and be maxed");

  const ltUnknown = lifetime(unknown);
  assert.equal(ltUnknown.total, 1000,
    `unknown scanner tags must SUPERSEDE, not max: expected the newest observation 1000, got ${ltUnknown.total}` +
    " — 9000 here would mean a correction can never lower a number again");
  assert.equal(ltUnknown.sessions, 1, "still one session, however many rows describe it");
  rmSync(unknown, { recursive: true, force: true });
});
