// @ts-nocheck
// The two-star view: this month against everything.
//
// Written after the fact, which is the wrong order — the feature shipped with
// no test at all and the only thing that had ever exercised it was one ad-hoc
// script. The invariants below are the ones that make the comparison mean
// something; without them a delta is just two numbers that happen to differ.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCompare } from "../src/star.mjs";
import { ARMS, MAX_LEVEL } from "../src/starsvg.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "sf-cmp-"));

// A month bucket in the shape loadTimeline() produces.
function month(m, over = {}) {
  return {
    month: m,
    sessions: 10,
    duration_hours: 20,
    input_tokens: 5e6,
    output_tokens: 1e6,
    cache_tokens: 0,
    tool_calls: 2000,
    languages: { python: 5 },
    models: { a: 1 },
    projects_count: 4,
    hour_buckets: new Array(24).fill(1),
    active_days: 20,
    longest_streak_days: 10,
    ...over,
  };
}

// snapshots.mjs reads from ~/.starreckon/snapshots, so a fake HOME is the only
// way to drive loadTimeline without stubbing the module.
async function withTimeline(months) {
  const home = tmp();
  const dir = join(home, ".starreckon", "snapshots");
  mkdirSync(dir, { recursive: true });
  for (const m of months)
    writeFileSync(
      join(dir, `${m.month}.json`),
      JSON.stringify({ month: m.month, machines: { mach1: m } })
    );
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    // Imported per-call: SNAP_DIR is resolved from homedir() at module load.
    const mod = await import(`../src/snapshots.mjs?t=${Date.now()}${Math.random()}`);
    return { ...mod, timeline: mod.loadTimeline() };
  } finally {
    process.env.HOME = prev;
  }
}

// ---- the lifetime aggregate ------------------------------------------------

test("lifetime SUMS across months but takes the MAX across a streak", async () => {
  const { lifetimeFromTimeline, timeline } = await withTimeline([
    month("2026-01", { sessions: 10, active_days: 20, longest_streak_days: 10, tool_calls: 100 }),
    month("2026-02", { sessions: 30, active_days: 25, longest_streak_days: 15, tool_calls: 300 }),
  ]);
  const life = lifetimeFromTimeline(timeline);
  assert.equal(life.sessions, 40, "volume adds across months");
  assert.equal(life.tool_calls, 400);
  // Two months cannot share a calendar day, so days ADD — unlike across
  // machines, where a Tuesday worked on two laptops is one Tuesday.
  assert.equal(life.active_days, 45, "active days add across months");
  // A streak cannot be summed: 10 days in January and 15 in February is not a
  // 25-day run. Max is a floor and is documented as one.
  assert.equal(life.longest_streak_days, 15, "streak takes the max, never the sum");
  assert.equal(life.months, 2);
  assert.equal(life.from, "2026-01");
  assert.equal(life.to, "2026-02");
});

test("lifetime does not double-count a project that recurs every month", async () => {
  const { lifetimeFromTimeline, timeline } = await withTimeline([
    month("2026-01", { projects_count: 5 }),
    month("2026-02", { projects_count: 5 }),
    month("2026-03", { projects_count: 7 }),
  ]);
  const life = lifetimeFromTimeline(timeline);
  // The normal reason a project appears in three months is that it is the SAME
  // project. Summing gave 17 repositories to someone who has 7.
  assert.equal(life.projects_count, 7, "projects take the max, not the sum");
});

test("lifetime is never smaller than any month inside it", async () => {
  const { lifetimeFromTimeline, timeline } = await withTimeline([
    month("2026-01", { input_tokens: 1e6, tool_calls: 500, active_days: 5 }),
    month("2026-02", { input_tokens: 90e6, tool_calls: 40000, active_days: 28 }),
  ]);
  const life = lifetimeFromTimeline(timeline);
  for (let i = 0; i < ARMS; i++)
    for (const m of timeline)
      assert.ok(
        life.levels[i] >= m.levels[i],
        `axis ${i}: lifetime ${life.levels[i]} < month ${m.month} ${m.levels[i]}`
      );
});

test("first run: lifetime IS the only month, so every delta is zero", async () => {
  const { lifetimeFromTimeline, timeline } = await withTimeline([month("2026-08")]);
  const life = lifetimeFromTimeline(timeline);
  assert.equal(life.months, 1);
  assert.deepEqual(life.levels, timeline[0].levels, "one month means the two stars coincide");
  const text = renderCompare(timeline[0], life, { color: false });
  assert.match(text, /first run/, "it must SAY the deltas are zero because there is no history");
});

test("an empty timeline does not crash and does not invent a profile", async () => {
  const { lifetimeFromTimeline } = await withTimeline([]);
  const life = lifetimeFromTimeline([]);
  assert.equal(life.months, 0);
  assert.deepEqual(life.levels, new Array(ARMS).fill(0));
});

// ---- the rendered view -----------------------------------------------------

test("the compare view shows both columns, a delta, and the real denominator", () => {
  const m = { month: "2026-08", levels: [1, 2, 3, 4, 5] };
  const l = { month: "lifetime", months: 7, from: "2026-01", to: "2026-08", levels: [5, 5, 5, 5, 5] };
  const t = renderCompare(m, l, { color: false });
  assert.match(t, /2026-08/);
  assert.match(t, /7 month\(s\), 2026-01–2026-08/);
  assert.match(t, new RegExp(`of ${ARMS * MAX_LEVEL}`), "denominator must track MAX_LEVEL");
  assert.match(t, /-10\.0/, "the total delta must be shown and signed");
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(t, /\x1b\[/, "no ANSI when colour is off — this text gets saved to a file");
});

test("a quieter month reads as negative, a busier one as positive", () => {
  const life = { month: "lifetime", months: 5, levels: [3, 3, 3, 3, 3] };
  const quiet = renderCompare({ month: "2026-08", levels: [1, 1, 1, 1, 1] }, life, { color: false });
  const busy = renderCompare({ month: "2026-08", levels: [5, 5, 5, 5, 5] }, life, { color: false });
  assert.match(quiet, /-10\.0/);
  assert.match(busy, /\+10\.0/);
  // And it must say what a negative delta MEANS, or it reads as lost work.
  assert.match(quiet, /not lost work/);
});

test("the view survives a missing or malformed side", () => {
  const ok = { month: "2026-08", levels: [1, 2, 3, 4, 5] };
  assert.doesNotThrow(() => renderCompare(ok, null, { color: false }));
  assert.doesNotThrow(() => renderCompare(null, ok, { color: false }));
  assert.doesNotThrow(() => renderCompare({}, {}, { color: false }));
});
