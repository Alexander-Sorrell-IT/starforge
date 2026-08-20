// finalize aggregates sessions into monthly buckets, and nothing checked that a
// bucket equals the sum of the sessions in it.
//
// The first mutation run over scan.mjs left 625 survivors, and 20 of the ones
// that can change a NUMBER are in this function — every accumulation in it:
//
//     durationMs += dur          b.out   += s.tok.out
//     b.durationMs += dur        b.cache += s.tok.cr + s.tok.cw
//     b.tools += s.tools         b.hours[h] += s.hours[h]
//     undatedTok += ...          total_duration_hours: durationMs / 3.6e6
//
// `+=` becoming `-=` survives on all of them. The suite had plenty of tests
// that finalize RUNS; none that its arithmetic ADDS.
//
// The check is a conservation law, not a fixture: whatever sessions go in, the
// buckets that come out must account for exactly them. That kills every one of
// those mutants at once and keeps killing them when the code is rewritten.
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyStats, finalize } from "../src/scan.mjs";

function mkSession(stats, id, { month = "03", day = "05", hour = 10,
                                tok = [100, 20, 5, 3], tools = 2,
                                minutes = 3, project = "p" } = {}) {
  const ts = Date.parse(`2026-${month}-${day}T${String(hour).padStart(2, "0")}:00:00Z`);
  const s = {
    firstTs: ts, lastTs: ts + minutes * 60_000,
    minutes: new Set(Array.from({ length: minutes }, (_, i) => Math.floor(ts / 60000) + i)),
    project, models: new Map([["claude-opus-4-6", 1]]),
    tok: { in: tok[0], out: tok[1], cr: tok[2], cw: tok[3] },
    tools, exts: new Map([["mjs", 1]]),
    hours: new Array(24).fill(0), days: new Set([`2026-${month}-${day}`]),
    sources: new Set(["claude_code"]), idFromRow: true,
  };
  s.hours[new Date(ts).getHours()] = 1;
  stats.sessions.set(id, s);
  return s;
}

// `monthly_buckets`, read off a real return value. The first version of this
// helper guessed four other names and found none of them, then reported "no
// monthly buckets" — a test failing because it was looking in the wrong place,
// which reads exactly like a program that produces nothing.
const bucketsOf = (out) => out.monthly_buckets;

test("the monthly buckets account for exactly the sessions that went in", () => {
  const stats = emptyStats();
  const made = [
    mkSession(stats, "a", { month: "03", tok: [100, 20, 5, 3], tools: 2 }),
    mkSession(stats, "b", { month: "03", tok: [700, 40, 11, 9], tools: 5 }),
    mkSession(stats, "c", { month: "04", tok: [10, 1, 0, 0], tools: 1 }),
  ];
  const out = finalize(stats);
  const buckets = bucketsOf(out);
  assert.ok(buckets && buckets.length, `no monthly buckets in ${Object.keys(out ?? {})}`);

  const sum = (f) => made.reduce((a, s) => a + f(s), 0);
  const bsum = (f) => buckets.reduce((a, b) => a + (f(b) ?? 0), 0);

  assert.equal(bsum((b) => b.input_tokens), sum((s) => s.tok.in), "input across buckets");
  assert.equal(bsum((b) => b.output_tokens), sum((s) => s.tok.out), "output across buckets");
  assert.equal(bsum((b) => b.cache_tokens), sum((s) => s.tok.cr + s.tok.cw),
    "cache across buckets — cr and cw must BOTH land");
  assert.equal(bsum((b) => b.tool_calls), sum((s) => s.tools), "tool calls across buckets");
  assert.equal(bsum((b) => b.sessions), made.length, "session count across buckets");
});

test("two months are two buckets, and neither takes the other's tokens", () => {
  const stats = emptyStats();
  mkSession(stats, "march", { month: "03", tok: [1000, 0, 0, 0] });
  mkSession(stats, "april", { month: "04", tok: [7, 0, 0, 0] });
  const buckets = bucketsOf(finalize(stats));
  assert.equal(buckets.length, 2);
  const ins = buckets.map((b) => b.input_tokens).sort((a, b) => a - b);
  assert.deepEqual(ins, [7, 1000], "a month's tokens moved to another month");
});

test("the hour histogram is summed, not overwritten", () => {
  // b.hours[h] += s.hours[h] — two sessions in the same hour of the same month
  // must read 2, and an `=` here reads 1 while every total still balances.
  const stats = emptyStats();
  mkSession(stats, "x", { month: "03", hour: 14 });
  mkSession(stats, "y", { month: "03", hour: 14 });
  const b = bucketsOf(finalize(stats))[0];
  assert.ok(Array.isArray(b.hour_buckets), "no hour histogram on the bucket");
  assert.equal(b.hour_buckets.reduce((a, n) => a + n, 0), 2,
    "two sessions in one hour did not both land");
});

test("duration is added across sessions, and the hours figure derives from it", () => {
  const one = emptyStats(); mkSession(one, "a", { minutes: 6 });
  const two = emptyStats(); mkSession(two, "a", { minutes: 6 }); mkSession(two, "b", { minutes: 6, day: "06" });
  const h1 = finalize(one).total_duration_hours;
  const h2 = finalize(two).total_duration_hours;
  assert.ok(typeof h1 === "number" && typeof h2 === "number",
    `total_duration_hours is ${typeof h1}`);
  assert.ok(h2 > h1, `two sessions gave ${h2} hours against one session's ${h1}`);
});

test("a session with no usable timestamp is counted as UNDATED, not dropped", () => {
  // undatedTok += s.tok.in + s.tok.out + s.tok.cr + s.tok.cw — a dropped
  // session is worse than an undated one and must not read the same.
  const stats = emptyStats();
  const s = mkSession(stats, "ghost");
  s.firstTs = NaN; s.lastTs = NaN;
  const out = finalize(stats);
  const buckets = bucketsOf(out) ?? [];
  assert.equal(buckets.reduce((a, b) => a + (b.input_tokens ?? 0), 0), 0,
    "an undated session was filed into a month it has no date for");
  const blob = JSON.stringify(out);
  assert.ok(/undated/i.test(blob),
    "the report says nothing about undated sessions, so 128 tokens vanished silently");
});


test("top_projects carries a COUNT and is ranked by it", () => {
  // It published {name: "x", sessions: "x"} — the project's NAME in the
  // session-count field — because b.projects was a Set and Set.entries()
  // yields [value, value]. The sort then subtracted two strings, produced NaN,
  // and left the list in INSERTION ORDER, which came off the filesystem. That
  // is the exact defect byCountThenKey exists in this file to prevent.
  const stats = emptyStats();
  let n = 0;
  for (const [proj, times] of [["busy", 3], ["mid", 2], ["quiet", 1]])
    for (let i = 0; i < times; i++) mkSession(stats, `s${n++}`, { month: "03", project: proj });
  const top = bucketsOf(finalize(stats))[0].top_projects;
  assert.deepEqual(top, [
    { name: "busy", sessions: 3 },
    { name: "mid", sessions: 2 },
    { name: "quiet", sessions: 1 },
  ], "top_projects is not counted, or not ranked by the count");
  for (const row of top) assert.equal(typeof row.sessions, "number");
});

test("projects with equal counts are ordered by NAME, not by the filesystem", () => {
  const stats = emptyStats();
  let n = 0;
  for (const proj of ["zebra", "alpha", "mango"])
    for (let i = 0; i < 2; i++) mkSession(stats, `t${n++}`, { month: "03", project: proj });
  const names = bucketsOf(finalize(stats))[0].top_projects.map((p) => p.name);
  assert.deepEqual(names, ["alpha", "mango", "zebra"],
    "a tie was left in insertion order, so two machines with one corpus can disagree");
});
