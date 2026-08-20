// One rule for what counts as a token count, held to the same table as deadreckon.
//
// readClawspring coerced with `Number(v) || 0`, the loosest coercion in the
// program: it rejects NaN and nothing else. jazzer.js — the first coverage-
// guided fuzzer ever pointed at these readers — reached it within seconds with
// `total_input_tokens: 1e400`, a number JSON accepts and JS parses as Infinity.
// It survived to r.total, and JSON.stringify writes Infinity as `null`. A
// machine's total silently became absent, which in this codebase is the same
// shape as zero.
//
// The same value CRASHES deadreckon (int(inf) raises OverflowError). Across
// nine malformed shapes the two programs disagreed on SIX.
//
// THE TABLE BELOW IS DUPLICATED VERBATIM IN deadreckon's test_token_count.py.
// That is deliberate: the rule is a cross-program agreement, and an agreement
// written down once on one side is a rule only one program is holding.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClawspring, tokenCount } from "../src/readers.mjs";

// shape as it appears in the JSON file -> [total tokens, sessions emitted]
const TABLE = [
  ["1e400",            0, 0],   // Infinity — passed Number(), crashed int()
  ["-1e400",           0, 0],
  ["-5000",            0, 0],   // deadreckon banked this as a real count
  ["1.5",              0, 0],   // a token is not divisible
  ['"12345"',      12345, 1],   // both programs have always taken this
  ["true",             0, 0],   // a flag is not a quantity
  ["null",             0, 0],
  ['"abc"',            0, 0],   // crashed int() with ValueError
  ["1e308",            0, 0],   // finite here, a 309-digit integer there
  ["9007199254740991", 9007199254740991, 1],  // 2**53-1, the largest agreed
  ["9007199254740992",  0, 0],  // 2**53, the first one they cannot share
  ["7",                7, 1],
  ["0",                0, 0],   // a rollup recording nothing is not a session
];

function readWith(raw) {
  const home = mkdtempSync(join(tmpdir(), "tc-"));
  const d = join(home, ".clawspring", "sessions", "daily", "d");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "session_a.json"),
    `{"session_id":"s1","total_input_tokens":${raw},"total_output_tokens":0}`);
  return readClawspring(home);
}

for (const [raw, total, sessions] of TABLE) {
  test(`a rollup holding ${raw} reads as ${total} across ${sessions} session(s)`, () => {
    const r = readWith(raw);
    assert.equal(r.total, total);
    assert.equal(r.sessions.length, sessions);
    assert.ok(Number.isSafeInteger(r.total), `total ${r.total} is not a safe integer`);
    assert.notEqual(JSON.stringify({ t: r.total }), '{"t":null}',
      "a total that serialises to null is absent wearing zero's clothes");
  });
}

test("tokenCount takes only what a count can be", () => {
  const cases = [
    [5, 5], [0, 0], ["12345", 12345], [" 7 ", 7], [5.0, 5],
    [Infinity, null], [-Infinity, null], [NaN, null],
    [-5, null], [1.5, null], [true, null], [false, null],
    [null, null], [undefined, null], ["abc", null], ["", null],
    [1e308, null], [2 ** 53, null], [2 ** 53 - 1, 2 ** 53 - 1],
  ];
  for (const [v, want] of cases) {
    assert.equal(tokenCount(v), want, `tokenCount(${String(v)})`);
  }
});

test("a rejected rollup does not take the good one beside it with it", () => {
  // Counted, or NAMED. A file dropped without a word is indistinguishable
  // from a file that held 0.
  const home = mkdtempSync(join(tmpdir(), "tc2-"));
  const d = join(home, ".clawspring", "sessions", "daily", "d");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "session_bad.json"),
    '{"session_id":"s1","total_input_tokens":1e400,"total_output_tokens":0}');
  writeFileSync(join(d, "session_ok.json"),
    '{"session_id":"s2","total_input_tokens":10,"total_output_tokens":0}');
  const r = readClawspring(home);
  assert.equal(r.sessions.length, 1);
  assert.equal(r.total, 10);
  assert.equal(r.unreadable.length, 1, "the rejected file is named, not dropped in silence");
  assert.match(r.unreadable[0], /session_bad\.json$/);
});
