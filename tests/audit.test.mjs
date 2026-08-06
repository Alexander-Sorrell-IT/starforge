// Tests for src/audit.mjs (tamper-evident run log) and src/tripwire.mjs.
// Audit tests run FIRST: once the tripwire is armed it poisons net/fetch for
// the rest of this process (each node:test file is its own process, so that is
// contained here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import {
  startAudit,
  auditRead,
  auditWrite,
  finishAudit,
  verifyAuditChain,
  AUDIT_LIMITS,
} from "../src/audit.mjs";
import { armTripwire, tripwireStatus, TRIPWIRE_LIMITS } from "../src/tripwire.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freshDir() {
  return mkdtempSync(join(tmpdir(), "starforge-audit-"));
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
  assert.equal(audit.schema, 1);
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
  assert.deepEqual(v, { ok: true, breaks: [], runs: 0, total_tripwire_hits: 0 });
});

test("AUDIT_LIMITS and TRIPWIRE_LIMITS are frozen, honest, printable", () => {
  assert.ok(Object.isFrozen(AUDIT_LIMITS));
  assert.ok(AUDIT_LIMITS.length >= 3);
  assert.ok(AUDIT_LIMITS.some((l) => /wholesale rewrite/i.test(l)));
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
