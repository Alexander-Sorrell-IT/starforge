// @ts-nocheck
// A session counted in one figure and invisible in another, with nothing on
// screen saying so.
//
// finalize() files every session into the month it STARTED in — but only
// `if (isFinite(s.firstTs))`. A session with no usable date still counts in
// total_sessions and still adds its tokens to the grand totals; it lands in no
// monthly bucket, so it is in no month's star, no snapshot and no lifetime
// figure derived from the timeline. The same hole exists one layer out: the
// ported readers emit sessions with `start: null` on purpose (a vanished
// session has no turn to take a date from), and those carry real tokens into
// the every-CLI total and into no month at all.
//
// Neither hole was reported anywhere. These tests fix the count in place, and
// the invariant test is the one that matters: total_sessions is exactly the
// dated sessions plus the undated ones, so the two views can be reconciled by
// anyone holding the report instead of by reading this file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { emptyStats, finalize } from "../src/scan.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = () => mkdtempSync(join(tmpdir(), "sr-undated-"));

// A session as scan.mjs builds one, with only the fields finalize() reads.
function sess(firstTs) {
  const s = {
    firstTs,
    lastTs: firstTs,
    minutes: new Set(Number.isFinite(firstTs) ? [Math.floor(firstTs / 60000)] : []),
    project: "alpha",
    models: new Map([["claude-opus-5", 1]]),
    tok: { in: 100, out: 50, cr: 10, cw: 5 },
    tools: 3,
    exts: new Map(),
    hours: new Array(24).fill(0),
    days: new Set(),
    sources: new Set(["claude"]),
    idFromRow: true,
  };
  if (Number.isFinite(firstTs)) {
    const d = new Date(firstTs);
    s.hours[d.getHours()] = 1;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    s.days.add(key);
  }
  return s;
}

test("finalize counts the sessions it could not date", () => {
  const stats = emptyStats();
  stats.sessions.set("dated-1", sess(Date.parse("2026-03-04T14:00:00.000Z")));
  stats.sessions.set("dated-2", sess(Date.parse("2026-03-05T14:00:00.000Z")));
  stats.sessions.set("undated-1", sess(NaN));
  const agg = finalize(stats);
  assert.equal(agg.total_sessions, 3);
  assert.equal(agg.undated_sessions, 1, "one session had no usable start and must be reported as one");
});

test("total_sessions reconciles: dated months + undated = the headline", () => {
  // This is the property the number exists for. A reader holding only the
  // report can check it; without the field the difference has no name and
  // looks like an arithmetic bug in the tool.
  for (const undated of [0, 1, 4]) {
    const stats = emptyStats();
    for (let i = 0; i < 5; i++)
      stats.sessions.set(`d${i}`, sess(Date.parse(`2026-0${(i % 3) + 1}-04T14:00:00.000Z`)));
    for (let i = 0; i < undated; i++) stats.sessions.set(`u${i}`, sess(NaN));
    const agg = finalize(stats);
    const inMonths = agg.monthly_buckets.reduce((a, b) => a + b.sessions, 0);
    assert.equal(agg.undated_sessions, undated);
    assert.equal(
      agg.total_sessions,
      inMonths + agg.undated_sessions,
      `${undated} undated: ${agg.total_sessions} total vs ${inMonths} in months`
    );
  }
});

test("an undated session's tokens are in the totals and in no month", () => {
  const stats = emptyStats();
  stats.sessions.set("dated", sess(Date.parse("2026-03-04T14:00:00.000Z")));
  stats.sessions.set("undated", sess(NaN));
  const agg = finalize(stats);
  assert.equal(agg.total_input_tokens, 200, "both sessions' tokens are in the grand total");
  const monthIn = agg.monthly_buckets.reduce((a, b) => a + b.input_tokens, 0);
  assert.equal(monthIn, 100, "only the dated session reached a month");
  assert.ok(agg.undated_sessions > 0, "and the gap between them has a name");
});

// ---- end to end ------------------------------------------------------------

function corpus(home) {
  const dir = join(home, ".claude", "projects", "-w-alpha");
  mkdirSync(dir, { recursive: true });
  const ts = "2026-03-04T14:00:00.000Z";
  const rows = [
    { type: "user", cwd: "/w/alpha", timestamp: ts, uuid: "u-1",
      message: { role: "user", content: "hi" } },
    { type: "assistant", timestamp: ts, uuid: "a-1",
      message: { role: "assistant", model: "claude-opus-5",
        content: [{ type: "tool_use", name: "Bash" }],
        usage: { input_tokens: 10, output_tokens: 5,
          cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } } },
  ];
  writeFileSync(join(dir, "s.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n"));
  return home;
}

// Per-project counters for sessions whose transcripts are gone. readers.mjs
// gives these `start: null` deliberately — real tokens, no date, no month.
function orphans(home, n) {
  const projects = {};
  for (let i = 0; i < n; i++) {
    projects[`/w/gone-${i}`] = {
      lastSessionId: `orphan-${i}`,
      lastTotalInputTokens: 1000,
      lastTotalOutputTokens: 200,
      lastTotalCacheReadInputTokens: 0,
      lastTotalCacheCreationInputTokens: 0,
    };
  }
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ projects }));
  return home;
}

function run(home, args = []) {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "src", "cli.mjs"), "--yes", "--no-pace", "--no-wrapped", "--json", ...args],
    { encoding: "utf8", env: { ...process.env, HOME: home, NO_COLOR: "1" } }
  );
  return r.stdout + r.stderr;
}

test("the summary says how many sessions have no date, even when the answer is none", () => {
  // Zero is a MEASUREMENT here. Printing the line only when it is non-zero
  // makes "nothing is undated" indistinguishable from "this build never
  // looked", which is the defect this feature exists to end.
  const out = run(corpus(tmp()));
  const line = out.split("\n").find((l) => l.startsWith("undated"));
  assert.ok(line, `no undated line in the summary:\n${out}`);
  assert.match(line, /\b0\b/, `expected a zero count, got: ${line}`);
});

test("orphan sessions with no date are counted on screen and named as such", () => {
  const home = orphans(corpus(tmp()), 3);
  const out = run(home);
  const line = out.split("\n").find((l) => l.startsWith("undated"));
  assert.ok(line, `no undated line in the summary:\n${out}`);
  assert.match(line, /\b3\b/, `expected the 3 orphans to be counted, got: ${line}`);
  assert.match(line, /other CLIs/, `the line must say where they are, got: ${line}`);
});

test("--no-providers says the other CLIs were NOT scanned, rather than zero", () => {
  const home = orphans(corpus(tmp()), 3);
  const out = run(home, ["--no-providers"]);
  const line = out.split("\n").find((l) => l.startsWith("undated"));
  assert.ok(line, `no undated line in the summary:\n${out}`);
  assert.doesNotMatch(line, /\b3\b/, "the 3 orphans were not looked for; claiming them would be a lie");
  assert.match(line, /not scanned/, `absent must not read as zero, got: ${line}`);
});

test("the count reaches the machine-readable reports", () => {
  const home = corpus(tmp());
  run(home);
  const dir = join(home, ".starreckon", "reports");
  const files = readdirSync(dir);
  const base = JSON.parse(readFileSync(join(dir, files.find((n) => n.startsWith("baseline-"))), "utf8"));
  const exp = JSON.parse(readFileSync(join(dir, files.find((n) => n.startsWith("expanded-"))), "utf8"));
  assert.equal(typeof base.undated_sessions, "number",
    "baseline carries total_sessions and monthly_buckets; the difference between them needs a name in the same file");
  assert.equal(typeof exp.undated_sessions, "number");
  assert.equal(
    base.total_sessions,
    base.monthly_buckets.reduce((a, b) => a + b.sessions, 0) + base.undated_sessions,
    "baseline must reconcile against itself"
  );
});

// ---- the hole the first pass left ------------------------------------------
//
// TAKEN FROM BOB, with the premise measured first.
//
// Everything above counts a session that REACHED stats.sessions with no usable
// start. Both parsers drop a row whose timestamp will not parse before
// session() is ever called, so on the corpus side that count is structurally
// zero and the field says nothing about this machine.
//
// The row that was dropped is the interesting one. A transcript row can declare
// a sessionId, carry a full usage block, and have a timestamp that will not
// parse — a half-written line from a killed process, a clock that came back
// wrong. Today that row is discarded whole, tokens and all, and NOTHING says
// so: total_sessions does not count it, no month contains it, no error is
// printed. Measured before adopting this: a fabricated broken-clock row took
// 999,999 input tokens and an entire session out of the scan silently.
//
// The false-positive risk was measured too, because a number that reads
// non-zero for boring reasons is worse than no number. Over 246 real transcript
// files (132,614 rows, 131 distinct sessions): 22,281 rows do declare a
// sessionId with no usable timestamp — and every one of those sessions ALSO has
// dated rows, so ids appearing ONLY on undated rows came to 0, and none of the
// undated rows carried a usage block at all. This counts sessions, not rows,
// and a session with even one dated row is not undated.
test("a session whose every row has an unusable timestamp is counted, not discarded in silence", async () => {
  const { parseClaudeFile } = await import("../src/scan.mjs");
  const home = tmp();
  const dir = join(home, ".claude", "projects", "-w-alpha");
  mkdirSync(dir, { recursive: true });

  const good = [
    { type: "user", cwd: "/w/alpha", timestamp: "2026-03-04T14:00:00.000Z", uuid: "u1",
      message: { role: "user", content: "hi" } },
    { type: "assistant", timestamp: "2026-03-04T14:00:00.000Z", uuid: "a1",
      message: { role: "assistant", id: "m1", model: "claude-opus-5", content: [],
        usage: { input_tokens: 10, output_tokens: 5,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  ];
  // Same shape, real tokens, a timestamp that will not parse.
  const broken = [
    { type: "assistant", sessionId: "broken-clock-1", timestamp: "not-a-date", uuid: "a2",
      message: { role: "assistant", id: "m2", model: "claude-opus-5", content: [],
        usage: { input_tokens: 999999, output_tokens: 12345,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  ];
  writeFileSync(join(dir, "good.jsonl"), good.map((r) => JSON.stringify(r)).join("\n"));
  writeFileSync(join(dir, "broken.jsonl"), broken.map((r) => JSON.stringify(r)).join("\n"));

  const stats = emptyStats();
  await parseClaudeFile(join(dir, "good.jsonl"), stats, {});
  await parseClaudeFile(join(dir, "broken.jsonl"), stats, {});
  const agg = finalize(stats);

  assert.equal(agg.total_sessions, 1, "the broken row still cannot be dated, so it is not a dated session");
  assert.equal(agg.dropped_sessions, 1, "but it is no longer invisible");
  assert.equal(agg.total_input_tokens, 10, "its 999,999 tokens are still uncounted — undatable is not the same as recovered");
  // And it stays OUTSIDE the reconciliation, because it is in no total here.
  assert.equal(agg.undated_sessions, 0);
  assert.equal(
    agg.total_sessions,
    agg.monthly_buckets.reduce((a, b) => a + b.sessions, 0) + agg.undated_sessions,
    "a dropped session must not be added into the reconciliation it is not part of"
  );
});

test("a session with even ONE dated row is not undated", () => {
  // The guard against the number reading non-zero for boring reasons: real
  // transcripts are full of undated metadata rows that declare a sessionId,
  // and every one of those sessions has dated rows elsewhere in the file.
  const stats = emptyStats();
  stats.sessions.set("mixed", sess(Date.parse("2026-03-04T14:00:00.000Z")));
  stats.undatedSessions.add("mixed");
  const agg = finalize(stats);
  assert.equal(agg.dropped_sessions, 0);
  assert.equal(agg.undated_sessions, 0);
});

test("a dropped session is named on screen as dropped, not merely undated", () => {
  const home = corpus(tmp());
  const dir = join(home, ".claude", "projects", "-w-alpha");
  writeFileSync(join(dir, "broken.jsonl"), JSON.stringify(
    { type: "assistant", sessionId: "broken-clock-1", timestamp: "not-a-date", uuid: "a9",
      message: { role: "assistant", id: "m9", model: "claude-opus-5", content: [],
        usage: { input_tokens: 999999, output_tokens: 12345,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }));
  const out = run(home);
  const lines = out.split("\n");
  const i = lines.findIndex((l) => l.startsWith("undated"));
  assert.ok(i >= 0, `no undated line:\n${out}`);
  const block = lines.slice(i, i + 3).join("\n");
  assert.match(block, /dropped ENTIRELY/, `the dropped session must be named as such, got:\n${block}`);
  assert.match(block, /no total above/, "and must say its tokens are in no total");
});
