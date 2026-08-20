// The receiving half of the signing scheme, which nothing had ever run.
//
// knip built the module graph from src/cli.mjs and every test file and found
// `verifyScorecard` unreachable from all of them: the CLI SIGNS a scoreboard
// payload (cli.mjs:744) and no code in this repo has ever verified one. It is
// correct today — all six checks below passed the first time they were run —
// but "correct today" and "watched" are different states, and this is the
// function the scoreboard's trust rests on. A signature nobody checks is a
// decoration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateFleetKey } from "../src/fleetkey.mjs";
import { signScorecard, verifyScorecard } from "../src/scorecard.mjs";

function signed() {
  const key = loadOrCreateFleetKey(mkdtempSync(join(tmpdir(), "sc-")));
  const payloadObj = {
    tier: "gold", archetype: "builder", total: 42,
    levels: { depth: 5.5 }, sessions: 10, active_days: 3,
  };
  return { key, ...signScorecard(payloadObj, key.privateKeyObj) };
}

test("an honest signature verifies", () => {
  const { key, payload, sig } = signed();
  assert.equal(verifyScorecard(key.publicKeyBytes, payload, sig), true);
});

test("one flipped byte of payload is rejected", () => {
  const { key, payload, sig } = signed();
  const b = Buffer.from(payload, "base64");
  b[5] ^= 0xff;
  assert.equal(verifyScorecard(key.publicKeyBytes, b.toString("base64"), sig), false);
});

test("one flipped byte of signature is rejected", () => {
  const { key, payload, sig } = signed();
  const b = Buffer.from(sig, "base64");
  b[5] ^= 0xff;
  assert.equal(verifyScorecard(key.publicKeyBytes, payload, b.toString("base64")), false);
});

test("another fleet's key does not verify this fleet's score", () => {
  const { payload, sig } = signed();
  const other = loadOrCreateFleetKey(mkdtempSync(join(tmpdir(), "sc2-")));
  assert.equal(verifyScorecard(other.publicKeyBytes, payload, sig), false);
});

test("malformed input returns false rather than throwing", () => {
  const { key, payload, sig } = signed();
  // A verifier that throws on junk is a verifier a submitter can crash.
  assert.equal(verifyScorecard(key.publicKeyBytes, payload, "!!!not base64!!!"), false);
  assert.equal(verifyScorecard(null, payload, sig), false);
  assert.equal(verifyScorecard(key.publicKeyBytes, null, sig), false);
});

test("re-signing the same payload gives the same bytes", () => {
  // signScorecard's docstring claims the field order is deterministic, so the
  // signature is stable. If that stopped being true, a submitter and the
  // scoreboard would disagree about what was signed.
  const key = loadOrCreateFleetKey(mkdtempSync(join(tmpdir(), "sc3-")));
  const obj = { tier: "gold", total: 1, levels: { a: 1 } };
  const a = signScorecard(obj, key.privateKeyObj);
  const b = signScorecard(obj, key.privateKeyObj);
  assert.equal(a.payload, b.payload);
  assert.equal(verifyScorecard(key.publicKeyBytes, a.payload, b.sig), true);
});
