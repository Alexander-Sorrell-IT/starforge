// tests/conformance.test.mjs — starreckon against hand-authored numbers.
//
// WHY THIS IS NOT LIKE THE OTHER 600 TESTS
//
// Everything else in this suite asks whether starreckon is self-consistent.
// This asks whether it is RIGHT, against a tree a person built and totals a
// person worked out with a pencil — tests/conformance/EXPECTED.json carries the
// arithmetic beside every figure so it can be re-checked without running
// anything.
//
// The identical fixture and the identical EXPECTED.json live in deadreckon's
// repository, where its Python readers are held to the same numbers. That is
// the point of it: two programs, two languages, one set of literals that
// neither of them produced. Two ports can drift into agreeing with each other
// — five sum-preserving corruptions already passed 22 self-consistency checks
// in this project's history — and a shared, hand-authored oracle is the only
// thing that can tell them both they are wrong.
//
// IF A NUMBER HERE FAILS, THE CODE IS WRONG UNTIL SOMEBODY RE-DERIVES THE
// ARITHMETIC BY HAND. Editing EXPECTED.json to match the output converts this
// file into an expensive way of asserting that the code does what the code
// does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { emptyStats, parseCodexFile, parseClaudeFile } from "../src/scan.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "conformance");
const HOME = join(FIX, "home");
const EXPECTED = JSON.parse(readFileSync(join(FIX, "EXPECTED.json"), "utf-8"));

// The same bytes as deadreckon's copy. Two repositories cannot see each
// other's checkouts, so each pins the digest it was built against: an edit to
// either copy breaks its own repo's test and the divergence is caught where it
// happened, instead of surfacing later as two programs that quietly stopped
// being held to the same numbers.
const EXPECTED_SHA256 =
  "d05b874ee52d494edb262275dcb45e7c125ec39927d472c25d64abacc2d8dbbc";

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

async function scanCodex() {
  const stats = emptyStats();
  const base = join(HOME, ".codex", "sessions");
  for (const f of walk(base).filter(p => p.endsWith(".jsonl")).sort()) {
    await parseCodexFile(f, stats);
  }
  return stats;
}

test("the fixture is the same one deadreckon is held to", () => {
  const sha = createHash("sha256")
    .update(readFileSync(join(FIX, "EXPECTED.json")))
    .digest("hex");
  assert.equal(sha, EXPECTED_SHA256,
    "tests/conformance/EXPECTED.json has changed. If that was deliberate, "
    + "update deadreckon's copy in the same change and re-pin both — the whole "
    + "value of this fixture is that both programs answer to one set of "
    + "hand-derived numbers.");
});

test("EXPECTED.json states its arithmetic, so it can be checked by hand", () => {
  for (const name of ["codex-simple", "codex-fork", "codex-reset"]) {
    assert.ok(EXPECTED.codex[name]._arithmetic,
      `${name} must carry the working that produced its numbers`);
  }
  assert.ok(EXPECTED.claude["claude-1"]._arithmetic);
});

// ── codex ─────────────────────────────────────────────────────────────────────

test("codex: an ordinary session, with a re-emitted turn counted once", async () => {
  const stats = await scanCodex();
  const e = EXPECTED.codex["codex-simple"];
  const s = stats.sessions.get("codex-simple");
  assert.ok(s, "session_meta id should key the session");
  assert.equal(s.tok.in, e.input_tokens);
  assert.equal(s.tok.cr, e.cache_read_input_tokens);
  assert.equal(s.tok.out, e.output_tokens);
});

// THE ONE THAT MIS-COUNTED 1,021,379,811 TOKENS. This file's first record already
// carries an inherited 1000/500/100 spent by its parent session. Assigning the
// final total whole counts that prefix again in every fork — ten siblings
// sharing one prefix counted it ten times on the real corpus.
test("codex: a fork does not re-count its inherited prefix", async () => {
  const stats = await scanCodex();
  const e = EXPECTED.codex["codex-fork"];
  const s = stats.sessions.get("codex-fork");
  assert.ok(s);
  assert.equal(s.tok.in, e.input_tokens,
    "1155 instead of 55 means the inherited base is being counted again");
  assert.equal(s.tok.cr, e.cache_read_input_tokens);
  assert.equal(s.tok.out, e.output_tokens);
});

// THE OPPOSITE-SIGNED FAILURE. Subtracting an inherited base and stopping there
// silently drops everything before a mid-stream reset. Both files have to be
// here: no single-direction assertion catches an over-count and an under-count
// at the same time.
test("codex: a mid-stream reset keeps the segment before it", async () => {
  const stats = await scanCodex();
  const e = EXPECTED.codex["codex-reset"];
  const s = stats.sessions.get("codex-reset");
  assert.ok(s);
  assert.equal(s.tok.in, e.input_tokens,
    "11 instead of 90 means the pre-reset segment was dropped");
  assert.equal(s.tok.cr, e.cache_read_input_tokens);
  assert.equal(s.tok.out, e.output_tokens);
});

test("codex: the fixture totals to its hand-computed figure", async () => {
  const stats = await scanCodex();
  const e = EXPECTED.codex._all;
  let i = 0, o = 0, c = 0;
  for (const s of stats.sessions.values()) { i += s.tok.in; o += s.tok.out; c += s.tok.cr; }
  assert.equal(stats.sessions.size, e.sessions);
  assert.equal(i, e.input_tokens);
  assert.equal(c, e.cache_read_input_tokens);
  assert.equal(o, e.output_tokens);
  assert.equal(i + c + o, e.total);
});

// ── claude ────────────────────────────────────────────────────────────────────

// One session written across two files, the way a resume writes it. m1 appears
// twice with smaller numbers the second time (the maximum must win, not the
// last write); m2 appears in both files (one turn, counted once); m3 is new in
// the second file and must still count.
test("claude: dedup on message.id holds across files, crediting the maximum", async () => {
  const stats = emptyStats();
  const proj = join(HOME, ".claude", "projects", "w-alpha");
  for (const f of readdirSync(proj).sort()) {
    await parseClaudeFile(join(proj, f), stats);
  }
  const e = EXPECTED.claude["claude-1"];
  const s = stats.sessions.get("claude-1");
  assert.ok(s, "both files carry sessionId claude-1 — they are one session");
  assert.equal(s.tok.in, e.input_tokens,
    "58 means no dedup at all; 28 means last-write-wins instead of maximum");
  assert.equal(s.tok.cw, e.cache_creation_input_tokens);
  assert.equal(s.tok.cr, e.cache_read_input_tokens);
  assert.equal(s.tok.out, e.output_tokens);
});

// ── the three states ──────────────────────────────────────────────────────────

// Present-and-empty and absent both sum to zero. That is precisely why the
// number cannot be the answer, and why the fixture asserts the tree instead:
// this project has shipped that confusion seven times in four disguises.
test("presence: an empty store exists and is not the same fact as an absent one", () => {
  assert.equal(EXPECTED.presence.gemini.state, "present-and-empty");
  assert.ok(existsSync(join(HOME, ".gemini", "tmp")),
    "the empty-store case must actually exist, or nothing is being tested");

  assert.equal(EXPECTED.presence.grok.state, "absent");
  assert.ok(!existsSync(join(HOME, ".grok")),
    "the absent-store case must actually be absent");
});

test("the codex session identity difference is recorded, not silently tolerated", () => {
  // deadreckon names a codex session after the rollout FILENAME; starreckon
  // reads payload.id from session_meta. Totals agree, session NAMES do not, so
  // a cross-program comparison keyed on ids cannot succeed. Written down in
  // the fixture so it is a known difference rather than a future afternoon.
  assert.ok(EXPECTED.codex._identity_note,
    "EXPECTED.json must keep the note explaining why the two programs' codex "
    + "session ids differ");
});

// ── the readers starreckon was missing ────────────────────────────────────────
//
// Ported from deadreckon against a written spec. They are held to the literals
// in EXPECTED.json AND, separately, they were run against the real store on the
// machine they were ported on and matched deadreckon session-for-session and
// bucket-for-bucket: orphans 78/4,172,332,033 · clawspring 18/258,502,806 ·
// lmstudio 7/119,774 · bob 2/38,783,298. The fixture is what keeps that true.

import {
  readClaudeOrphans, readClawspring, readLmstudio, readBob,
} from "../src/readers.mjs";

// THE BIG ONE: 4,172,332,033 tokens on the real machine that nothing else in
// either program can see, because the transcripts were deleted and only the
// counters survived.
test("orphans: copies of one session merge by MAXIMUM, never by sum", () => {
  const e = EXPECTED.claude_orphans._all;
  const r = readClaudeOrphans(HOME, new Set(["claude-1"]));
  assert.equal(r.state, "counted");
  assert.equal(r.sessions.length, e.sessions);
  assert.equal(r.tokens.input, e.input_tokens,
    "orph-1 is in three config files; summing them is the 182x bug in miniature");
  assert.equal(r.tokens.cacheWrite, e.cache_creation_input_tokens);
  assert.equal(r.tokens.cacheRead, e.cache_read_input_tokens);
  assert.equal(r.tokens.output, e.output_tokens);
  assert.equal(r.total, e.total);
});

// lastModelUsage restates lastTotal* field for field. Every entry in the
// fixture carries it, so a reader that adds both reports exactly double.
test("orphans: lastModelUsage is not added on top of lastTotal*", () => {
  const r = readClaudeOrphans(HOME, new Set(["claude-1"]));
  assert.equal(r.total, EXPECTED.claude_orphans._all.total,
    `${EXPECTED.claude_orphans._all.total * 2} would mean lastModelUsage was counted too`);
});

test("orphans: a live session is excluded, and a zero counter is not a session", () => {
  const r = readClaudeOrphans(HOME, new Set(["claude-1"]));
  const ids = r.sessions.map(s => s.id).sort();
  assert.deepEqual(ids, ["orph-1", "orph-2"]);
  assert.ok(!ids.includes("claude-1"), "its transcript is alive — counting it doubles it");
  assert.ok(!ids.includes("orph-zero"), "all four counters are 0");
});

// Forgetting the exclusion set is the mistake that silently doubles every live
// session, so it throws rather than defaulting to empty.
test("orphans: refuses to run without the set of live session ids", () => {
  assert.throws(() => readClaudeOrphans(HOME), /must be the Set/);
});

test("orphans: a vanished session is never given a date", () => {
  const r = readClaudeOrphans(HOME, new Set(["claude-1"]));
  for (const s of r.sessions) {
    assert.equal(s.start, null, "no transcript means no turn to take a date from");
    assert.equal(s.transcript, false);
  }
});

// This one moves the session COUNT and not the sum, so no sum-based check can
// see it — it is how the first port read 20 sessions against deadreckon's 18
// while both totalled 258,502,806.
test("clawspring: a rollup recording nothing is not a session", () => {
  const e = EXPECTED.clawspring._all;
  const r = readClawspring(HOME);
  assert.equal(r.sessions.length, e.sessions, "3 would mean cs-empty was emitted");
  assert.equal(r.total, e.total);
  assert.equal(r.tokens.cacheRead, 0, "the format has no cache counters at all");
});

test("lmstudio: counters are read from the exact documented path", () => {
  const e = EXPECTED.lmstudio._all;
  const r = readLmstudio(HOME);
  assert.equal(r.sessions.length, e.sessions);
  assert.equal(r.tokens.input, e.input_tokens);
  assert.equal(r.tokens.output, e.output_tokens);
  assert.equal(r.sessions[0].billed, false,
    "a local model ran on this machine and never went through a provider "
    + "account — a fact about where it ran, not about money");
});

// FOUR STATES, NOT TWO. absent, empty and unreadable all total zero, and they
// are three different facts about the machine.
test("readers: an absent store says absent, not zero", async () => {
  assert.equal(readClawspring(join(HOME, "nope")).state, "absent");
  assert.equal(readLmstudio(join(HOME, "nope")).state, "absent");
  assert.equal((await readBob(join(HOME, "nope"))).state, "absent");
  assert.equal(readClaudeOrphans(join(HOME, "nope"), new Set()).state, "absent");
});

test("bob: the fixture has no store, and an unsupported Node must not read as zero", async () => {
  assert.equal(EXPECTED.presence.bob.state, "absent");
  const r = await readBob(HOME);
  assert.equal(r.state, "absent");
  assert.equal(r.total, 0);
  // The point of the `unreadable` state: on Node < 22.5 the sqlite builtin is
  // missing, and a present store that cannot be opened must never be reported
  // as an unused tool.
  assert.ok(EXPECTED.presence.bob.why.includes("unreadable"));
});
