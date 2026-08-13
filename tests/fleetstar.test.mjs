// The fleet as a star source — and the rule that it is never blended.
//
// The corpus is what survived on this machine; the fleet is the frozen counters
// that outlive deleted transcripts. They measure DIFFERENT things: the fleet has
// projects, models and days, and has no languages, tool calls or night hours at
// all. Merging them would produce a star with three arms from one source and two
// from another, which is exactly the kind of number this codebase has repeatedly
// shipped wrong because nobody could see the seam.
//
// What makes the fleet column safe to show is that every scoring term is a
// non-negative addition, so an axis missing a term is a LOWER BOUND. The tests
// below pin that property, because it is the entire justification.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fleetAggregates, longestStreak, FLEET_MEASURES } from "../src/fleetstar.mjs";
import { computeLevels, explainLevels } from "../src/star.mjs";
import { cardSources, box } from "../src/wrapped.mjs";
import { ARMS } from "../src/starsvg.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

function fleetDir(machines) {
  const root = mkdtempSync(join(tmpdir(), "sf-fleet-"));
  for (const [name, totals] of Object.entries(machines)) {
    const d = join(root, name, "machine-readable");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "totals.json"), JSON.stringify(totals));
  }
  return root;
}

const account = (over = {}) => ({
  sessions: 1,
  totals: { input_tokens: 1e6, output_tokens: 1e5 },
  by_project: { "-a": {} },
  by_model: { "claude-opus-5": {} },
  by_day: { "2026-07-01": { input_tokens: 1e6, output_tokens: 1e5 } },
  ...over,
});

const machine = (name, accounts) => ({ machine: name, grand_total_tokens: 1, accounts });

test("projects and models are counted DISTINCT across machines, not summed", () => {
  // The same project worked on from two laptops is one project. Summing would
  // inflate ENGINEERING by however many machines you happen to own.
  const dir = fleetDir({
    m1: machine("m1", [account({ by_project: { "-shared": {}, "-only1": {} } })]),
    m2: machine("m2", [account({ by_project: { "-shared": {}, "-only2": {} } })]),
  });
  const { lifetime } = fleetAggregates(dir);
  assert.equal(lifetime.projects_count, 3, "shared + only1 + only2");
  assert.equal(Object.keys(lifetime.models).length, 1, "one model, seen twice");
});

test("active days are distinct across machines too", () => {
  const dir = fleetDir({
    m1: machine("m1", [account({ by_day: { "2026-07-01": {}, "2026-07-02": {} } })]),
    m2: machine("m2", [account({ by_day: { "2026-07-02": {}, "2026-07-03": {} } })]),
  });
  const { lifetime } = fleetAggregates(dir);
  assert.equal(lifetime.active_days, 3, "a day worked on two machines is one day");
  assert.equal(lifetime.longest_streak_days, 3, "and they are consecutive");
});

test("tokens ARE summed — they are spend, not identity", () => {
  const dir = fleetDir({
    m1: machine("m1", [account({ totals: { input_tokens: 10, output_tokens: 1 } })]),
    m2: machine("m2", [account({ totals: { input_tokens: 20, output_tokens: 2 } })]),
  });
  const { lifetime } = fleetAggregates(dir);
  assert.equal(lifetime.total_input_tokens, 30);
  assert.equal(lifetime.total_output_tokens, 3);
});

test("the fleet aggregate carries NO field it did not measure", () => {
  // The whole safety argument. If languages/tool calls/night hours ever appear
  // here they will have been invented, and the star will read them as real.
  const { lifetime } = fleetAggregates(fleetDir({ m1: machine("m1", [account()]) }));
  for (const k of ["languages", "tool_call_counts", "tool_calls", "night_hours", "hour_buckets"])
    assert.ok(!(k in lifetime), `fleet aggregate must not carry ${k} — it cannot measure it`);
});

test("months come out of by_day, oldest first", () => {
  const dir = fleetDir({
    m1: machine("m1", [account({ by_day: {
      "2026-06-30": { output_tokens: 1 }, "2026-07-01": { output_tokens: 2 }, "2026-07-02": { output_tokens: 3 },
    } })]),
  });
  const { months } = fleetAggregates(dir);
  assert.deepEqual(months.map((m) => m.month), ["2026-06", "2026-07"]);
  assert.equal(months[1].active_days, 2);
  assert.equal(months[1].total_output_tokens, 5);
});

test("a single month never claims the fleet's whole project and model variety", () => {
  // by_project and by_model are not broken down by day, so attributing all of
  // them to the latest month would be an invention.
  const dir = fleetDir({ m1: machine("m1", [account({
    by_project: { a: {}, b: {}, c: {} },
    by_day: { "2026-07-01": {}, "2026-08-01": {} },
  })]) });
  const { months } = fleetAggregates(dir);
  for (const m of months) {
    assert.equal(m.projects_count, 0, "a month must not inherit the lifetime's projects");
    assert.deepEqual(m.models, {});
  }
});

test("an unmeasured axis is MARKED, never silently scored as zero", () => {
  const { lifetime } = fleetAggregates(fleetDir({ m1: machine("m1", [account()]) }));
  const rows = explainLevels(lifetime, { available: FLEET_MEASURES });
  const byAxis = Object.fromEntries(rows.map((r) => [r.axis, r]));
  assert.equal(byAxis.CODING.measured, false, "the fleet has no tool calls at all");
  assert.equal(byAxis["FIRST PRINCIPLES"].measured, true);
  assert.equal(byAxis["FIRST PRINCIPLES"].partial, false, "tokens are fully measured");
  assert.equal(byAxis.ENGINEERING.partial, true, "projects yes, languages no");
  assert.equal(byAxis["OUTSIDE THE BOX"].partial, true, "models yes, night hours no");
  assert.equal(byAxis.TENACITY.partial, false, "both terms measured");
});

test("the fleet star is a FLOOR: adding the missing inputs can only raise it", () => {
  // The justification for showing the column at all. Every term is a
  // non-negative addition, so supplying what the fleet lacks must never lower
  // an arm. If a future weight went negative this fails, and it should.
  const { lifetime } = fleetAggregates(fleetDir({ m1: machine("m1", [account({
    by_project: Object.fromEntries([...Array(30)].map((_, i) => [`p${i}`, {}])),
    by_day: Object.fromEntries([...Array(40)].map((_, i) => [`2026-07-${String((i % 28) + 1).padStart(2, "0")}`, {}])),
  })]) }));
  const floor = computeLevels(lifetime);
  const filled = computeLevels({
    ...lifetime,
    languages: { python: 9, rust: 4, go: 2 },
    tool_call_counts: { Bash: 40000 },
    night_hours: 120,
  });
  for (let i = 0; i < ARMS; i++)
    assert.ok(filled[i] >= floor[i], `axis ${i}: filling in unmeasured inputs LOWERED the arm (${floor[i]} -> ${filled[i]})`);
});

test("nothing is blended: the corpus aggregate is never mutated", () => {
  const corpus = { total_input_tokens: 5e6, languages: { python: 1 }, active_days: 3, projects_count: 2 };
  const before = JSON.stringify(corpus);
  const { lifetime } = fleetAggregates(fleetDir({ m1: machine("m1", [account()]) }));
  cardSources(null, corpus, { lifetime, months: [] });
  assert.equal(JSON.stringify(corpus), before, "the card must not write into the corpus agg");
});

test("the card renders, fits its frame, and marks the floor", () => {
  const { lifetime, months } = fleetAggregates(fleetDir({ m1: machine("m1", [account()]) }));
  const lines = cardSources({ active_days: 2 }, { active_days: 9, languages: { a: 1 } }, { lifetime, months });
  const widths = new Set(box(lines).split("\n").map((l) => strip(l).length));
  assert.equal(widths.size, 1, `ragged: ${[...widths].join(", ")}`);
  const text = strip(lines.join("\n"));
  assert.match(text, /floor/, "the fleet row must be labelled a floor");
  assert.match(text, /not measured as zero|unmeasured/, "must explain why fleet arms are drawn at zero");
  assert.match(text, /4 STARS/, "the card title must say 4 STARS");
});

test("no data at all → null, not an empty card", () => {
  // If both corpus and fleet are absent/empty there is nothing to draw.
  assert.equal(cardSources(null, null, null), null);
  assert.equal(cardSources(null, null, { lifetime: null, months: [] }), null);
  // With corpus data but no fleet, the card shows 2 corpus stars rather than
  // returning null — 2 stars is more informative than nothing.
  const corpusOnly = cardSources(null, { active_days: 5 }, null);
  assert.ok(Array.isArray(corpusOnly) && corpusOnly.length > 0,
    "corpus-only should still draw the 2 corpus stars");
});

test("a missing or junk fleet directory yields nothing, and does not throw", () => {
  for (const bad of ["/nonexistent-fleet-xyz", "", null, undefined]) {
    let out;
    assert.doesNotThrow(() => { out = fleetAggregates(bad); }, `fleetAggregates(${JSON.stringify(bad)})`);
    assert.equal(out.lifetime, null);
  }
});

test("a fleet MONTH marks projects and models unmeasured, not zero", async () => {
  // "0 projects that month" is a claim; "not recorded per month" is the truth.
  // by_project and by_model carry no day breakdown, so a month cannot know
  // them — and an axis reported as 0 reads as weakness rather than as silence.
  const { FLEET_MEASURES_MONTH } = await import("../src/fleetstar.mjs");
  const { months } = fleetAggregates(fleetDir({ m1: machine("m1", [account()]) }));
  const rows = explainLevels(months[0], { available: FLEET_MEASURES_MONTH });
  const byAxis = Object.fromEntries(rows.map((r) => [r.axis, r]));
  assert.equal(byAxis.ENGINEERING.measured, false, "no per-month projects OR languages");
  assert.equal(byAxis["OUTSIDE THE BOX"].measured, false, "no per-month models OR night hours");
  assert.equal(byAxis.CODING.measured, false);
  assert.equal(byAxis["FIRST PRINCIPLES"].measured, true, "tokens ARE per-day");
  assert.equal(byAxis.TENACITY.measured, true, "and so are days");
});

test("longestStreak counts consecutive calendar days", () => {
  assert.equal(longestStreak(["2026-07-01", "2026-07-02", "2026-07-03"]), 3);
  assert.equal(longestStreak(["2026-07-01", "2026-07-03"]), 1);
  assert.equal(longestStreak([]), 0);
  // Across a month boundary, and across a leap day.
  assert.equal(longestStreak(["2026-07-31", "2026-08-01"]), 2);
  assert.equal(longestStreak(["2024-02-28", "2024-02-29", "2024-03-01"]), 3);
  // Junk must not become a streak.
  assert.equal(longestStreak(["nonsense", "2026-07-01"]), 1);
});
