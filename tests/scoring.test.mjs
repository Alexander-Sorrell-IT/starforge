// The scoring contract.
//
// Every bug pinned here shipped, and NONE of them failed a test: the suite
// checked that computeLevels returned five numbers in range and that the star
// rendered, which is true of a function returning [3,3,3,3,3] for everything.
// A score is a measurement, so these assert what it MEASURES:
//
//   - it discriminates (10x the work must not score the same)
//   - each axis saturates where its `mid` says it should, not sooner
//   - a display truncation never reaches an axis
//   - a memory cap never decides which languages someone knows
//   - "night hours" is hours
//
// Value pins, not shape checks. If a constant is deliberately retuned these
// numbers change and that is fine — but it must be a decision, not a drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLevels, explainLevels } from "../src/star.mjs";
import { ARMS, MAX_LEVEL } from "../src/starsvg.mjs";
import { emptyStats, finalize, countLanguage, parseClaudeFile } from "../src/scan.mjs";
import { AXES } from "../src/starsvg.mjs";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const SRC = join(dirname(dirname(fileURLToPath(import.meta.url))), "src");

const AX = { FIRST: 0, ENGINEERING: 1, CODING: 2, OUTSIDE: 3, TENACITY: 4 };
const total = (lv) => +lv.reduce((a, b) => a + b, 0).toFixed(1);

// An aggregate in the shape computeLevels reads, with everything at zero unless
// a test says otherwise — so each test moves exactly one input.
function agg(over = {}) {
  return {
    total_input_tokens: 0,
    total_output_tokens: 0,
    projects_count: 0,
    languages: {},
    tool_call_counts: {},
    models: {},
    hour_buckets: new Array(24).fill(0),
    night_hours: 0,
    active_days: 0,
    longest_streak_days: 0,
    ...over,
  };
}

// ---- it discriminates -------------------------------------------------------

test("the star separates profiles an order of magnitude apart", () => {
  const at = (mult) =>
    computeLevels(
      agg({
        total_input_tokens: 20e6 * mult,
        projects_count: 8 * mult,
        languages: Object.fromEntries([...Array(Math.min(20, 4 * mult))].map((_, i) => [`l${i}`, 1])),
        tool_call_counts: { Bash: 4000 * mult },
        models: Object.fromEntries([...Array(Math.min(12, 2 * mult))].map((_, i) => [`m${i}`, 1])),
        night_hours: 40 * mult,
        active_days: Math.min(365, 30 * mult),
        longest_streak_days: Math.min(365, 12 * mult),
      })
    );
  const one = total(at(1));
  const ten = total(at(10));
  assert.ok(ten > one, `10x the work must score higher: ${one} -> ${ten}`);
  // The bug this replaces: 10x scored IDENTICALLY, because every axis was
  // already clamped. A tenfold difference must move the total by more than a
  // rounding step.
  assert.ok(
    ten - one >= 2,
    `10x must be clearly separated, got ${one} -> ${ten} (+${(ten - one).toFixed(1)})`
  );
});

test("a smaller profile never outscores a larger one on any axis", () => {
  const small = computeLevels(
    agg({ total_input_tokens: 5e6, tool_call_counts: { Bash: 500 }, active_days: 10 })
  );
  const big = computeLevels(
    agg({ total_input_tokens: 500e6, tool_call_counts: { Bash: 90000 }, active_days: 97 })
  );
  for (const i of [AX.FIRST, AX.CODING, AX.TENACITY])
    assert.ok(big[i] >= small[i], `axis ${i}: ${big[i]} must be >= ${small[i]}`);
});

test("an empty history scores zero, not a participation floor", () => {
  const lv = computeLevels(agg());
  assert.deepEqual(lv, new Array(ARMS).fill(0));
});

// ---- saturation is where the constants say ---------------------------------

test("FIRST PRINCIPLES reaches the ceiling at its documented input, not before", () => {
  // lg(v, 5) hits 5.0 at v = 50 (million tokens). With MAX_LEVEL above 5 the
  // axis must keep CLIMBING past that instead of flattening.
  const at = (m) => computeLevels(agg({ total_input_tokens: m * 1e6 }))[AX.FIRST];
  assert.ok(at(50) >= 4.9 && at(50) <= 5.1, `50M should read ~5.0, got ${at(50)}`);
  if (MAX_LEVEL > 5)
    assert.ok(at(250) > at(50), `past 50M must keep climbing: ${at(50)} -> ${at(250)}`);
  assert.equal(at(1e9), MAX_LEVEL, "absurd input clamps at MAX_LEVEL, never above");
});

test("no axis can exceed MAX_LEVEL, and the total cannot exceed ARMS*MAX_LEVEL", () => {
  const lv = computeLevels(
    agg({
      total_input_tokens: 1e12,
      projects_count: 1e6,
      languages: Object.fromEntries([...Array(200)].map((_, i) => [`l${i}`, 1])),
      tool_call_counts: { Bash: 1e7 },
      models: Object.fromEntries([...Array(200)].map((_, i) => [`m${i}`, 1])),
      night_hours: 1e5,
      active_days: 1e4,
      longest_streak_days: 1e4,
    })
  );
  for (const v of lv) assert.ok(v <= MAX_LEVEL, `${v} exceeds MAX_LEVEL ${MAX_LEVEL}`);
  assert.equal(total(lv), ARMS * MAX_LEVEL);
});

// ---- a display truncation must never reach an axis --------------------------

test("ENGINEERING keeps growing past the 20 the report displays", () => {
  // finalize() shows the top 20 projects. That slice used to BE the score
  // input, so 400 projects and 20 drew byte-identical stars.
  const e = (n) => computeLevels(agg({ projects_count: n, languages: { python: 1 } }))[AX.ENGINEERING];
  assert.ok(e(400) > e(20), `400 projects must beat 20: ${e(20)} -> ${e(400)}`);
});

test("finalize reports the true project count alongside the truncated list", () => {
  const stats = emptyStats();
  for (let i = 0; i < 37; i++)
    stats.sessions.set(`s${i}`, {
      firstTs: 1e12, lastTs: 1e12 + 6e4, minutes: new Set([1]),
      project: `p${i}`, models: new Map(), tok: { in: 1, out: 1, cr: 0, cw: 0 },
      tools: 0, turns: 0, source: "claude_code",
      exts: new Map(), hours: new Array(24).fill(0), days: new Set(["2001-09-09"]),
    });
  const out = finalize(stats);
  assert.equal(out.projects.length, 20, "the DISPLAY list stays capped");
  assert.equal(out.projects_count, 37, "the SCORE input is the real number");
});

// ---- a memory cap must never decide which languages you know ----------------

test("languages are found past the 5,000-path memory cap", () => {
  const stats = emptyStats();
  for (let i = 0; i < 5200; i++) countLanguage(stats.langCounts, `/w/f${i}.py`);
  // Beyond the cap, and the only file of its kind.
  countLanguage(stats.langCounts, "/w/only.swift");
  const out = finalize(stats);
  assert.ok(out.languages.swift, "a language seen after 5,000 paths was lost");
  assert.ok(out.languages.python > 5000);
});

test("generated files do not count as a language", () => {
  const m = new Map();
  countLanguage(m, "/w/node_modules/x/index.js");
  countLanguage(m, "/w/src/real.js");
  assert.equal(m.get("javascript"), 1, "only the non-generated file counts");
});

// ---- night HOURS, not log lines --------------------------------------------

test("OUTSIDE THE BOX is scored in hours, so one night cannot max it", () => {
  // 605 night EVENTS inside a single night used to saturate this axis, because
  // lg(nightHours, 60) was reading a per-event tally.
  const oneNight = computeLevels(
    agg({ night_hours: 5, models: { a: 1 }, hour_buckets: [605, 0, 0, 0, 0, 0, ...new Array(18).fill(0)] })
  )[AX.OUTSIDE];
  const manyNights = computeLevels(agg({ night_hours: 600, models: { a: 1 } }))[AX.OUTSIDE];
  assert.ok(oneNight < 3, `one night must not be a high score, got ${oneNight}`);
  assert.ok(manyNights > oneNight, "25 nights must beat one");
});

test("a chattier tool loop does not buy a longer arm", () => {
  const quiet = computeLevels(agg({ night_hours: 20, models: { a: 1 } }))[AX.OUTSIDE];
  const chatty = computeLevels(
    agg({ night_hours: 20, models: { a: 1 }, hour_buckets: [50000, 0, 0, 0, 0, 0, ...new Array(18).fill(0)] })
  )[AX.OUTSIDE];
  assert.equal(quiet, chatty, "hour_buckets must not affect the score when night_hours is present");
});

test("a snapshot without night_hours is UNMEASURED — never an event count, never a silent 0", () => {
  // This test used to assert the opposite: that a missing key fell back to
  // hour_buckets[0..5], "for snapshots written before night_hours existed". No
  // snapshot ever carried the key, so that fallback was the only path any
  // persisted star took, and it priced log LINES against a mid calibrated in
  // HOURS. Measured on the live corpus: 137.3 real night hours read as 450,107,
  // and OUTSIDE THE BOX saturated at 7.0 for the lifetime star.
  //
  // Nothing on disk can rebuild the hours (events are not hours at any exchange
  // rate), so the term is unmeasured — 0 towards the score, and SAID so.
  const legacy = agg({ models: { a: 1 }, hour_buckets: [100, 50, 0, 0, 0, 0, ...new Array(18).fill(0)] });
  delete legacy.night_hours;
  const noNight = computeLevels(agg({ models: { a: 1 } }))[AX.OUTSIDE];
  assert.equal(
    computeLevels(legacy)[AX.OUTSIDE],
    noNight,
    "the 150 night EVENTS in hour_buckets must not reach the score as hours"
  );
  const term = explainLevels(legacy)[AX.OUTSIDE].terms.find((t) => t.label === "night hours");
  assert.equal(term.measured, false, "absent must not be reported as a measured 0 h");
  assert.equal(term.contribution, 0);
  assert.equal(
    explainLevels(agg({ night_hours: 0, models: { a: 1 } }))[AX.OUTSIDE].terms.find(
      (t) => t.label === "night hours"
    ).measured,
    true,
    "a real, measured zero must still read as measured"
  );
});

// ---- the same unit has to survive being written down ------------------------
//
// The scan computed real night hours and the star knew what to do with them;
// the number never reached the star, because the per-month buckets that
// writeSnapshots persists carried no night_hours and loadTimeline's fixed key
// list would have dropped it anyway. Every month chip, every SVG on disk, the
// compare table and the lifetime star all ran on the event-count fallback.

test("a month bucket carries night HOURS, and they sum to the whole scan's", async () => {
  const home = mkdtempSync(join(tmpdir(), "sf-night-"));
  const dir = join(home, ".claude", "projects", "-w-a");
  mkdirSync(dir, { recursive: true });
  // Local-clock timestamps: the night window is d.getHours() < 6, so building
  // these from a local Date keeps the test true in every timezone.
  const at = (day, h, m) => new Date(2026, 6, day, h, m, 0).toISOString();
  const rows = [];
  let u = 0;
  // 400 events, 02:00-02:04 on 15 July: 5 distinct night minutes = 0.1 h.
  for (let i = 0; i < 400; i++)
    rows.push({ type: "assistant", timestamp: at(15, 2, i % 5), uuid: `a${u++}`,
      message: { role: "assistant", id: `m${u}`, model: "claude-opus-5", content: [{ type: "text", text: "x" }] } });
  // 120 distinct night minutes on 3 August = 2 h, in the NEXT month.
  for (let i = 0; i < 120; i++)
    rows.push({ type: "assistant", timestamp: at(34, 3, i), uuid: `b${u++}`,
      message: { role: "assistant", id: `n${u}`, model: "claude-opus-5", content: [{ type: "text", text: "x" }] } });
  const file = join(dir, "s.jsonl");
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n"));

  const stats = emptyStats();
  await parseClaudeFile(file, stats, {});
  const out = finalize(stats);
  const jul = out.monthly_buckets.find((b) => b.month === "2026-07");
  const aug = out.monthly_buckets.find((b) => b.month === "2026-08");
  assert.equal(jul.night_hours, 0.1, "400 events across 5 minutes is 0.1 h, not 400");
  assert.equal(jul.hour_buckets[2], 400, "the per-event histogram is still the histogram");
  assert.equal(aug.night_hours, 2, "120 distinct night minutes is 2 h");
  // A minute belongs to exactly one month, so the parts equal the whole. This
  // is what makes a month star and the lifetime star comparable at all.
  assert.equal(
    +out.monthly_buckets.reduce((s, b) => s + b.night_hours, 0).toFixed(1),
    out.night_hours,
    "per-month night hours must sum to the scan's night_hours"
  );
});

test("night_hours survives writeSnapshots -> loadTimeline, and absence stays absent", async () => {
  const home = mkdtempSync(join(tmpdir(), "sf-snap-night-"));
  const snaps = join(home, ".starreckon", "snapshots");
  mkdirSync(snaps, { recursive: true });
  // A pre-key snapshot, exactly as the eight on this machine were written: 39,918
  // night EVENTS in hour_buckets and no night_hours anywhere.
  writeFileSync(
    join(snaps, "2026-06.json"),
    JSON.stringify({ month: "2026-06", machines: { old: {
      month: "2026-06", sessions: 1, tool_calls: 10, models: { a: 1 },
      hour_buckets: [3831, 4580, 3622, 6796, 7786, 13303, ...new Array(18).fill(0)],
      active_days: 5, longest_streak_days: 2 } } })
  );
  const prev = process.env.HOME;
  process.env.HOME = home;
  let mod;
  try {
    // Imported per-call: SNAP_DIR is resolved from homedir() at module load.
    mod = await import(`../src/snapshots.mjs?t=${Date.now()}${Math.random()}`);
    mod.writeSnapshots([{ month: "2026-07", sessions: 2, tool_calls: 10, models: { a: 1 },
      hour_buckets: new Array(24).fill(9), night_hours: 70.2, active_days: 20,
      longest_streak_days: 4 }], {}, {});
    const timeline = mod.loadTimeline();
    const jul = timeline.find((m) => m.month === "2026-07");
    const jun = timeline.find((m) => m.month === "2026-06");
    assert.equal(jul.night_hours, 70.2, "loadTimeline dropped the key it was handed");
    assert.equal(jun.night_hours, undefined, "an unmeasured month must not gain a fabricated 0");
    const life = mod.lifetimeFromTimeline(timeline);
    assert.equal(life.night_hours, 70.2, "lifetime sums the measured months and skips the rest");
    // 39,918 events would have read as 39,918 h and pinned the arm at MAX_LEVEL.
    assert.ok(
      computeLevels(jun)[AX.OUTSIDE] < computeLevels(jul)[AX.OUTSIDE],
      "an unmeasured month must not outscore a measured one on its event count"
    );
  } finally {
    process.env.HOME = prev;
  }
});

// ---- monthly and lifetime must be the same function -------------------------

test("a single month can never outscore a lifetime that contains it", () => {
  // The cap made this possible: monthly buckets carried the UNCAPPED
  // projects_count while the all-time report carried the truncated list, so a
  // month drew a longer ENGINEERING arm than the whole history around it.
  const month = agg({
    total_input_tokens: 40e6, projects_count: 30,
    languages: { python: 5, rust: 2 },
    tool_call_counts: { Bash: 9000 }, models: { a: 1, b: 1 },
    night_hours: 30, active_days: 28, longest_streak_days: 28,
  });
  const life = agg({
    ...month,
    total_input_tokens: 240e6, projects_count: 120,
    languages: { python: 40, rust: 9, sql: 3 },
    tool_call_counts: { Bash: 60000 },
    night_hours: 300, active_days: 97, longest_streak_days: 44,
  });
  const m = computeLevels(month), l = computeLevels(life);
  for (let i = 0; i < ARMS; i++)
    assert.ok(l[i] >= m[i], `axis ${i}: lifetime ${l[i]} must be >= month ${m[i]}`);
});

// ---- every denominator tracks the constant ---------------------------------

test("no shipped file hardcodes the skill-point denominator", () => {
  // Raising MAX_LEVEL moved the star's footer to /35 and left FIVE literal
  // "/25"s behind — in the SVG card, the SVG <title>, the wrapped display, the
  // QR payload and the share line. The QR is the artifact people actually
  // send, so the one number designed to travel was the wrong one, and the two
  // halves of the same screen disagreed: "SKILL POINTS 27.7/35" above
  // "my skill star · 27.7/25" below.
  //
  // Caught by reading the terminal output, not by any test — the JSON reports
  // were right the whole time. A constant used in a template literal is a
  // constant nothing type-checks.
  const files = ["card.mjs", "starsvg.mjs", "wrapped.mjs", "star.mjs", "statspage.mjs"];
  for (const f of files) {
    const src = readFileSync(join(SRC, f), "utf8");
    assert.doesNotMatch(
      src, /toFixed\(1\)\}\/\d+/,
      `${f} hardcodes a skill-point denominator — derive it from ARMS * MAX_LEVEL`
    );
  }
});

test("the share line, the QR payload and the card all carry the real denominator", async () => {
  const { cardShare, cardStar } = await import("../src/wrapped.mjs");
  const levels = new Array(ARMS).fill(MAX_LEVEL);
  const want = `${(ARMS * MAX_LEVEL).toFixed(1)}/${ARMS * MAX_LEVEL}`;
  const agg = { total_sessions: 10, active_days: 5, languages: {}, models: {} };
  for (const [name, text] of [
    ["share line + QR payload", cardShare(levels, agg, "https://example.invalid").join("\n")],
    ["star card", cardStar(levels, agg).join("\n")],
  ]) {
    assert.ok(
      text.includes(want),
      `${name} must read ${want} — a shared number with the wrong denominator is the worst one to get wrong`
    );
    assert.ok(!/\/25\b/.test(text), `${name} still shows /25`);
  }
});
