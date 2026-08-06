// Tests for src/audit.mjs (tamper-evident run log) and src/tripwire.mjs.
// Audit tests run FIRST: once the tripwire is armed it poisons net/fetch for
// the rest of this process (each node:test file is its own process, so that is
// contained here).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import {
  startAudit,
  auditRead,
  auditWrite,
  finishAudit,
  abortAudit,
  armAuditExitHook,
  verifyAuditChain,
  counterFileFor,
  AUDIT_LIMITS,
} from "../src/audit.mjs";
import { armTripwire, tripwireStatus, TRIPWIRE_LIMITS } from "../src/tripwire.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The audit dir is a SUBDIR of a fresh temp root, because the run counter
// deliberately lives one level above it (~/.starforge/audit-counter.json). Each
// test therefore gets its own isolated counter file too.
function freshDir() {
  return join(mkdtempSync(join(tmpdir(), "starforge-audit-")), "audit");
}

const logNames = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("run-")).sort() : [];
const readLog = (dir, name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Re-chain logs [from..end] so a rewritten SUFFIX is self-consistent — the
// attack AUDIT_LIMITS says this design cannot detect.
function rechainFrom(dir, from) {
  const files = logNames(dir);
  for (let i = from; i < files.length; i++) {
    const log = readLog(dir, files[i]);
    log.prev_log_sha256 =
      i === 0 ? null : sha256(readFileSync(join(dir, files[i - 1])));
    writeFileSync(join(dir, files[i]), JSON.stringify(log, null, 2));
  }
}

async function runOnce(dir, argv = ["--json"]) {
  const audit = startAudit(argv, { dir });
  auditRead(audit, "claude");
  auditRead(audit, "claude");
  auditRead(audit, "codex");
  const content = auditWrite(audit, "/tmp/fake-report.json", '{"ok":true}');
  assert.equal(content, '{"ok":true}'); // pass-through
  const p = finishAudit(audit);
  assert.ok(p, "finishAudit returned a path");
  await sleep(3); // keep filenames strictly ordered
  return { audit, path: p };
}

test("startAudit hashes source files and records schema fields", async () => {
  const dir = freshDir();
  const audit = startAudit(["--card", "--roots=/Users/nobody/x"], { dir });
  assert.equal(audit.schema, 2);
  assert.equal(audit.complete, false); // not complete until finishAudit
  assert.equal(audit.abort_reason, null);
  assert.equal(audit.run_index, null); // assigned when the log is written
  // the log states its own write coverage instead of relying on the docs
  assert.match(audit.writes_scope, /auditWrite/);
  assert.match(audit.writes_scope, /--join-fleet/);
  assert.equal(audit.node_version, process.version);
  assert.ok(Object.keys(audit.source_files).includes("audit.mjs"));
  assert.ok(Object.keys(audit.source_files).includes("tripwire.mjs"));
  assert.match(audit.source_hash, /^[a-f0-9]{64}$/);
  for (const h of Object.values(audit.source_files)) assert.match(h, /^[a-f0-9]{64}$/);
  assert.ok(["sandbox-exec", "netns", "none"].includes(audit.confinement.mode));
  assert.equal(typeof audit.confinement.verified, "boolean");
  // internal fields must not serialize
  const round = JSON.parse(JSON.stringify(audit));
  assert.equal(round._dir, undefined);
  assert.equal(round.recorder, undefined);
});

test("chain intact -> verify ok, counts runs, reads and writes recorded", async () => {
  const dir = freshDir();
  const { audit } = await runOnce(dir);
  assert.deepEqual(audit.reads, { claude: 2, codex: 1 });
  assert.equal(audit.writes.length, 1);
  assert.equal(audit.writes[0].bytes, 11);
  assert.match(audit.writes[0].sha256, /^[a-f0-9]{64}$/);
  await runOnce(dir);
  await runOnce(dir);

  const files = readdirSync(dir).filter((f) => f.startsWith("run-")).sort();
  assert.equal(files.length, 3);
  // first log chains to null, later logs chain to their predecessor
  const first = JSON.parse(readFileSync(join(dir, files[0])));
  assert.equal(first.prev_log_sha256, null);
  const second = JSON.parse(readFileSync(join(dir, files[1])));
  assert.match(second.prev_log_sha256, /^[a-f0-9]{64}$/);

  const v = verifyAuditChain(dir);
  assert.equal(v.ok, true);
  assert.equal(v.breaks.length, 0);
  assert.equal(v.runs, 3);
  assert.equal(v.total_tripwire_hits, 0);
});

test("corrupt one log -> break detected at the right index", async () => {
  const dir = freshDir();
  await runOnce(dir);
  await runOnce(dir);
  await runOnce(dir);
  const files = readdirSync(dir).filter((f) => f.startsWith("run-")).sort();

  // Tamper with the middle log (index 1), keeping it valid JSON.
  const victim = join(dir, files[1]);
  const log = JSON.parse(readFileSync(victim));
  log.argv = ["--totally-different"];
  writeFileSync(victim, JSON.stringify(log, null, 2));

  const v = verifyAuditChain(dir);
  assert.equal(v.ok, false);
  assert.equal(v.breaks.length, 1);
  assert.equal(v.breaks[0].index, 1); // the edited log
  assert.equal(v.breaks[0].detected_at, 2); // exposed by its successor's pointer
});

test("unparseable log is itself reported as a break", async () => {
  const dir = freshDir();
  await runOnce(dir);
  await runOnce(dir);
  const files = readdirSync(dir).filter((f) => f.startsWith("run-")).sort();
  writeFileSync(join(dir, files[0]), "not json {");
  const v = verifyAuditChain(dir);
  assert.equal(v.ok, false);
  assert.ok(v.breaks.some((b) => b.index === 0 && /JSON/i.test(b.reason)));
});

test("finishAudit never throws when the dir is unwritable", async () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "i am a file, not a dir");
  const audit = startAudit([], { dir: join(blocker, "audit") }); // mkdir will fail
  auditRead(audit, "claude");
  let p = "unset";
  assert.doesNotThrow(() => {
    p = finishAudit(audit);
  });
  assert.equal(p, null);
});

test("verifyAuditChain on a missing dir reports zero runs, ok", () => {
  const v = verifyAuditChain(join(freshDir(), "does-not-exist"));
  assert.equal(v.ok, true);
  assert.deepEqual(v.breaks, []);
  assert.equal(v.runs, 0);
  assert.equal(v.total_tripwire_hits, 0);
  assert.equal(v.incomplete_runs, 0);
  assert.equal(v.sequence.last_index, null);
  assert.equal(v.sequence.counter_last_index, null);
});

// ---- gap detection: the things a bare hash chain cannot see -----------------

test("HEAD truncation (oldest logs deleted) is detected: the first log is not a genesis log", async () => {
  const dir = freshDir();
  for (let i = 0; i < 4; i++) await runOnce(dir, [`--run${i}`]);
  const files = logNames(dir);
  rmSync(join(dir, files[0]));
  rmSync(join(dir, files[1]));

  const v = verifyAuditChain(dir);
  assert.equal(v.runs, 2);
  assert.equal(v.ok, false, "deleting the oldest logs must not verify clean");
  assert.ok(
    v.breaks.some((b) => b.index === 0 && /genesis/i.test(b.reason)),
    JSON.stringify(v.breaks)
  );
  // the survivors still carry the proof: a pointer at a log that is gone
  assert.match(readLog(dir, logNames(dir)[0]).prev_log_sha256, /^[a-f0-9]{64}$/);
});

test("TAIL truncation (newest logs deleted) is detected by the counter kept outside the dir", async () => {
  const dir = freshDir();
  for (let i = 0; i < 4; i++) await runOnce(dir, [`--run${i}`]);
  const counter = counterFileFor(dir);
  assert.ok(existsSync(counter), "the run counter lives outside the audit dir");
  assert.equal(JSON.parse(readFileSync(counter, "utf8")).last_run_index, 3);

  const files = logNames(dir);
  rmSync(join(dir, files[3]));
  rmSync(join(dir, files[2]));

  const v = verifyAuditChain(dir);
  assert.equal(v.runs, 2);
  assert.equal(v.sequence.last_index, 1);
  assert.equal(v.sequence.counter_last_index, 3);
  assert.equal(v.ok, false, "the chain alone cannot see this; the counter can");
  assert.ok(
    v.breaks.some((b) => /tail truncation/i.test(b.reason) && /index 3/.test(b.reason)),
    JSON.stringify(v.breaks)
  );
});

test("deleting the ENTIRE audit dir is detected while the counter survives", async () => {
  const dir = freshDir();
  for (let i = 0; i < 3; i++) await runOnce(dir, [`--run${i}`]);
  for (const f of logNames(dir)) rmSync(join(dir, f));

  const v = verifyAuditChain(dir);
  assert.equal(v.runs, 0);
  assert.equal(v.ok, false);
  assert.ok(
    v.breaks.some((b) => /history was deleted/i.test(b.reason)),
    JSON.stringify(v.breaks)
  );

  // and the NEXT run does not quietly restart the numbering at 0
  await runOnce(dir, ["--after-wipe"]);
  const v2 = verifyAuditChain(dir);
  assert.equal(v2.sequence.first_index, 3);
  assert.ok(
    v2.breaks.some((b) => /history starts at run_index 3/.test(b.reason)),
    JSON.stringify(v2.breaks)
  );
});

test("a deleted MIDDLE log breaks the chain AND leaves a run_index gap", async () => {
  const dir = freshDir();
  for (let i = 0; i < 4; i++) await runOnce(dir, [`--run${i}`]);
  rmSync(join(dir, logNames(dir)[1]));

  const v = verifyAuditChain(dir);
  assert.equal(v.ok, false);
  assert.ok(v.breaks.some((b) => /no longer hashes/.test(b.reason)), "chain break");
  assert.ok(
    v.breaks.some((b) => /run_index jumps from 0 to 2 — 1 run log\(s\) missing/.test(b.reason)),
    JSON.stringify(v.breaks)
  );
});

test("HONEST LIMIT: a self-consistent SUFFIX rewrite still passes — AUDIT_LIMITS must say so", async () => {
  const dir = freshDir();
  for (let i = 0; i < 4; i++) await runOnce(dir, [`--run${i}`]);

  // plant a tripwire hit in log 2 and re-chain the suffix: verify sees it
  const files = logNames(dir);
  const victim = readLog(dir, files[2]);
  victim.tripwire_hits = [{ api: "fetch", target: "https://x.example", at: "t" }];
  writeFileSync(join(dir, files[2]), JSON.stringify(victim, null, 2));
  rechainFrom(dir, 3);
  assert.equal(verifyAuditChain(dir).total_tripwire_hits, 1);

  // now the attacker removes the hit from log 2 and re-chains logs 2..3 only.
  // Logs 0 and 1 are untouched. This is NOT detected — a 2-file edit, not a
  // 4-file forgery — which is exactly what the limits must claim.
  const cleaned = readLog(dir, files[2]);
  cleaned.tripwire_hits = [];
  writeFileSync(join(dir, files[2]), JSON.stringify(cleaned, null, 2));
  rechainFrom(dir, 3);

  const v = verifyAuditChain(dir);
  assert.equal(v.ok, true, "documented hole: a rewritten suffix is self-consistent");
  assert.equal(v.total_tripwire_hits, 0);
  assert.ok(
    AUDIT_LIMITS.some((l) => /SUFFIX/i.test(l) && /rewritten or deleted/i.test(l)),
    "the limit text must state the suffix attack this test just performed"
  );
});

// ---- durability: an aborted run still leaves its log ------------------------

test("abortAudit writes an incomplete log, and finishAudit later updates the SAME file", async () => {
  const dir = freshDir();
  const audit = startAudit(["--yes"], { dir });
  auditRead(audit, "claude");
  const p1 = abortAudit(audit, "boom: something threw");
  assert.ok(p1);
  assert.equal(logNames(dir).length, 1);
  const aborted = readLog(dir, logNames(dir)[0]);
  assert.equal(aborted.complete, false);
  assert.match(aborted.abort_reason, /boom/);
  assert.equal(aborted.run_index, 0);
  assert.equal(verifyAuditChain(dir).incomplete_runs, 1);

  const p2 = finishAudit(audit);
  assert.equal(p2, p1, "one run is one log — the flush is updated, not duplicated");
  assert.equal(logNames(dir).length, 1);
  const done = readLog(dir, logNames(dir)[0]);
  assert.equal(done.complete, true);
  assert.equal(done.abort_reason, null);
  assert.equal(done.run_index, 0);
  const v = verifyAuditChain(dir);
  assert.equal(v.ok, true);
  assert.equal(v.incomplete_runs, 0);
});

test("no string in a written log can trip verify's transcript heuristic (>400 chars)", async () => {
  const dir = freshDir();
  const { path } = await runOnce(dir);
  const long = [];
  const walk = (n) => {
    if (typeof n === "string") {
      if (n.length > 400 && (n.match(/ /g) ?? []).length > 40) long.push(n.slice(0, 60));
      return;
    }
    if (n && typeof n === "object") for (const v of Object.values(n)) walk(v);
  };
  walk(JSON.parse(readFileSync(path, "utf8")));
  assert.deepEqual(long, [], "a log that fails outputScrub would make verify FAIL on itself");
});

test("AUDIT_LIMITS and TRIPWIRE_LIMITS are frozen, honest, printable", () => {
  assert.ok(Object.isFrozen(AUDIT_LIMITS));
  assert.ok(AUDIT_LIMITS.length >= 3);
  // the true attack surface: ANY SUFFIX, not just "every log" or "the newest"
  assert.ok(AUDIT_LIMITS.some((l) => /SUFFIX/i.test(l)));
  assert.ok(
    AUDIT_LIMITS.some((l) => /middle of a history whose tail is intact/i.test(l))
  );
  // the gap checks are described WITHOUT overclaiming
  assert.ok(AUDIT_LIMITS.some((l) => /run_index/.test(l) && /counter file/i.test(l)));
  // a lost log is disclosed, not hidden
  assert.ok(
    AUDIT_LIMITS.some((l) => /[Aa]bsence of a log is not evidence of absence/.test(l))
  );
  // write coverage is stated
  assert.ok(AUDIT_LIMITS.some((l) => /--join-fleet/.test(l)));
  // and the old, softer phrasing is gone
  assert.ok(!AUDIT_LIMITS.some((l) => /wholesale rewrite/i.test(l)));
  assert.ok(Object.isFrozen(TRIPWIRE_LIMITS));
  assert.ok(TRIPWIRE_LIMITS.some((l) => /Worker/i.test(l)));
  assert.ok(TRIPWIRE_LIMITS.some((l) => /child_process/i.test(l)));
  assert.ok(TRIPWIRE_LIMITS.some((l) => /tcp_wrap/i.test(l)));
  assert.ok(TRIPWIRE_LIMITS.some((l) => /[Ff]ilesystem/.test(l)));
  assert.ok(TRIPWIRE_LIMITS.some((l) => /not a security boundary/i.test(l)));
});

// ---- tripwire: everything below arms the patches; network APIs in this
// process are poisoned from here on (deliberate — this file runs in its own
// node --test child process).
test("tripwire records and throws on fetch and net.connect, into audit.recorder", async () => {
  const dir = freshDir();
  const audit = startAudit(["tripwire-test"], { dir });
  const status = armTripwire(audit.recorder);
  assert.equal(status.armed, true);

  assert.throws(
    () => globalThis.fetch("https://example.com/beacon"),
    /tripwire: fetch/
  );
  assert.throws(() => net.connect(443, "evil.example"), /tripwire: net\.connect/);
  assert.throws(() => new net.Socket().connect(80, "evil.example"), /tripwire/);

  assert.equal(audit.tripwire_hits.length, 3);
  assert.equal(audit.tripwire_hits[0].api, "fetch");
  assert.equal(audit.tripwire_hits[0].target, "https://example.com/beacon");
  assert.equal(audit.tripwire_hits[1].api, "net.connect");
  assert.match(audit.tripwire_hits[1].target, /evil\.example:443/);
  for (const h of audit.tripwire_hits) assert.ok(Date.parse(h.at) > 0);

  const s = tripwireStatus();
  assert.equal(s.armed, true);
  assert.equal(s.hits.length, 3);

  // hits persist into the run log and roll up in verify
  finishAudit(audit);
  const v = verifyAuditChain(dir);
  assert.equal(v.ok, true);
  assert.equal(v.total_tripwire_hits, 3);
});

test("a tripwire hit is on DISK at the moment of the hit — before any finishAudit", () => {
  const dir = freshDir();
  const audit = startAudit(["--yes"], { dir });
  armTripwire(audit.recorder); // rebinds the recorder onto this run's log
  assert.deepEqual(logNames(dir), [], "nothing written yet");

  // the throw is what used to kill the run before the log existed
  assert.throws(() => globalThis.fetch("https://telemetry.example/beacon"), /tripwire/);

  // NOTE: finishAudit() is deliberately never called — this is the abort path.
  const files = logNames(dir);
  assert.equal(files.length, 1, "the hit must survive the abort");
  const log = readLog(dir, files[0]);
  assert.equal(log.tripwire_hits.length, 1);
  assert.equal(log.tripwire_hits[0].api, "fetch");
  assert.equal(log.tripwire_hits[0].target, "https://telemetry.example/beacon");
  assert.equal(log.complete, false);
  assert.match(log.abort_reason, /tripwire/);

  const v = verifyAuditChain(dir);
  assert.equal(v.total_tripwire_hits, 1, "verify can only count what reached the disk");
  assert.equal(v.incomplete_runs, 1);
});

test("the confinement field records the launcher's claim, always as unverified", () => {
  const dir = freshDir();
  const prev = process.env.STARFORGE_CONFINEMENT;
  try {
    process.env.STARFORGE_CONFINEMENT = "sandbox-exec";
    const claimed = startAudit([], { dir }).confinement;
    assert.equal(claimed.mode, "sandbox-exec");
    assert.equal(claimed.verified, false);
    assert.match(claimed.detail, /unverified self-report/i);

    process.env.STARFORGE_CONFINEMENT = "definitely-a-sandbox";
    const bogus = startAudit([], { dir }).confinement;
    assert.equal(bogus.mode, "none", "an unrecognized value is not a confinement claim");
    assert.match(bogus.detail, /unrecognized/i);

    delete process.env.STARFORGE_CONFINEMENT;
    const none = startAudit([], { dir }).confinement;
    assert.equal(none.mode, "none");
    // "none" must not be read as "definitely unconfined"
    assert.match(none.detail, /did not set STARFORGE_CONFINEMENT/);
  } finally {
    if (prev === undefined) delete process.env.STARFORGE_CONFINEMENT;
    else process.env.STARFORGE_CONFINEMENT = prev;
  }
});

test("armAuditExitHook writes the log when the process exits without finishing", () => {
  // the hook is process-global, so it is exercised in a child process
  const dir = freshDir();
  const audit = startAudit([], { dir });
  const hook = armAuditExitHook(audit);
  assert.equal(typeof hook, "function");
  assert.equal(armAuditExitHook(audit), hook, "arming twice must not double-register");
  process.off("exit", hook); // do not let it fire when THIS test process exits
  hook(); // simulate the exit
  const files = logNames(dir);
  assert.equal(files.length, 1);
  assert.equal(readLog(dir, files[0]).complete, false);
});

test("tripwire patches resist trivial restoration where lockable", () => {
  const before = globalThis.fetch;
  try {
    globalThis.fetch = () => "restored"; // should be ignored (writable:false)
  } catch {}
  assert.equal(globalThis.fetch, before, "fetch patch survived reassignment");
  assert.throws(() => Object.defineProperty(globalThis, "fetch", { value: 1 }));
  const s = tripwireStatus();
  assert.ok(Array.isArray(s.unlockable)); // any fallback assignments are disclosed
});
