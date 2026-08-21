// Two `human` formatters, and one of them turns absent into zero.
//
// statspage.mjs and wrapped.mjs both render a token count for a reader, and
// they disagree in four ways:
//
//   value      statspage.mjs   wrapped.mjs
//   null       null            0            <- absent rendered as zero
//   NaN        null            0
//   Infinity   null            InfinityB
//   1.5e12     1.5T            1500.0B      <- no trillion tier
//
// LATENT, NOT LIVE, and that was checked rather than assumed: every wrapped.mjs
// call site read so far guards first — the floor block returns null unless
// floor and onDisk are both positive — so no absent value reaches it today.
// That is a property of the CALLERS. It is one refactor away from not being
// true, on the artifact people actually share.
//
// This pins statspage.mjs's behaviour, which is the one that follows the
// project's own rule that 0 is a SENTENCE and not a stand-in for "no answer".
import { test } from "node:test";
import assert from "node:assert/strict";
import { human } from "../src/statspage.mjs";

test("an absent value is null, never zero", () => {
  for (const v of [null, undefined, NaN, Infinity, -Infinity, "abc"]) {
    assert.equal(human(v), null,
      `human(${String(v)}) rendered as ${human(v)} — a reader cannot tell that `
      + "from a real zero");
  }
});

test("a real zero is zero", () => {
  // A STRING "0", not the number 0 — read off the function, not assumed. The
  // distinction that matters is 0 against null, and both are preserved: a
  // reader sees "0" for a real zero and nothing at all for an absent one.
  assert.equal(human(0), "0", "the one case that MUST read as zero");
  assert.notEqual(human(0), human(null), "zero and absent must not render alike");
});

test("the tiers go up to trillions", () => {
  assert.equal(human(1_500), "1.5K");
  assert.equal(human(2_400_000), "2.4M");
  assert.equal(human(3_100_000_000), "3.1B");
  assert.equal(human(1_500_000_000_000), "1.5T",
    "without a T tier this reads 1500.0B, which nobody parses as 1.5 trillion");
});

test("a fleet-sized number is legible", () => {
  // 91,013,536,771 is what this fleet actually holds.
  assert.equal(human(91_013_536_771), "91B");
});

test("negatives keep their sign", () => {
  assert.equal(human(-2_400_000), "-2.4M",
    "a delta can be negative and dropping the sign inverts its meaning");
});
