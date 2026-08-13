// End-to-end audit-durability tests: run the REAL cli.mjs in a child process
// with a throwaway HOME and prove the run log survives paths that used to
// destroy it. These reproduce two red-team findings:
//   1. a tripped tripwire aborted the run before finishAudit(), so `verify`
//      afterwards reported PASS on a run that actually reached a network API;
//   2. an early process.exit() left no log at all.
//
// The tripwire case needs a network call inside the tool, so it runs against a
// COPY of src/ with one line injected — the real tree is never modified. The
// forbidden token is assembled from fragments here for the same reason
// src/verify.mjs does it: so this file cannot trip a source scan itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  cpSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { auditCheck } from "../src/verify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "sf-home-"));
  const proj = join(home, ".claude", "projects", "demo");
  mkdirSync(proj, { recursive: true });
  // enough for discoverSources() to find a source, so the run reaches the scan
  writeFileSync(
    join(proj, "session.jsonl"),
    JSON.stringify({ type: "user", timestamp: new Date().toISOString(), uuid: "u1" }) + "\n"
  );
  return home;
}

const logsIn = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("run-")).sort() : [];

function runCli(cli, home, argv, extraEnv = {}) {
  return spawnSync(process.execPath, [cli, ...argv], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, HOME: home, ...extraEnv },
  });
}

test("a tripped tripwire leaves its evidence on disk, and verify then FAILS", () => {
  // copy the tree and plant one accidental egress in the snapshot writer —
  // the exact call site (cli.mjs -> writeSnapshots) that is NOT inside a
  // try/catch, i.e. the path that used to abort before the log was written.
  const root = mkdtempSync(join(tmpdir(), "sf-copy-"));
  const src = join(root, "src");
  cpSync(SRC, src, { recursive: true });
  const snapPath = join(src, "snapshots.mjs");
  const injected = `globalThis.${"fet" + "ch"}("https://telemetry.example.com/snapshot");`;
  const patched = readFileSync(snapPath, "utf8").replace(
    /export function writeSnapshots\(([^)]*)\) \{/,
    (m) => `${m}\n  ${injected}`
  );
  assert.ok(patched.includes(injected), "injection point still exists in snapshots.mjs");
  writeFileSync(snapPath, patched);

  const home = fakeHome();
  const r = runCli(join(src, "cli.mjs"), home, ["--yes", "--no-providers"]);
  assert.equal(r.status, 1, `expected the tripwire to abort the run: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /starreckon tripwire: fetch/);

  const auditDir = join(home, ".starreckon", "audit");
  const files = logsIn(auditDir);
  assert.equal(files.length, 1, "the aborted run must still have written its log");
  const log = JSON.parse(readFileSync(join(auditDir, files[0]), "utf8"));
  assert.equal(log.tripwire_hits.length, 1);
  assert.equal(log.tripwire_hits[0].api, "fetch");
  assert.match(log.tripwire_hits[0].target, /telemetry\.example\.com/);
  assert.equal(log.complete, false, "an aborted run must not look like a clean one");
  assert.match(log.abort_reason, /tripwire|aborted/i);

  // and the whole point: verify must now report this, not PASS
  const check = auditCheck(auditDir);
  assert.equal(check.pass, false, JSON.stringify(check));
  assert.ok(check.findings.some((f) => /tripwire hit/.test(f)), JSON.stringify(check.findings));
  assert.ok(check.notes.some((n) => /INCOMPLETE/.test(n)), JSON.stringify(check.notes));
});

test("an early exit still writes a run log, and records the confinement claim", () => {
  const home = mkdtempSync(join(tmpdir(), "sf-home-")); // no session logs at all
  const r = runCli(join(SRC, "cli.mjs"), home, ["--yes", "--no-providers"], {
    STARRECKON_CONFINEMENT: "sandbox-exec",
  });
  // Contract change (publication review): having nothing to scan is not an
  // error and is not an abort. This path exits 0 and CLOSES its log. It used
  // to exit 1 with complete:false, which made bin/starreckon-proof.sh print
  // "FAIL … do not trust the no-egress claim" on any clean machine and made
  // `verify` report the run as INCOMPLETE. What this test still guards is the
  // original point: an early exit must not swallow the log, and the
  // confinement claim must be recorded and labelled. See
  // tests/shipblockers.test.mjs for the exit code and completeness in full.
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No AI-coding session logs found/);

  const auditDir = join(home, ".starreckon", "audit");
  const files = logsIn(auditDir);
  assert.equal(files.length, 1, "process.exit() must not swallow the run log");
  const log = JSON.parse(readFileSync(join(auditDir, files[0]), "utf8"));
  assert.equal(log.complete, true, "a deliberate early exit is a finished run, not an abort");
  assert.equal(log.abort_reason, null);
  assert.equal(log.run_index, 0);
  // the launcher's claim is recorded — and labelled as an unverified claim
  assert.equal(log.confinement.mode, "sandbox-exec");
  assert.equal(log.confinement.verified, false);
  assert.match(log.confinement.detail, /unverified/i);
  // the counter that makes tail truncation visible lives OUTSIDE the audit dir
  const counter = join(home, ".starreckon", "audit-counter.json");
  assert.ok(existsSync(counter));
  assert.equal(JSON.parse(readFileSync(counter, "utf8")).last_run_index, 0);
});

test("a normal run logs the snapshots it writes (not just --json/--card/--page)", () => {
  const home = fakeHome();
  const r = runCli(join(SRC, "cli.mjs"), home, ["--yes", "--no-providers"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);

  const auditDir = join(home, ".starreckon", "audit");
  const files = logsIn(auditDir);
  assert.equal(files.length, 1);
  const log = JSON.parse(readFileSync(join(auditDir, files[0]), "utf8"));
  assert.equal(log.complete, true);

  const snapDir = join(home, ".starreckon", "snapshots");
  const snaps = existsSync(snapDir) ? readdirSync(snapDir).filter((f) => f.endsWith(".json")) : [];
  assert.ok(snaps.length > 0, "the fixture must produce at least one monthly snapshot");
  // A default run also writes one SVG star per snapshot. Those are writes like
  // any other and must be logged like any other, so the assertion is set
  // equality against what is actually on disk rather than a count: that catches
  // an unlogged write AND a logged write that never happened, and it does not
  // quietly pass when a future artifact is added without an audit entry.
  const starDir = join(home, ".starreckon", "stars");
  const stars = existsSync(starDir) ? readdirSync(starDir).filter((f) => f.endsWith(".svg")) : [];
  assert.equal(stars.length, snaps.length, "every snapshot must get its own star");
  const onDisk = [
    ...snaps.map((s) => `/snapshots/${s}`),
    ...stars.map((s) => `/stars/${s}`),
  ].sort();
  const logged = log.writes
    .map((w) => w.path.replace(/^.*(\/(?:snapshots|stars)\/)/, "$1"))
    .sort();
  assert.deepEqual(
    logged,
    onDisk,
    `the log's writes must be exactly the files on disk: ${JSON.stringify(log.writes)}`
  );
  // and the log states the coverage it does NOT have
  assert.match(log.writes_scope, /--join-fleet/);
});
