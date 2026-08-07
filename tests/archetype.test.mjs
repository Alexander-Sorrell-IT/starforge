// The tier and the archetype.
//
// The tier existed before this module, written out three times with copied
// literal thresholds, calibrated for a 25-point star that became a 35-point
// star. Nothing failed when the denominator moved, because no test ever asked
// what fraction of the maximum "S+" was supposed to mean.
//
// The archetype is new, and the thing to guard is that it stays a DESCRIPTION.
// The model it is modelled on ranks you against other users; this tool has never
// seen another user's data, so any wording that implies a population is a claim
// it cannot back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rating, archetype, signature } from "../src/archetype.mjs";
import { ARMS, MAX_LEVEL } from "../src/starsvg.mjs";

const SRC = join(dirname(dirname(fileURLToPath(import.meta.url))), "src");
const MAX = ARMS * MAX_LEVEL;
const flat = (v) => new Array(ARMS).fill(v);

// ---- the tier tracks the constant -------------------------------------------

test("the top tier is near the top of the scale, not two thirds up it", () => {
  // The shipped bug: "S+" was `total >= 22`. On the 35-point star that is 63%,
  // so a middling run came back S+ and the grade stopped carrying information.
  const sPlusAt = [...Array(MAX * 10 + 1)].map((_, i) => i / 10).find((t) => rating(t) === "S+");
  assert.ok(
    sPlusAt / MAX >= 0.8,
    `S+ starts at ${sPlusAt}/${MAX} (${Math.round((sPlusAt / MAX) * 100)}%) — the top grade must mean the top of the scale`
  );
});

test("a perfect star is the top tier and an empty one is the bottom", () => {
  assert.equal(rating(MAX), "S+");
  assert.equal(rating(0), "C");
});

test("the tier never decreases as the score increases", () => {
  const order = ["C", "B", "A", "S", "S+"];
  let seen = 0;
  for (let t = 0; t <= MAX; t += 0.5) {
    const idx = order.indexOf(rating(t));
    assert.ok(idx >= seen, `rating fell from ${order[seen]} to ${order[idx]} at ${t}`);
    seen = idx;
  }
});

test("no shipped file still carries its own copy of the thresholds", () => {
  // The root cause was duplication: three copies, one constant change, zero
  // updated. This asserts the copies are gone rather than that they agree.
  // Match the LADDER (a numeric threshold deciding a grade), not the mere
  // mention of a tier name — emblem.mjs legitimately keys its art by tier, and
  // a check that flags that would be flagging the wrong thing.
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".mjs") && n !== "archetype.mjs"))
    assert.doesNotMatch(
      readFileSync(join(SRC, f), "utf8"),
      /[><]=?\s*\d+(\.\d+)?\s*\?\s*"(S\+|S|A|B|C)"/,
      `${f} inlines the rating ladder — import it from archetype.mjs instead`
    );
});

// ---- the archetype describes, never ranks -----------------------------------

test("the two longest arms pick the archetype", () => {
  const lv = flat(1);
  lv[0] = 7; // FIRST PRINCIPLES
  lv[2] = 6; // CODING
  assert.equal(archetype(lv).name, "The Deep Builder");
  const lv2 = flat(1);
  lv2[3] = 7; // OUTSIDE THE BOX
  lv2[4] = 6; // TENACITY
  assert.equal(archetype(lv2).name, "The Night Shift");
});

test("every pair of axes maps to an archetype — no shape falls through", () => {
  const seen = new Set();
  for (let a = 0; a < ARMS; a++)
    for (let b = 0; b < ARMS; b++) {
      if (a === b) continue;
      const lv = flat(0.5);
      lv[a] = 7;
      lv[b] = 6.5;
      const got = archetype(lv);
      assert.ok(got.name && got.blurb, `axes ${a}+${b} produced no archetype`);
      // A pair must never land on the balanced fallback: that name means
      // "nothing dominates", which is false when two arms are at the ceiling.
      assert.notEqual(got.name, "The Generalist", `axes ${a}+${b} fell through to the fallback`);
      seen.add(got.name);
    }
  assert.equal(seen.size, 10, `five axes make ten pairs, got ${seen.size} distinct archetypes`);
});

test("an even star is called balanced instead of having a pair invented for it", () => {
  assert.equal(archetype(flat(5)).name, "The Generalist");
  assert.equal(archetype(flat(0)).name, "Unforged");
});

test("the archetype is deterministic, including on ties", () => {
  const tie = flat(3);
  tie[1] = 7;
  tie[3] = 7; // an exact tie for the top arm
  const first = archetype(tie).name;
  for (let i = 0; i < 20; i++)
    assert.equal(archetype(tie).name, first, "a tie must resolve the same way every time");
});

test("nothing in the archetype implies other users exist", () => {
  // The whole privacy position is that this tool has never seen anyone else's
  // data. A grade is fine; "top 1% of 3,756 users" is a claim it cannot make.
  // Comments are stripped first. The header quotes "top 1% of 3,756 users" as
  // the thing this module deliberately does NOT do, and a check that fails on
  // its own explanation would just get the explanation deleted.
  const src = readFileSync(join(SRC, "archetype.mjs"), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  const strings = src.match(/"[^"]*"|`[^`]*`/g) ?? [];
  for (const s of strings)
    assert.doesNotMatch(
      s, /top \d+%|percentile|than \d+% of (users|people|devs)|rank(ed)? #?\d/i,
      `a population claim appears in a user-facing string: ${s}`
    );
});

test("no card can be made to throw by the archetype, whatever it is handed", () => {
  // signature() took a default parameter, which does not fire on null — and the
  // callers pass whatever they were handed. That broke 21 card combinations.
  for (const bad of [null, undefined, 0, "", [], {}, NaN, { night_hours: "x" }])
    for (const lv of [null, undefined, [], [NaN], "nope", {}]) {
      assert.doesNotThrow(() => archetype(lv), `archetype(${JSON.stringify(lv)})`);
      assert.doesNotThrow(() => signature(bad), `signature(${JSON.stringify(bad)})`);
      assert.equal(typeof signature(bad), "string");
    }
});

test("no archetype blurb is long enough to be clipped by the card frame", async () => {
  // box() CLIPS at its width instead of wrapping, so a long blurb silently lost
  // its last words: "then written down in " with the rest gone. The card now
  // wraps, and this keeps every blurb inside what one wrapped line can hold.
  const { wrapWords } = await import("../src/wrapped.mjs");
  const lvFor = (a, b) => {
    const lv = flat(0.5);
    lv[a] = 7; lv[b] = 6.5;
    return lv;
  };
  for (let a = 0; a < ARMS; a++)
    for (let b = 0; b < ARMS; b++) {
      if (a === b) continue;
      const arc = archetype(lvFor(a, b));
      for (const line of wrapWords(arc.blurb, 56))
        assert.ok(line.length <= 56, `"${line}" (${line.length}) will not fit the card`);
    }
});

test("the signature line states a measured fact, not a superlative", () => {
  assert.match(signature({ longest_streak_days: 44 }), /44 days/);
  assert.match(signature({ active_days: 0 }), /not enough history/);
});
