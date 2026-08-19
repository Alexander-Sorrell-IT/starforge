// tests/series.test.mjs — the readiness view for a witness this program has not
// got, and the three answers it must never merge into one.
//
// WHAT THESE TESTS ARE DEFENDING
//
//   1. THE BAR IS NOT NEGOTIABLE HERE. 10 is deadreckon's, a property of the
//      model rather than a preference, and it is pinned LITERALLY below instead
//      of imported from the module under test. A test that takes its expected
//      value from the code it checks cannot notice the bar being softened, and
//      softening the bar is the only interesting way this feature goes wrong.
//   2. ABSENT IS NOT ZERO, and it is asserted against the alternative: the same
//      fixture is counted a second time through loadTimeline(), which returns a
//      fabricated point, so the test proves the other implementation would have
//      been wrong rather than merely asserting this one is right.
//   3. THREE ANSWERS STAY THREE. "not enough data yet", "the model ran and
//      recorded nothing" and "this layer is not installed" must be three
//      different renderings, and the test compares them to each other rather
//      than matching one string each.
//   4. NO BAND, EVER. The module must expose nothing that predicts, and the
//      output must never print an interval.
//
// Every fixture is a temp dir. Nothing here reads or writes the real
// ~/.starreckon.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MIN_POINTS, SERIES, readSnapshots, surveySeries, renderSeries,
  witnessState, witnessPaths, calendarGaps,
} from "../src/series.mjs";

// deadreckon forecast_check.py — `MIN_POINTS = 10`. Written out by hand on
// purpose; see note 1 in the header.
const DEADRECKON_MIN_POINTS = 10;

const tmp = (tag) => mkdtempSync(join(tmpdir(), `series-${tag}-`));

// A machine record carrying every series' keys, so a fixture month is a point
// for all of them unless a test deletes one.
const record = (month, n = 1) => ({
  month,
  sessions: n, duration_hours: n + 0.5,
  input_tokens: 100 * n, output_tokens: 10 * n, cache_tokens: 5 * n,
  tool_calls: n + 1, active_days: n, night_hours: n / 2,
  longest_streak_days: n, projects_count: n,
  hour_buckets: new Array(24).fill(0), languages: {}, models: {},
});

// n consecutive months ending 2026-08, so a fixture has no calendar gap unless
// a test asks for one.
function monthsEnding(n, endY = 2026, endM = 8) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const t = endY * 12 + (endM - 1) - i;
    out.push(`${String(Math.floor(t / 12)).padStart(4, "0")}-${String((t % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

/** A snapshots dir holding one file per month. `edit` may mutate each record. */
function store(months, edit = null, tag = "store") {
  const home = tmp(tag);
  const dir = join(home, ".starreckon", "snapshots");
  mkdirSync(dir, { recursive: true });
  months.forEach((m, i) => {
    const rec = record(m, i + 1);
    if (edit) edit(rec, m, i);
    writeFileSync(join(dir, `${m}.json`), JSON.stringify({ month: m, machines: { box: rec } }));
  });
  return { home, dir };
}

/** A forecaster environment on disk, the way forecast_check.py detects one. */
function installWitness(home, { record: recordLines = null } = {}) {
  const { venv, record: recFile } = witnessPaths(home);
  mkdirSync(join(venv, "bin"), { recursive: true });
  writeFileSync(join(venv, "bin", "python"), "#!/bin/sh\n");
  if (recordLines !== null) writeFileSync(recFile, recordLines);
}

// ── 1 · the bar ──────────────────────────────────────────────────────────────

test("the threshold is deadreckon's MIN_POINTS, unsoftened", () => {
  assert.equal(MIN_POINTS, DEADRECKON_MIN_POINTS,
    "10 is a property of the Cisco model (its short contexts are trained down to "
    + "10) and forecast_check.py refuses less. Lowering it here would draw a band "
    + "over nothing, which is the one thing this view exists not to do.");
});

test("the bar is >= , so exactly 10 points is ready and 9 is not", () => {
  const at = surveySeries(store(monthsEnding(DEADRECKON_MIN_POINTS), null, "at"));
  for (const s of at.series) {
    assert.equal(s.points, DEADRECKON_MIN_POINTS, s.name);
    assert.equal(s.state, "ready", `${s.name} must be ready at exactly the bar`);
    assert.equal(s.needed, 0, s.name);
  }
  const under = surveySeries(store(monthsEnding(DEADRECKON_MIN_POINTS - 1), null, "under"));
  for (const s of under.series) {
    assert.equal(s.state, "not enough yet", `${s.name} must not be ready at 9`);
    assert.equal(s.needed, 1, s.name);
  }
});

// ── 2 · the count, and where it comes from ───────────────────────────────────

test("eight snapshots report 8 of 10 and ask for 2 more — the count is the answer", () => {
  const survey = surveySeries(store(monthsEnding(8), null, "eight"));
  assert.equal(survey.monthNames.length, 8);
  for (const s of survey.series) {
    assert.equal(s.points, 8, `${s.name} miscounted`);
    assert.equal(s.needed, 2, `${s.name} needed`);
  }
  const out = renderSeries(survey, { color: false });
  assert.match(out, /8 of 10/);
  assert.match(out, /2 more monthly snapshots/);
});

test("the count is re-derived from disk on every call, never carried", () => {
  const fx = store(monthsEnding(8), null, "fresh");
  assert.equal(surveySeries(fx).series[0].points, 8);
  // A ninth month appears with no process restart and nothing invalidated.
  writeFileSync(join(fx.dir, "2026-09.json"),
    JSON.stringify({ month: "2026-09", machines: { box: record("2026-09", 9) } }));
  assert.equal(surveySeries(fx).series[0].points, 9,
    "a stored count would still say 8 here. This project already froze 16,636 "
    + "sessions against a true 132 by keeping a number instead of re-reading.");
  // And a count can go DOWN, which a Math.max floor over a stored record could
  // never do — the exact defect that made corrections unreachable in ledger.mjs.
  writeFileSync(join(fx.dir, "2026-09.json"), "{ not json");
  assert.equal(surveySeries(fx).series[0].points, 8, "a correction must be reachable");
});

test("reading the series writes nothing", () => {
  const fx = store(monthsEnding(8), null, "readonly");
  const before = readdirSync(fx.dir).sort();
  renderSeries(surveySeries(fx), { color: false });
  assert.deepEqual(readdirSync(fx.dir).sort(), before);
  assert.deepEqual(readdirSync(join(fx.home, ".starreckon")).sort(), ["snapshots"]);
});

// ── 3 · absent is not zero, proven against the alternative ───────────────────

test("a month written before a field existed is NOT a point — and loadTimeline says it is", async () => {
  const months = monthsEnding(12);
  const fx = store(months, (rec, m, i) => {
    if (i === 0) { delete rec.tool_calls; delete rec.night_hours; }
  }, "absent");

  const survey = surveySeries(fx);
  const points = Object.fromEntries(survey.series.map((s) => [s.name, s.points]));
  assert.equal(points.sessions, 12, "every month measured sessions");
  assert.equal(points.tool_calls, 11, "the oldest month never measured tool_calls");
  assert.equal(points.night_hours, 11, "nor night_hours");

  // THE CONTRAST. Counting the same fixture through loadTimeline() — the
  // obvious implementation — fabricates a point for tool_calls, because the
  // accumulator zero-fills. night_hours only escapes because snapshots.mjs was
  // already fixed for that one field after 137.3 real night hours were drawn as
  // 450,107; every other field still has the defect.
  const prev = process.env.HOME;
  process.env.HOME = fx.home;
  let timeline;
  try {
    const mod = await import(`../src/snapshots.mjs?t=${Date.now()}${Math.random()}`);
    timeline = mod.loadTimeline();
  } finally {
    process.env.HOME = prev;
  }
  const viaTimeline = (k) =>
    timeline.filter((t) => typeof t[k] === "number" && Number.isFinite(t[k])).length;
  assert.equal(viaTimeline("tool_calls"), 12,
    "if this is 11, loadTimeline stopped zero-filling and this view could use it");
  assert.equal(viaTimeline("night_hours"), 11);
  assert.ok(viaTimeline("tool_calls") > points.tool_calls,
    "the whole reason this module reads raw records instead of the timeline");
});

test("a field no snapshot has ever carried reports `no history`, not `0 of 10`", () => {
  const fx = store(monthsEnding(12), (rec) => { delete rec.night_hours; }, "nohist");
  const survey = surveySeries(fx);
  const night = survey.series.find((s) => s.name === "night_hours");
  assert.equal(night.points, 0);
  assert.equal(night.state, "no history",
    "12 months exist and none measured it — more months of the same would not move it");
  const out = renderSeries(survey, { color: false });
  assert.match(out, /night_hours\s+0 of 10\s+no history — no snapshot here carries night_hours/);
});

test("`no history` and `no snapshots` are different answers", () => {
  const withMonths = surveySeries(store(monthsEnding(12), (r) => { delete r.night_hours; }, "a"));
  const withNone = surveySeries({ dir: join(tmp("b"), "never-scanned"), home: tmp("b2") });
  assert.equal(withMonths.series.find((s) => s.name === "night_hours").state, "no history");
  assert.equal(withNone.series.find((s) => s.name === "night_hours").state, "no snapshots");
  assert.equal(withNone.store, "absent");
  const outA = renderSeries(withMonths, { color: false });
  const outB = renderSeries(withNone, { color: false });
  assert.notEqual(outA, outB);
  assert.match(outB, /no snapshots directory yet/);
});

test("a snapshots directory that exists and is empty is not a missing one", () => {
  const home = tmp("emptydir");
  const dir = join(home, ".starreckon", "snapshots");
  mkdirSync(dir, { recursive: true });
  const survey = surveySeries({ dir, home });
  assert.equal(survey.store, "empty");
  assert.match(renderSeries(survey, { color: false }),
    /directory is here and holds no snapshot/);
});

test("a snapshot that will not parse is named, never silently dropped", () => {
  const fx = store(monthsEnding(8), null, "corrupt");
  writeFileSync(join(fx.dir, "2026-09.json"), "{ truncated");
  const survey = surveySeries(fx);
  assert.equal(survey.series[0].points, 8, "the broken file is not a point");
  assert.deepEqual(survey.unusable.map((u) => u.file), ["2026-09.json"]);
  const out = renderSeries(survey, { color: false });
  assert.match(out, /2026-09\.json/);
  assert.match(out, /NOT points and NOT zeros/);
});

test("one month written by two machines is one point, not two", () => {
  const home = tmp("twomach");
  const dir = join(home, ".starreckon", "snapshots");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-08.json"), JSON.stringify({
    month: "2026-08",
    machines: { laptop: record("2026-08", 1), desktop: record("2026-08", 2) },
  }));
  assert.equal(surveySeries({ dir, home }).series[0].points, 1);
});

test("a calendar gap is reported and is not a point", () => {
  const months = ["2026-01", "2026-02", "2026-04"];
  const fx = store(months, null, "gap");
  const survey = surveySeries(fx);
  assert.equal(survey.series[0].points, 3, "three months exist");
  assert.deepEqual(survey.gaps, ["2026-03"]);
  assert.deepEqual(calendarGaps(["2026-01", "2026-05"]), ["2026-02", "2026-03", "2026-04"]);
  assert.match(renderSeries(survey, { color: false }),
    /no snapshot for 2026-03 — a month that was not recorded has no slot/);
});

// ── 4 · the three answers, kept apart ────────────────────────────────────────

test("not enough data, the model found nothing, and the layer is absent are three renderings", () => {
  // (a) 8 of 10, no forecaster — today's real answer on this fleet.
  const short = store(monthsEnding(8), null, "short");
  // (b) enough history, no forecaster anywhere.
  const noLayer = store(monthsEnding(12), null, "absent-layer");
  // (c) enough history, forecaster installed, its record present and EMPTY.
  const nothing = store(monthsEnding(12), null, "ran-nothing");
  installWitness(nothing.home, { record: "" });

  assert.equal(surveySeries(short).witness.state, "not installed");
  assert.equal(surveySeries(noLayer).witness.state, "not installed");
  assert.equal(surveySeries(nothing).witness.state, "ran, nothing recorded");

  const outShort = renderSeries(surveySeries(short), { color: false });
  const outNoLayer = renderSeries(surveySeries(noLayer), { color: false });
  const outNothing = renderSeries(surveySeries(nothing), { color: false });

  // Each names its OWN cause…
  assert.match(outShort, /2 more monthly snapshots/);
  assert.match(outNoLayer, /no forecaster environment at/);
  assert.match(outNothing, /It ran and recorded no band/);

  // …and never wears another's.
  assert.ok(!outShort.includes("It ran and recorded no band"),
    "nothing ran there, so nothing can have found nothing");
  assert.ok(!outNoLayer.includes("more monthly snapshot"),
    "12 months is not a shortage of history");
  assert.ok(!outNothing.includes("more monthly snapshot"),
    "12 months is not a shortage of history");
  assert.ok(!outNothing.includes("no forecaster environment"),
    "the forecaster is right there");
  assert.notEqual(outShort, outNoLayer);
  assert.notEqual(outShort, outNothing);
  assert.notEqual(outNoLayer, outNothing);
});

// THE TWO AXES ARE INDEPENDENT AND BOTH GET SAID. A short history and a model
// that recorded nothing are both true at once on a machine that installed the
// forecaster early, and neither sentence stands in for the other — which is the
// whole reason the history and the layer are reported in separate blocks rather
// than reduced to one verdict line.
test("when the history is short AND the model recorded nothing, both are stated", () => {
  const both = store(monthsEnding(8), null, "both");
  installWitness(both.home, { record: "" });
  const out = renderSeries(surveySeries(both), { color: false });
  assert.match(out, /8 of 10/);
  assert.match(out, /2 more monthly snapshots/);
  assert.match(out, /It ran and recorded no band/);
});

test("installed-and-never-run is not the same as ran-and-recorded-nothing", () => {
  const never = tmp("never");
  installWitness(never);                       // venv, no record file at all
  assert.equal(witnessState(never).state, "never run");

  const empty = tmp("empty-rec");
  installWitness(empty, { record: "\n\n" });   // record file, no rows
  assert.equal(witnessState(empty).state, "ran, nothing recorded");
  assert.equal(witnessState(empty).bands, 0);

  const some = tmp("some-rec");
  installWitness(some, { record: '{"series":"sessions","lo":1,"hi":2}\n' });
  assert.equal(witnessState(some).state, "on record");
  assert.equal(witnessState(some).bands, 1);

  assert.equal(witnessState(tmp("bare")).state, "not installed");
});

test("a venv directory with no interpreter in it is a failed install, not an installed layer", () => {
  const home = tmp("novenv-python");
  mkdirSync(witnessPaths(home).venv, { recursive: true });
  assert.equal(witnessState(home).state, "not installed",
    "forecast_check.py:infer() looks for the interpreter, and so does this");
});

// ── 5 · it must never imply a forecast ───────────────────────────────────────

test("the module exposes nothing that predicts", async () => {
  const mod = await import("../src/series.mjs");
  for (const name of ["predict", "infer", "forecast", "band", "grade"])
    assert.equal(mod[name], undefined,
      `series.mjs must not export ${name} — it counts history, it does not model it`);
});

test("no output, in any state, prints a band or an interval", () => {
  const fixtures = [
    surveySeries(store(monthsEnding(8), null, "nb1")),
    surveySeries(store(monthsEnding(12), null, "nb2")),
    surveySeries({ dir: join(tmp("nb3"), "gone"), home: tmp("nb4") }),
  ];
  for (const survey of fixtures) {
    const out = renderSeries(survey, { color: false });
    assert.ok(!/\[[\d.,]+\s*(?:\.\.|–|—|-)\s*[\d.,]+\]/.test(out), "no [lo .. hi] interval");
    assert.ok(!/\bpredict|\bforecasted|\bprojected|\bquantile|\bconfidence\b/i.test(out),
      "nothing in this view forecasts anything");
    assert.match(out, /NO BAND IS DRAWN HERE/);
  }
});

test("even above the bar, no band is drawn — starreckon holds no witness", () => {
  const out = renderSeries(surveySeries(store(monthsEnding(24), null, "long")), { color: false });
  assert.match(out, /ready 6/);
  assert.match(out, /NO BAND IS DRAWN HERE/);
  assert.match(out, /not installed/);
});

// ── 6 · house rules ──────────────────────────────────────────────────────────

test("NO_COLOR: render emits no escape codes when colour is off", () => {
  const fx = store(monthsEnding(8), null, "nocolor");
  installWitness(fx.home, { record: "" });
  assert.ok(!renderSeries(surveySeries(fx), { color: false }).includes("\x1b"));
  assert.ok(renderSeries(surveySeries(fx), { color: true }).includes("\x1b"));
});

test("the printed path is masked", () => {
  const fx = store(monthsEnding(2), null, "mask");
  const out = renderSeries(surveySeries(fx), { color: false });
  assert.ok(!out.includes(process.env.USER ?? " nope"),
    "series output is the kind of thing that gets pasted into an issue");
});

test("every declared series names snapshot keys that snapshots actually write", () => {
  // The keys are read verbatim out of the JSON, so a renamed field would show as
  // a permanent `no history` rather than an error. A fixture built from the
  // real writer's shape is what notices.
  const fx = store(monthsEnding(1), null, "keys");
  const survey = surveySeries(fx);
  for (const s of survey.series)
    assert.equal(s.points, 1, `${s.name} counts nothing from a full snapshot record`);
  assert.equal(SERIES.length, survey.series.length);
});

test("a snapshots directory that cannot be entered is not an empty one", { skip: process.getuid?.() === 0 ? "root reads anything" : false }, () => {
  const home = tmp("noperm");
  const dir = join(home, ".starreckon", "snapshots");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-08.json"), JSON.stringify({ month: "2026-08", machines: {} }));
  chmodSync(dir, 0o000);
  try {
    const survey = surveySeries({ dir, home });
    assert.equal(survey.store, "unreadable");
    assert.match(renderSeries(survey, { color: false }),
      /cannot be read .* — every count above/s);
  } finally {
    chmodSync(dir, 0o755);
  }
});

test("readSnapshots reports a file whose name and body carry no month", () => {
  const home = tmp("nomonth");
  const dir = join(home, ".starreckon", "snapshots");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "notes.json"), JSON.stringify({ machines: { box: record("x") } }));
  const st = readSnapshots(dir);
  assert.equal(st.months.length, 0);
  assert.deepEqual(st.unusable.map((u) => u.file), ["notes.json"]);
});
