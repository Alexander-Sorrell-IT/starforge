// Guards for the claims the census found UNGUARDED — batch 6.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeNewFile, logLayerRun, dayDir } from "../src/layerlog.mjs";
import { runProbe } from "../src/confine.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "cb6-"));

// ── layerlog — a run record is REFUSED, never overwritten ───────────────────
//
// The ledger is a ledger: records accumulate and nothing rewrites one. When a
// name is taken, the write must FAIL AND SAY SO — a refusal nobody can see is
// indistinguishable from a record that was never written, and this file's whole
// job is being the thing you can go back and read.

test("writeNewFile refuses an existing file and says no by returning false", () => {
  const d = tmp();
  const f = join(d, "rec.json");
  assert.equal(writeNewFile(f, "first"), true);
  assert.equal(writeNewFile(f, "second"), false, "an existing record was overwritten");
  assert.equal(readFileSync(f, "utf8"), "first", "the original record did not survive");
});

test("it leaves no temp file behind when it refuses", () => {
  const d = tmp();
  const f = join(d, "rec.json");
  writeNewFile(f, "first");
  writeNewFile(f, "second");
  const strays = readdirSync(d).filter((n) => n.includes(".tmp-"));
  assert.deepEqual(strays, [], `left ${strays.join(", ")} behind`);
});

test("a refusal is REPORTED, not silent", () => {
  // The key is `record`, not `file` — read off the real return value rather
  // than assumed, because a guessed key reads undefined and undefined takes
  // the same branch as a genuine refusal.
  //
  // The mutation the census applies blanks result.error. The record still is
  // not overwritten — but nobody can tell it was refused, and in this codebase
  // a silent refusal and a successful write are the same output.
  const home = tmp();
  const r = logLayerRun({ layer: "models", event: "query", outcome: "ok" }, { home });
  assert.ok(r, "logLayerRun returned nothing at all");
  if (r.record) {
    assert.equal(r.ok, true);
    assert.equal(r.error, null, "a successful write reported an error");
  } else {
    assert.equal(r.ok, false);
    assert.ok(typeof r.error === "string" && r.error.length > 0,
      "no record AND no error — the refusal is invisible");
  }
});

test("two records written in the same moment do not collide", () => {
  const home = tmp();
  const a = logLayerRun({ layer: "models", event: "query", outcome: "ok" }, { home });
  const b = logLayerRun({ layer: "models", event: "query", outcome: "ok" }, { home });
  assert.ok(a.record && b.record,
    `one of the two was refused: ${a.error ?? ""} ${b.error ?? ""}`);
  assert.notEqual(a.record, b.record, "two runs wrote to one file");
  const records = readdirSync(dayDir(home))
    .filter((n) => n.endsWith(".json") && n !== "ledger.json");
  assert.equal(records.length, 2, `expected two run records, found ${records.join(", ")}`);
});

// ── confine — a control that CANNOT succeed is not reported as blocked ──────
//
// The proof matters more than the result. If confinement cannot be established
// on this machine, the honest answer is "this could not be run" — reporting it
// as BLOCKED means the egress proof passes on a machine where nothing was ever
// confined, which is the strongest claim this program makes failing open.

test("a probe that cannot be confined reports the failure, not a block", async () => {
  const r = await runProbe({ confined: true });
  assert.ok(r && typeof r === "object");
  if (r.ok === false) {
    assert.ok(typeof r.error === "string" && r.error.length > 0,
      "a failed probe must say why — an empty reason is the same as no reason");
    assert.notEqual(r.blocked, true,
      "a control that could not run was reported as having blocked something");
  } else {
    // Confinement WAS available here. Then it must carry a real exit code.
    assert.equal(typeof r.code, "number",
      "a probe reported ok with no exit code to stand behind it");
  }
});

test("ok is decided by whether confinement could actually be established", async () => {
  // TIED TO THE MACHINE'S REAL ANSWER, not to a branch that happens to run.
  // The first version of this test accepted `{ ok: true, code: 0, blocked: true }`
  // from a machine where confinement is IMPOSSIBLE, because 0 is a number and
  // the else-branch asked nothing else. On this machine unshare is installed
  // and the kernel refuses it, so `recommended` is null and the only honest
  // answer is a failure with a reason.
  const { detectConfinement } = await import("../src/confine.mjs");
  const det = detectConfinement();
  const r = await runProbe({ confined: true });
  if (!det.recommended) {
    assert.equal(r.ok, false,
      "confinement cannot be established here, and the probe reported success");
    assert.notEqual(r.blocked, true,
      "a control that could not run was reported as having blocked something");
    assert.ok(typeof r.error === "string" && r.error.length > 0);
  } else {
    assert.equal(typeof r.code, "number");
  }
});

test("an unconfined probe never claims to be a block", async () => {
  const r = await runProbe({ confined: false });
  assert.notEqual(r.blocked, true,
    "an unconfined run reported egress as blocked, which proves nothing at all");
});
