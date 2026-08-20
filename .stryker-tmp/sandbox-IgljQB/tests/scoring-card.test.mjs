// @ts-nocheck
// The scoring breakdown must AGREE with the star, always.
//
// This card exists to answer "why is that arm short", which makes it an audit of
// the scorer. An audit that drifts from what it audits is worse than none: it
// carries the authority of showing its working while showing the wrong working.
// So the tests here are about agreement, not about formatting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLevels, explainLevels } from "../src/star.mjs";
import { cardScoring, box } from "../src/wrapped.mjs";
import { ARMS, MAX_LEVEL, AXES } from "../src/starsvg.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

const REAL = {
  total_input_tokens: 230e6,
  total_output_tokens: 15e6,
  projects_count: 27,
  languages: { python: 7159, markdown: 3395, solidity: 1550, shell: 832, typescript: 555 },
  tool_call_counts: { Bash: 86900 },
  models: { a: 1, b: 1, c: 1, d: 1 },
  night_hours: 114,
  longest_streak_days: 44,
  active_days: 95,
  hour_buckets: new Array(24).fill(0),
};

test("the axis weights are pinned to values, not just to each other", () => {
  // The agreement test below CANNOT catch a changed weight: the score and the
  // explanation are computed from one spec, so they agree even when the spec is
  // wrong. Proved by mutation — dropping ENGINEERING's language weight from 0.8
  // to 0.5 turned zero tests red, moving that arm by ~0.9 in silence.
  //
  // So these are value pins on a fixed aggregate. If a weight or a mid is
  // retuned on purpose these numbers change and that is fine — but it has to be
  // a decision someone makes, not a drift nobody sees.
  assert.deepEqual(computeLevels(REAL), [7, 5, 5.7, 4.2, 5.4]);

  // And one pin per term, so a single weight cannot move without a failure
  // naming the axis it moved.
  const byAxis = Object.fromEntries(explainLevels(REAL).map((r) => [r.axis, r]));
  const contrib = (axis, label) => byAxis[axis].terms.find((t) => t.label === label).contribution;
  assert.equal(contrib("ENGINEERING", "languages"), 2.35);
  assert.equal(contrib("ENGINEERING", "projects"), 2.69);
  assert.equal(contrib("OUTSIDE THE BOX", "models used"), 2.35);
  assert.equal(contrib("OUTSIDE THE BOX", "night hours"), 1.85);
  assert.equal(contrib("TENACITY", "longest streak"), 2.77);
  assert.equal(contrib("TENACITY", "active days"), 2.6);
  assert.equal(contrib("CODING", "tool calls"), 5.74);
});

test("the explained level equals the scored level, for every axis", () => {
  const scored = computeLevels(REAL);
  const explained = explainLevels(REAL);
  assert.equal(explained.length, ARMS);
  explained.forEach((row, i) => {
    assert.equal(row.level, scored[i], `${row.axis}: card says ${row.level}, star says ${scored[i]}`);
    assert.equal(row.axis, AXES[i], "axes must stay in star order");
  });
});

test("the terms add up to the level, unless the axis is capped", () => {
  // This is the check that catches a weight edited in one place: if the listed
  // contributions no longer sum to the arm, the breakdown is lying about how
  // the arm was produced.
  for (const agg of [REAL, { ...REAL, projects_count: 3, active_days: 9 }]) {
    for (const row of explainLevels(agg)) {
      const sum = row.terms.reduce((a, t) => a + t.contribution, 0);
      if (row.capped) {
        assert.ok(sum >= MAX_LEVEL - 0.05, `${row.axis} is marked capped but its terms sum to ${sum}`);
      } else {
        assert.ok(
          Math.abs(sum - row.level) <= 0.06,
          `${row.axis}: terms sum to ${sum.toFixed(2)} but the arm is ${row.level}`
        );
      }
    }
  }
});

test("capped is set exactly when the arm is at the ceiling", () => {
  for (const row of explainLevels({ ...REAL, total_input_tokens: 1e12 }))
    assert.equal(row.capped, row.level >= MAX_LEVEL, `${row.axis} mislabels its cap`);
  for (const row of explainLevels({}))
    assert.equal(row.capped, false, "an empty history has nothing capped");
});

test("every term reports the value that was actually read", () => {
  const byAxis = Object.fromEntries(explainLevels(REAL).map((r) => [r.axis, r]));
  const term = (axis, label) => byAxis[axis].terms.find((t) => t.label === label);
  assert.equal(term("TENACITY", "active days").value, 95);
  assert.equal(term("TENACITY", "longest streak").value, 44);
  assert.equal(term("OUTSIDE THE BOX", "night hours").value, 114);
  assert.equal(term("ENGINEERING", "languages").value, 5);
  assert.equal(term("ENGINEERING", "projects").value, 27);
});

test("the breakdown reads a month snapshot as happily as a full aggregate", () => {
  // Snapshots store the same quantities pre-reduced under different keys, and
  // the star already handles both. The card must not silently show zeros for a
  // month.
  const month = { input_tokens: 40e6, output_tokens: 2e6, projects_count: 9, tool_calls: 9000,
    languages: { rust: 3 }, models: { a: 1 }, night_hours: 30, active_days: 28, longest_streak_days: 28 };
  const rows = explainLevels(month);
  assert.deepEqual(rows.map((r) => r.level), computeLevels(month));
  assert.ok(rows[2].terms[0].value > 0, "tool calls must be read from the snapshot key too");
});

test("the card fits its frame and never throws", () => {
  for (const bad of [null, undefined, 0, "", [], { languages: "x" }, { projects: 3 }]) {
    let lines;
    assert.doesNotThrow(() => { lines = cardScoring(bad); }, `cardScoring(${JSON.stringify(bad)})`);
    if (!lines) continue;
    const widths = new Set(box(lines).split("\n").map((l) => strip(l).length));
    assert.equal(widths.size, 1, `ragged box for ${JSON.stringify(bad)}: ${[...widths].join(", ")}`);
  }
});

test("no line of the card is clipped by the frame", () => {
  // "doing" came out as "doin": the footer was one column over and box() clips.
  const lines = cardScoring(REAL).map(strip);
  for (const l of lines) assert.ok(l.length <= 60, `"${l}" is ${l.length} cols`);
  assert.match(lines.join("\n"), /doing more of one/, "the footer must survive intact");
});
