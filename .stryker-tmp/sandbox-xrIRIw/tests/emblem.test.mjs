// @ts-nocheck
// The emblem and the rank card.
//
// ASCII art is the easiest thing on a card to break silently: box() CLIPS at its
// width instead of wrapping, so art one column too wide loses its right edge and
// still looks deliberate. Nothing about the output says "this was cut".
import { test } from "node:test";
import assert from "node:assert/strict";
import { emblem, EMBLEM_W, TIERS_WITH_ART } from "../src/emblem.mjs";
import { cardRank, box } from "../src/wrapped.mjs";
import { rating } from "../src/archetype.mjs";
import { ARMS, MAX_LEVEL } from "../src/starsvg.mjs";

const flat = (v) => new Array(ARMS).fill(v);
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("every tier the rating function can return has art", () => {
  // A tier with no emblem falls back to the smallest one, which would be a
  // silent downgrade of the card rather than an error.
  const produced = new Set();
  for (let t = 0; t <= ARMS * MAX_LEVEL; t += 0.5) produced.add(rating(t));
  for (const tier of produced)
    assert.ok(
      TIERS_WITH_ART.includes(tier),
      `rating() can return "${tier}" but emblem.mjs has no art for it`
    );
});

test("no emblem is wide enough to be clipped by the card frame", () => {
  for (const tier of TIERS_WITH_ART)
    for (const row of emblem(tier))
      assert.ok(
        row.length <= EMBLEM_W,
        `${tier} art is ${row.length} cols, over the ${EMBLEM_W} the card can show: "${row}"`
      );
});

test("emblems carry no escape codes, so they survive a NO_COLOR capture", () => {
  for (const tier of TIERS_WITH_ART)
    for (const row of emblem(tier))
      assert.doesNotMatch(row, /\x1b/, `${tier} art has colour baked in`);
});

test("an unknown tier still draws something rather than throwing", () => {
  for (const bad of [null, undefined, "", "Z", 0, {}])
    assert.ok(Array.isArray(emblem(bad)) && emblem(bad).length, `emblem(${JSON.stringify(bad)})`);
});

test("the rank card fits the frame it is drawn in", () => {
  // Render it for real and measure the finished box: every row must be the same
  // width, which is the observable symptom of a clip or an overflow.
  const lines = cardRank(flat(7), { active_days: 95, longest_streak_days: 44 }, []);
  const rows = box(lines).split("\n").map((l) => strip(l).length);
  assert.equal(new Set(rows).size, 1, `the box is ragged: widths ${[...new Set(rows)].join(", ")}`);
});

test("the rank card never claims a population it cannot have seen", () => {
  const out = strip(cardRank(flat(7), { active_days: 95 }, []).join("\n"));
  // A CLAIM about other people, not the word itself: the card's own disclaimer
  // reads "not a percentile", and a check that fires on that would push someone
  // to delete the disclaimer to get green.
  assert.doesNotMatch(out, /top \d+%|of [\d,]+ (users|people|devs)|\b\d+(st|nd|rd|th) percentile/i,
    "the rank card must compare you to your own history, never to other people");
  assert.match(out, /not a percentile/, "and it should say so outright");
});

test("with real history the rank card places you against your own months", () => {
  const timeline = [
    { levels: flat(2) }, { levels: flat(3) }, { levels: flat(4) }, { levels: flat(5) },
  ];
  const out = strip(cardRank(flat(6), {}, timeline).join("\n"));
  assert.match(out, /your (best|above)|above \d+% of your \d+ months/,
    "it should locate the score inside the user's own timeline");
});

test("the rank card cannot be made to throw", () => {
  for (const lv of [null, undefined, [], "x", {}, [NaN, NaN]])
    for (const agg of [null, undefined, 0, [], { active_days: "x" }])
      for (const tl of [null, undefined, {}, [null], [{ levels: "no" }]])
        assert.doesNotThrow(() => cardRank(lv, agg, tl),
          `cardRank(${JSON.stringify(lv)}, ${JSON.stringify(agg)}, ${JSON.stringify(tl)})`);
});
