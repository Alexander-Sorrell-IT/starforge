// sanitizeModel decides whether a model string is PUBLISHED VERBATIM or
// pseudonymised, and until now nothing tested it.
//
// The first mutation run ever pointed at scan.mjs gave it a 0.0% score — every
// one of its 15 mutants survived, including five of MODEL_SHAPE itself: the ^
// anchor removed, the $ anchor removed, the length bound removed, and both
// character classes negated. A regex with no anchors matches a SUBSTRING, so
// dropping either one turns "must look exactly like a model id" into "must
// contain something that looks like one" — and the string this function is
// handed comes out of a transcript.
//
// It is called from 23 places. That is not fifteen edge cases missed; it is one
// function nobody had tested, and one test kills all of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeModel } from "../src/scan.mjs";

test("a real model id is published verbatim", () => {
  // Kills: the negated character classes, the removed length bound, the
  // flipped `!==`, and the dropped `!` on the shape test — every one of which
  // turns this into a pseudonym.
  for (const id of ["claude-opus-4-6", "claude-opus-4-6-20260401",
                    "gpt-4.1", "gemini-3-pro-preview", "a", "A1",
                    "model_with:colons.and.dots-1"]) {
    assert.equal(sanitizeModel(id), id, `${id} was not published as itself`);
  }
});

test("it is trimmed before it is judged", () => {
  // Kills the MethodExpression mutant that drops .trim(): untrimmed, the
  // spaces fail MODEL_SHAPE and a perfectly ordinary model id is pseudonymised.
  assert.equal(sanitizeModel("  claude-opus-4-6  "), "claude-opus-4-6");
});

test("anything that is not a string is null, not a pseudonym", () => {
  // Kills the EqualityOperator and both ConditionalExpression mutants on the
  // typeof guard. null is "there was no model"; a pseudonym would be a claim
  // that there WAS one and it had to be hidden.
  for (const v of [null, undefined, 42, 0, true, {}, [], Symbol("x")]) {
    assert.equal(sanitizeModel(v), null, `${String(v)} did not read as absent`);
  }
});

test("an empty or blank string is null", () => {
  // Kills the BooleanLiteral and ConditionalExpression mutants on `!trimmed`.
  for (const v of ["", " ", "\t", "\n", "   \t \n "]) {
    assert.equal(sanitizeModel(v), null, `${JSON.stringify(v)} did not read as absent`);
  }
});

test("THE SHAPE IS ANCHORED AT BOTH ENDS", () => {
  // Kills the two Regex mutants that drop ^ and $. Without an anchor the test
  // becomes "contains something model-shaped", and every one of these strings
  // contains a model-shaped run.
  const notModels = [
    "!claude-opus-4-6",        // invalid head — the ^ mutant would accept it
    "claude-opus-4-6!",        // invalid tail — the $ mutant would accept it
    "/home/user/claude-opus",  // a path with a model-shaped tail
    "claude opus 4 6",         // spaces
    "model\nclaude-opus",      // a newline, and a model-shaped second line
  ];
  for (const v of notModels) {
    const got = sanitizeModel(v);
    assert.notEqual(got, v, `"${v}" was published verbatim`);
    assert.match(String(got), /^proj-[0-9a-f]{8}$/,
      `"${v}" produced ${got} rather than a pseudonym`);
  }
});

test("the length bound holds at exactly 64 characters", () => {
  // Kills the Regex mutant that drops {0,63}. 64 is the last accepted length:
  // one leading character plus 63.
  assert.equal(sanitizeModel("a".repeat(64)), "a".repeat(64));
  assert.match(String(sanitizeModel("a".repeat(65))), /^proj-[0-9a-f]{8}$/,
    "a 65-character string was published as a model name");
});

test("a key-shaped string never reaches the shape test and is waved through", () => {
  // The comment above this function says exactly that, and nothing checked it.
  // Synthetic, correct-LENGTH shapes — no real key material.
  const keyish = [
    "sk-ant-api03-" + "A".repeat(95),
    "ghp_" + "B".repeat(36),
    "sk-" + "C".repeat(48),
    "AKIAABCDEFGHIJKLMNOP",
  ];
  for (const v of keyish) {
    const got = sanitizeModel(v);
    assert.notEqual(got, v, "a key-shaped string was published verbatim as a model");
    assert.match(String(got), /^proj-[0-9a-f]{8}$/);
  }
});

test("EITHER failing condition pseudonymises, not both together", () => {
  // Kills the LogicalOperator mutant that turns || into &&. Under && a string
  // that redacts to ITSELF but fails the shape test is returned as-is — which
  // is every ordinary non-model string in a transcript.
  assert.match(String(sanitizeModel("has space")), /^proj-[0-9a-f]{8}$/,
    "a string that redacts to itself and fails the shape test was published");
});

test("the pseudonym is stable and reveals nothing", () => {
  const v = "/home/someone/secret-client/project";
  const a = sanitizeModel(v);
  assert.equal(a, sanitizeModel(v), "two machines must agree on one label");
  for (const part of ["someone", "secret-client", "project", "home"]) {
    assert.ok(!String(a).includes(part), `the pseudonym still carries "${part}"`);
  }
});
