// Round-trip and merge-semantics tests for src/fleet.mjs, against the
// invariants the Python pipeline (combine.py + check_consistency.py) enforces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIELDS,
  providerOf,
  machineFloor,
  readFleet,
  writeMachineFolder,
  gatherHardware,
  snapshotDigest,
  archiveSnapshots,
  archiveStamp,
} from "../src/fleet.mjs";

const F4 = (i, cw, cr, o) => ({
  input_tokens: i,
  cache_creation_input_tokens: cw,
  cache_read_input_tokens: cr,
  output_tokens: o,
});

// ---- fixture fleet ---------------------------------------------------------
// box-a: written by writeMachineFolder (the round trip). One account with two
// profiles (accumulate-by-machine + counter-once-per-account), one user:<uid>
// profile row (relabel), claude + codex sessions, a stats_cache counter.
// box-b: hand-written FLAT layout (pre-split), totals.json only.
// never-box: registered in machines.json, no folder.
function makeFixtureFleet() {
  const root = mkdtempSync(join(tmpdir(), "starreckon-fleet-"));
  writeFileSync(join(root, "machines.json"), JSON.stringify({
    machines: [
      { folder: "box-a", label: "Box A" },
      { folder: "box-b", label: "Box B" },
      { folder: "never-box", label: "Never Box" },
    ],
  }));
  writeFileSync(join(root, "accounts.json"), JSON.stringify({
    accounts: [{ email: "a@x.com" }, { email: "ghost@x.com" }],
    profiles: [{ userID: "deadbeef4be462f3a2f9620e".padEnd(64, "0"), label: "API profile" }],
  }));

  writeMachineFolder(root, "box-a", {
    label: "Box A",
    generatedAt: "2026-02-01T12:00:00-06:00",
    accounts: [
      { // profile 1 of a@x.com — 400 tokens on 2026-01-05
        account: "a@x.com",
        config_dir: "~/.claude",
        sessions: 2, turns: 10,
        totals: F4(100, 100, 100, 100),
        by_model: { "claude-opus-4-6": F4(100, 100, 100, 100) },
        by_day: { "2026-01-05": F4(100, 100, 100, 100) },
      },
      { // profile 2 of the SAME account — 250 tokens on 2026-01-15 (> counter)
        account: "a@x.com",
        config_dir: "~/.claude-copy",
        sessions: 1, turns: 5,
        totals: F4(50, 50, 100, 50),
        by_model: { "claude-fable-5": F4(50, 50, 100, 50) },
        by_day: { "2026-01-15": F4(50, 50, 100, 50) },
      },
      { // emailless profile — relabeled via accounts.json prefix match
        account: "user:deadbeef4be4",
        user_id: "deadbeef4be462f3a2f9620e".padEnd(64, "0"),
        sessions: 1, turns: 2,
        totals: F4(20, 0, 20, 10),
        by_model: { "deepseek-v4-pro": F4(20, 0, 20, 10) },
        by_day: { "2026-01-15": F4(20, 0, 20, 10) },
      },
    ],
    sessions: [
      { cli: "claude", session_id: "s1", account: "a@x.com", start: "2026-01-05T01:00:00Z",
        end: "2026-01-05T02:00:00Z", turns: 10, tokens: F4(100, 100, 100, 100),
        duration_min: 60, model: "claude-opus-4-6" },
      { cli: "claude", session_id: "s2", account: "a@x.com", start: "2026-01-15T01:00:00Z",
        end: "2026-01-15T01:30:00Z", turns: 5, tokens: F4(50, 50, 100, 50),
        duration_min: 30, model: "claude-fable-5" },
      { cli: "claude", session_id: "s3", account: "user:deadbeef4be4",
        start: "2026-01-15T03:00:00Z", end: "2026-01-15T03:10:00Z", turns: 2,
        tokens: F4(20, 0, 20, 10), duration_min: 10, model: "deepseek-v4-pro" },
      { cli: "codex", session_id: "s4", account: "codex (local)",
        start: "2026-01-16T01:00:00Z", end: "2026-01-16T01:20:00Z", turns: 3,
        tokens: F4(60, 0, 0, 40), duration_min: 20, model: "gpt-6" },
    ],
    statsCache: [
      { profile: ".claude", account: "a@x.com", total: 1000,
        sessions: 40, messages: 900, first_session: "2025-11-01", last_computed: "2026-01-10" },
    ],
  });

  // box-b: pre-split flat layout, no sessions.json, no hardware.json.
  mkdirSync(join(root, "box-b"));
  writeFileSync(join(root, "box-b", "totals.json"), JSON.stringify({
    machine: "Box B",
    generated_at: "2026-01-20T09:00:00-06:00",
    scanner_version: "abcabcabcabc",
    anthropic_only_tokens: 0,
    by_provider: { openai: 300 },
    other_tools: [],
    grand_total_tokens: 300,
    accounts: [{
      config_dir: "~/.claude",
      sessions: 3, files: { main: 3, subagent: 0 }, turns: 12,
      totals: F4(100, 50, 100, 50),
      by_kind: { main: F4(100, 50, 100, 50), subagent: F4(0, 0, 0, 0) },
      by_provider: { openai: F4(100, 50, 100, 50) },
      by_model: { "gpt-6": F4(100, 50, 100, 50) },
      by_day: { "2026-01-18": F4(100, 50, 100, 50) },
      by_project: {},
      account: "b@x.com",
      user_id: null,
      identity: { auth: "oauth", email: "b@x.com" },
      grand_total: 300,
    }],
  }));
  return root;
}

// ---- providerOf ------------------------------------------------------------

test("providerOf matches analyze_tokens.provider_of", () => {
  assert.equal(providerOf("claude-opus-4-6"), "anthropic");
  assert.equal(providerOf("Claude-Fable-5"), "anthropic");
  assert.equal(providerOf("deepseek-v4-pro"), "deepseek");
  assert.equal(providerOf("gemini-3-pro"), "google");
  assert.equal(providerOf("gemma-7b"), "google");
  assert.equal(providerOf("gpt-6"), "openai");
  assert.equal(providerOf("o3-mini"), "openai");
  assert.equal(providerOf("codex-mini"), "openai");
  assert.equal(providerOf("grok-4"), "xai");
  assert.equal(providerOf("Mixtral-8x7B"), "mistral");
  assert.equal(providerOf("kimi-k2"), "moonshot");
  assert.equal(providerOf("glm-5"), "zhipu");
  assert.equal(providerOf("<synthetic>"), "synthetic");
  assert.equal(providerOf("unknown"), "synthetic");
  assert.equal(providerOf(""), "synthetic");
  assert.equal(providerOf(null), "synthetic");
  assert.equal(providerOf("weird-model-x"), "other");
  assert.equal(providerOf("antigravity-v1"), "antigravity"); // was missing from scanners.mjs
  assert.equal(providerOf("copilot-gpt-4"), "copilot");
});

// ---- graceful absence ------------------------------------------------------

test("readFleet on a missing or empty dir returns empty results, never throws", () => {
  const r1 = readFleet("/nonexistent/path/starreckon-test");
  assert.deepEqual(r1.machines, []);
  assert.deepEqual(r1.accounts, []);
  assert.deepEqual(r1.fleetTotals, { onDisk: 0, floor: 0 });
  const empty = mkdtempSync(join(tmpdir(), "starreckon-empty-"));
  const r2 = readFleet(empty);
  assert.deepEqual(r2.fleetTotals, { onDisk: 0, floor: 0 });
});

// ---- round trip ------------------------------------------------------------

test("writeMachineFolder -> readFleet round trip with combine.py semantics", () => {
  const root = makeFixtureFleet();
  const fleet = readFleet(root);

  // On disk: box-a 650+50=700, box-b 300.
  assert.equal(fleet.fleetTotals.onDisk, 1000);

  // Floor: a@x.com counter 1000 owns everything <= 2026-01-10; transcripts own
  // days strictly after (250) -> max(1000+250, seen 650) = 1250, applied ONCE
  // for the account despite two profiles. API profile: no counter -> 50.
  // codex (non-claude) adds 100. box-b (no sessions.json) falls back to 300.
  assert.equal(fleet.fleetTotals.floor, 1250 + 50 + 100 + 300);

  // Machines: sorted by -total, plus the never-scanned roster row.
  assert.equal(fleet.machines.length, 3);
  const [a, b, never] = fleet.machines;
  assert.equal(a.machine, "Box A");
  assert.equal(a.total, 700);
  assert.equal(a.accounts, 3);
  assert.equal(a.sessionsScanned, true);
  assert.equal(a.floor, 1400);
  assert.equal(b.machine, "Box B");
  assert.equal(b.total, 300);
  assert.equal(b.sessionsScanned, false); // absent, not zero
  assert.equal(b.floor, 300);
  assert.equal(never.label, "Never Box");
  assert.equal(never.neverScanned, true);
  assert.equal(never.total, 0);

  // Accounts: profiles merged, machines map ACCUMULATED by machine name
  // (one machine key even with two profiles), user:<uid> relabeled by prefix.
  const acctA = fleet.accounts.find((x) => x.account === "a@x.com");
  assert.equal(acctA.total, 650);
  assert.equal(acctA.sessions, 3);
  assert.equal(acctA.turns, 15);
  assert.deepEqual(acctA.byMachine, { "Box A": 650 });
  assert.equal(acctA.activeDays, 2);
  const api = fleet.accounts.find((x) => x.account === "API profile");
  assert.ok(api, "user:<uid> row relabeled via accounts.json profile prefix");
  assert.equal(api.total, 50);
  assert.ok(!fleet.accounts.some((x) => x.account.startsWith("user:")));

  // Provider split from by_model, partitioning the grand total exactly.
  assert.deepEqual(fleet.byProvider, { anthropic: 650, openai: 300, deepseek: 50 });
  const provSum = Object.values(fleet.byProvider).reduce((x, y) => x + y, 0);
  assert.equal(provSum, fleet.fleetTotals.onDisk);

  // Cross-CLI: only box-a contributes (box-b has no sessions.json).
  assert.equal(fleet.byCli.claude.sessions, 3);
  assert.equal(fleet.byCli.claude.tokens, 700);
  assert.equal(fleet.byCli.codex.tokens, 100);

  // Known account signed in nowhere scanned.
  assert.deepEqual(fleet.missingAccounts, ["ghost@x.com"]);
});

test("written totals.json satisfies check_consistency arithmetic", () => {
  const root = makeFixtureFleet();
  const t = JSON.parse(readFileSync(join(root, "box-a", "machine-readable", "totals.json"), "utf-8"));
  const s = JSON.parse(readFileSync(join(root, "box-a", "machine-readable", "sessions.json"), "utf-8"));
  const sumA = t.accounts.reduce((x, a) => x + a.grand_total, 0);
  assert.equal(sumA, t.grand_total_tokens);
  for (const a of t.accounts) {
    const m = Object.values(a.by_model).reduce(
      (x, v) => x + FIELDS.reduce((y, k) => y + v[k], 0), 0);
    assert.equal(m, a.grand_total);
    assert.equal(FIELDS.reduce((y, k) => y + a.totals[k], 0), a.grand_total);
    for (const leaf of [...Object.values(a.by_model), ...Object.values(a.by_day),
                        ...Object.values(a.by_kind), ...Object.values(a.by_provider)]) {
      for (const k of FIELDS) assert.equal(typeof leaf[k], "number");
    }
  }
  const provSum = Object.values(t.by_provider).reduce((x, y) => x + y, 0);
  assert.equal(provSum, t.grand_total_tokens);
  for (const x of s.sessions) {
    assert.equal(FIELDS.reduce((y, k) => y + x.tokens[k], 0), x.total);
    assert.equal(x.sent + x.received, x.total);
  }
  const claude = s.sessions.filter((x) => x.cli === "claude")
    .reduce((x, y) => x + y.total, 0);
  assert.equal(claude, t.grand_total_tokens);
  // .machine-id claims the folder; REPORT.md keeps combine's link alive.
  assert.ok(existsSync(join(root, "box-a", ".machine-id")));
  const mid = JSON.parse(readFileSync(join(root, "box-a", ".machine-id"), "utf-8"));
  assert.equal(mid.folder, "box-a");
  assert.equal(mid.label, "Box A");
  assert.ok(existsSync(join(root, "box-a", "human-readable", "REPORT.md")));
});

test("writeMachineFolder rejects arithmetic the Python gate would fail", () => {
  const root = mkdtempSync(join(tmpdir(), "starreckon-bad-"));
  // by_model does not partition totals.
  assert.throws(() => writeMachineFolder(root, "bad-a", {
    label: "Bad A",
    accounts: [{
      account: "a@x.com", totals: F4(10, 0, 0, 10),
      by_model: { "claude-opus-4-6": F4(10, 0, 0, 5) },
      by_day: {},
    }],
  }), /by_model sums to 15/);
  // non-zero totals with no model split — would count any backend as Anthropic.
  assert.throws(() => writeMachineFolder(root, "bad-b", {
    label: "Bad B",
    accounts: [{ account: "a@x.com", totals: F4(10, 0, 0, 10), by_day: {} }],
  }), /by_model is required/);
  // claude sessions that disagree with account totals — zero live-drift excuse.
  assert.throws(() => writeMachineFolder(root, "bad-c", {
    label: "Bad C",
    accounts: [{
      account: "a@x.com", totals: F4(10, 0, 0, 10),
      by_model: { "claude-opus-4-6": F4(10, 0, 0, 10) }, by_day: {},
    }],
    sessions: [{ cli: "claude", tokens: F4(5, 0, 0, 5), model: "claude-opus-4-6" }],
  }), /claude session totals/);
  // reserved / authored names are never machine folders.
  assert.throws(() => writeMachineFolder(root, "machine-readable", {}), /reserved/);
  assert.throws(() => writeMachineFolder(root, "archive", {}), /reserved/);
  assert.throws(() => writeMachineFolder(root, "../oops", {}), /invalid/);
});

// ---- floor semantics -------------------------------------------------------

test("machineFloor concatenates counter + post-counter days, once per account", () => {
  const m = {
    accounts: [
      { account: "a@x.com", grand_total: 400, by_day: { "2026-01-05": F4(100, 100, 100, 100) } },
      { account: "a@x.com", grand_total: 250, by_day: { "2026-01-15": 250 } }, // int leaf ok
    ],
  };
  const cache = [{ account: "a@x.com", total: 1000, last_computed: "2026-01-10" }];
  const r = machineFloor(m, [], cache);
  // counter owns <= 01-10 (the 400), transcripts own 01-15 (250): 1000+250.
  assert.equal(r.claude, 1250);
  assert.equal(r.floor, 1250);
  // No counter: floor is just the measured figure.
  const r2 = machineFloor(m, [], []);
  assert.equal(r2.floor, 650);
  // Session totals raise "seen" so a floor is never below what was measured.
  const r3 = machineFloor(m, [
    { cli: "claude", account: "a@x.com", total: 2000 },
    { cli: "codex", account: "codex (local)", total: 300 },
  ], cache);
  assert.equal(r3.claude, 2000);
  assert.equal(r3.other, 300);
  assert.equal(r3.floor, 2300);
});

// ---- hardware --------------------------------------------------------------

test("gatherHardware returns the hardware.json shape from node:os", () => {
  const h = gatherHardware("Test Label");
  assert.equal(h.machine, "Test Label");
  assert.equal(typeof h.hostname, "string");
  assert.equal(typeof h.hardware.chip, "string");
  assert.ok(h.hardware.cpu_logical >= 1);
  assert.ok(h.hardware.memory_gb > 0);
  assert.match(h.hardware.os, /^\S+ /);
  assert.ok(h.hardware.model_identifier);
});

// ---- archive dedup ---------------------------------------------------------

test("archiveSnapshots snapshots each machine and dedups by digest", () => {
  const root = makeFixtureFleet();
  const first = archiveSnapshots(root, "2026-02-01T00-00-00");
  assert.deepEqual(first, ["archive/box-a/2026-02-01T00-00-00", "archive/box-b/2026-02-01T00-00-00"]);
  const digest = readFileSync(
    join(root, "archive", "box-a", "2026-02-01T00-00-00", ".digest"), "utf-8");
  assert.match(digest, /^[0-9a-f]{12}\n$/);
  // Identical content, later stamp: nothing written (compared to lexically
  // last sibling).
  const second = archiveSnapshots(root, "2026-02-02T00-00-00");
  assert.deepEqual(second, []);
  assert.ok(!existsSync(join(root, "archive", "box-a", "2026-02-02T00-00-00")));
  // Content changes -> a new snapshot appears.
  const tj = join(root, "box-b", "totals.json");
  const doc = JSON.parse(readFileSync(tj, "utf-8"));
  doc.generated_at = "2026-02-03T00:00:00-06:00";
  writeFileSync(tj, JSON.stringify(doc, null, 2));
  const third = archiveSnapshots(root, "2026-02-03T00-00-00");
  assert.deepEqual(third, ["archive/box-b/2026-02-03T00-00-00"]);
  assert.match(archiveStamp(new Date(2026, 1, 3, 4, 5, 6)), /^2026-02-03T04-05-06$/);
});

test("snapshotDigest matches Python's sha256(name+bytes)[:12] scheme", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "starreckon-digest-"));
  writeFileSync(join(dir, "totals.json"), '{"x":1}');
  writeFileSync(join(dir, "sessions.json"), '{"y":2}');
  const js = snapshotDigest([join(dir, "totals.json"), join(dir, "sessions.json")]);
  assert.match(js, /^[0-9a-f]{12}$/);
  let py;
  try {
    py = execFileSync("python3", ["-c", `
import hashlib, pathlib, sys
payload = b""
for f in sys.argv[1:]:
    p = pathlib.Path(f)
    payload += p.name.encode() + p.read_bytes()
print(hashlib.sha256(payload).hexdigest()[:12])
`, join(dir, "totals.json"), join(dir, "sessions.json")], { encoding: "utf-8" }).trim();
  } catch {
    t.skip("python3 not available");
    return;
  }
  assert.equal(js, py);
});

// ---- the real gate: run check_consistency.py on a folder we wrote ----------

// The checkout is named by STARFORGE_TOKEN_USAGE_DIR and nothing else. It used
// to be a hardcoded absolute path on the author's machine — which put a real
// username, and a throwaway agent-session directory, into a file that npm
// ships (package.json "files" includes tests/). A privacy tool that leaks its
// author's home path in its own test suite has already lost the argument; see
// tests/shipset.test.mjs, which now fails the build if any shipped file
// carries this machine's username again.
test("Python check_consistency.py passes on a starreckon-written fleet", (t) => {
  const pySrc = process.env.STARFORGE_TOKEN_USAGE_DIR;
  const needed = ["check_consistency.py", "paths.py", "analyze_tokens.py"];
  if (!pySrc) {
    t.skip("set STARFORGE_TOKEN_USAGE_DIR to a token-usage checkout to run the Python cross-check");
    return;
  }
  if (!needed.every((f) => existsSync(join(pySrc, f)))) {
    t.skip(`STARFORGE_TOKEN_USAGE_DIR does not contain ${needed.join(", ")}`);
    return;
  }
  const root = makeFixtureFleet();
  for (const f of needed) {
    writeFileSync(join(root, f), readFileSync(join(pySrc, f)));
  }
  let out;
  try {
    out = execFileSync("python3", ["check_consistency.py"], { cwd: root, encoding: "utf-8" });
  } catch (e) {
    assert.fail(`check_consistency.py failed:\n${e.stdout || ""}${e.stderr || ""}`);
  }
  assert.match(out, /0 failed/);
  assert.doesNotMatch(out, /\bFAIL\b/);
});

// ---- flat-layout fallback (paths.find order) -------------------------------

test("readers fall back machine-readable -> human-readable -> flat", () => {
  const root = mkdtempSync(join(tmpdir(), "starreckon-flat-"));
  // totals.json parked under human-readable/ (middle of the fallback chain)
  mkdirSync(join(root, "box-h", "human-readable"), { recursive: true });
  writeFileSync(join(root, "box-h", "human-readable", "totals.json"), JSON.stringify({
    machine: "Box H", generated_at: "2026-01-01T00:00:00-06:00",
    grand_total_tokens: 7,
    accounts: [{ account: "h@x.com", grand_total: 7, sessions: 1, turns: 1,
      totals: F4(7, 0, 0, 0), by_model: { "claude-x": F4(7, 0, 0, 0) },
      by_day: { "2026-01-01": F4(7, 0, 0, 0) } }],
  }));
  const fleet = readFleet(root);
  assert.equal(fleet.machines.length, 1);
  assert.equal(fleet.machines[0].machine, "Box H");
  assert.equal(fleet.fleetTotals.onDisk, 7);
});
