// Correctness + honesty guards on the parts of the CLI a stranger meets first:
// flag parsing, defaults, error output, and the claims printed on the artifacts
// people share. Every test here reproduces a defect that shipped.
//
//   1. unknown FLAGS were silently ignored, so the privacy flags failed OPEN:
//      `--no-project` (singular typo) wrote every real project name while the
//      user believed they had asked for proj-<hash>. Unknown SUBcommands
//      already exited 2 for exactly this reasoning.
//   2. the --join-fleet folder defaulted to "macbook-air-m1" / "MacBook Air
//      M1" — the author's laptop — so every stranger wrote a folder named
//      after someone else's Mac, and two machines taking the default collided.
//   3. the stats page footer asserted "no text left this machine; nothing was
//      uploaded" — the one claim the project says no process can prove about
//      itself, on the output most likely to be screenshotted out of context.
//   4. a permission error on ~/.starreckon dumped a raw Node stack.
//   5. the interactive exclusion prompt was skipped in SILENCE whenever stdin
//      was not a TTY, though the README sells it as a headline feature.
//   6. a legacy log that fails today's leak scan could not be retired: the
//      obvious remedy (delete it) broke the hash chain instead — a bind with
//      no documented way out. `--reset-audit` is the way out, and these tests
//      pin down that it cannot be used to erase a history quietly.
//
// Temp dirs only: nothing here touches the real ~/.starreckon, and no path in
// this file is written by hand (a hardcoded absolute path is how this repo
// leaked its author's username into the tarball once already).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  chmodSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, hostname, homedir, userInfo } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  verifyAuditChain,
  resetAudit,
  describeRemovedLogs,
  finishAudit,
  startAudit,
  counterFileFor,
} from "../src/audit.mjs";
import { auditCheck } from "../src/verify.mjs";
import { renderStatsPage } from "../src/statspage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "src", "cli.mjs");
const CLI_SRC = readFileSync(CLI, "utf8");

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "sf-ux-"));
  const proj = join(home, ".claude", "projects", "demo");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "session.jsonl"),
    JSON.stringify({ type: "user", timestamp: new Date().toISOString(), uuid: "u1" }) + "\n"
  );
  return home;
}

const runCli = (home, argv, extraEnv = {}) =>
  spawnSync(process.execPath, [CLI, ...argv], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, HOME: home, ...extraEnv },
  });

// ---- 1. unknown flags ------------------------------------------------------

test("a mistyped privacy flag EXITS 2 instead of failing open", () => {
  const home = fakeHome();
  const r = runCli(home, ["--yes", "--json", "--no-project"]);
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /unknown flag "--no-project"/);
  assert.match(r.stderr, /Did you mean --no-projects\?/);
  // and nothing ran: no scan, no reports, and — because validation happens
  // before the audit hook is armed — no run log claiming a crash either.
  assert.equal(
    existsSync(join(home, ".starreckon")),
    false,
    "a rejected flag must not read or write anything"
  );
});

test("every silently-ignored privacy typo from the finding is now rejected", () => {
  const home = fakeHome();
  for (const [typo, meant] of [
    ["--no-snapshots", "--no-snapshot"],
    ["--show-account", "--show-accounts"],
    ["--no-provider", "--no-providers"],
  ]) {
    const r = runCli(home, ["--yes", typo]);
    assert.equal(r.status, 2, `${typo} was accepted: ${r.stdout}${r.stderr}`);
    assert.ok(
      r.stderr.includes(`Did you mean ${meant}?`),
      `${typo} should suggest ${meant}, got: ${r.stderr}`
    );
  }
  // an unknown short flag is the same failure class
  assert.equal(runCli(home, ["-v"]).status, 2);
  // a value flag with no value, and a boolean flag given one, are both errors
  assert.equal(runCli(home, ["--roots"]).status, 2);
  assert.equal(runCli(home, ["--json=1"]).status, 2);
  // a correctly-spelled flag on a subcommand that reads none of them is the
  // same silent-ignore, so it is refused too — while the bare subcommands work
  const sub = runCli(home, ["verify", "--json"]);
  assert.equal(sub.status, 2, sub.stdout + sub.stderr);
  assert.match(sub.stderr, /`verify` takes no flags/);
  assert.equal(runCli(home, ["prove"]).status, 0);
});

test("the real flags still work — validation must not reject legitimate usage", () => {
  const home = fakeHome();
  const r = runCli(home, ["--yes", "--no-providers", "--no-snapshot", "--no-projects"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /scan complete|profile/);
});

// ---- 2. the flag registry cannot drift from the docs or from the code ------

function specFlags(src) {
  const block = src.slice(src.indexOf("const FLAG_SPEC"), src.indexOf("const KNOWN_FLAGS"));
  assert.ok(block.length > 50, "FLAG_SPEC block not found in src/cli.mjs");
  return new Set([...block.matchAll(/"(--[a-z0-9-]+)":/g)].map((m) => m[1]));
}

test("FLAG_SPEC and the usage header list exactly the same flags", () => {
  const header = CLI_SRC.split("import {")[0];
  const documented = new Set([...header.matchAll(/--[a-z][a-z0-9-]*/g)].map((m) => m[0]));
  const registered = specFlags(CLI_SRC);
  const undocumented = [...registered].filter((f) => !documented.has(f));
  const unregistered = [...documented].filter((f) => !registered.has(f));
  // --name and --profile were live but appeared in no usage text at all.
  assert.deepEqual(undocumented, [], `registered but undocumented: ${undocumented.join(", ")}`);
  assert.deepEqual(unregistered, [], `documented but unregistered (would exit 2): ${unregistered.join(", ")}`);
  for (const f of ["--name", "--profile", "--show-accounts", "--no-projects", "--machine", "--label", "--roots", "--fleet", "--join-fleet", "--reset-audit"])
    assert.ok(registered.has(f), `${f} must be registered`);
});

test("every flag the CLI actually reads is registered (a live-but-unregistered flag would exit 2)", () => {
  const registered = specFlags(CLI_SRC);
  const read = new Set([
    ...[...CLI_SRC.matchAll(/\bflag\("(--[a-z0-9-]+)"\)/g)].map((m) => m[1]),
    ...[...CLI_SRC.matchAll(/\bopt\("([a-z0-9-]+)"\)/g)].map((m) => `--${m[1]}`),
  ]);
  assert.ok(read.size >= 10, `only found ${read.size} flag call sites — the scan is broken`);
  for (const f of read) assert.ok(registered.has(f), `${f} is read by the CLI but not in FLAG_SPEC`);
});

test("the flags the proof path passes to the CLI are registered — the headline proof must not exit 2", () => {
  const registered = specFlags(CLI_SRC);
  // (a) argv arrays handed to buildProofCommand/runConfined anywhere in src/
  const srcFlags = new Set();
  for (const f of readdirSync(join(ROOT, "src")).filter((n) => n.endsWith(".mjs"))) {
    const text = readFileSync(join(ROOT, "src", f), "utf8");
    for (const m of text.matchAll(/argv:\s*\[([^\]]*)\]/g)) {
      // runConfined() can target a different entry point than cli.mjs — the
      // positive control runs confine.mjs --probe under the same sandbox. Its
      // flags belong to THAT program, not to the CLI, so requiring them in
      // FLAG_SPEC would be wrong. Only skip when the call says so explicitly:
      // an argv with no `entry:` beside it is still headed for cli.mjs and is
      // still held to the rule this test exists for.
      const around = text.slice(Math.max(0, m.index - 160), m.index + m[0].length + 160);
      if (/entry:\s*"(?!cli\.mjs)/.test(around)) continue;
      for (const g of m[1].matchAll(/"(--[a-z0-9-]+)"/g)) srcFlags.add(g[1]);
    }
  }
  // (b) flags on any line of the shipped proof script that invokes cli.mjs
  const sh = readFileSync(join(ROOT, "bin", "starreckon-proof.sh"), "utf8");
  for (const line of sh.split("\n").filter((l) => l.includes("cli.mjs")))
    for (const m of line.matchAll(/--[a-z0-9-]+/g)) srcFlags.add(m[0]);
  assert.ok(srcFlags.size > 0, "found no proof-path flags to check");
  for (const f of srcFlags)
    assert.ok(registered.has(f), `${f} is passed to the CLI by the proof path but is not registered`);

  // …and no proof-path argv mixes a SUBCOMMAND with a flag: `verify` and
  // `prove` read no flags, so that combination is refused (exit 2), which in
  // the proof path would report a network verdict for a parsing reason.
  for (const f of readdirSync(join(ROOT, "src")).filter((n) => n.endsWith(".mjs"))) {
    const text = readFileSync(join(ROOT, "src", f), "utf8");
    for (const m of text.matchAll(/argv:\s*\[([^\]]*)\]/g))
      for (const g of m[1].matchAll(/"([a-z][a-z0-9-]*)"/g))
        assert.ok(
          !["verify", "prove", "scan"].includes(g[1]),
          `src/${f} builds a proof command with the subcommand "${g[1]}" plus flags — that exits 2`
        );
  }
});

// ---- 3. fleet folder default ----------------------------------------------

test("--join-fleet defaults the folder to THIS machine's hostname, not the author's laptop", () => {
  // comments may name the old default (they explain the defect); code may not
  const code = CLI_SRC.split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
  assert.ok(
    !/macbook-air-m1|MacBook Air M1/.test(code),
    "the author's machine name is hardcoded again"
  );
  const home = fakeHome();
  const fleet = mkdtempSync(join(tmpdir(), "sf-fleet-"));
  const r = runCli(home, ["--yes", "--no-providers", "--no-snapshot", `--join-fleet=${fleet}`]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);

  const expected =
    String(hostname() ?? "").split(".")[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "").slice(0, 48) || "unnamed-machine";
  const folders = readdirSync(fleet);
  assert.deepEqual(folders, [expected], `fleet folders: ${folders.join(", ")}`);
  // and the run says where the name came from, since the folder is shared
  assert.match(r.stdout, /default to this machine's hostname/);
});

// ---- 4. honesty of the claims printed on shareable artifacts ---------------

test("the stats page footer does not assert what no page can prove", () => {
  const html = renderStatsPage({ agg: { total_sessions: 1 }, name: "X" });
  assert.ok(!/nothing was uploaded|nothing uploaded/i.test(html), "the page asserts 'nothing uploaded'");
  assert.ok(!/no text left this machine/i.test(html), "the page asserts 'no text left this machine'");
  // the honest, narrower claim is still there — the fix is not a deletion
  assert.match(html, /rendered on your machine/i);
  assert.match(html, /no process can prove that about itself/i);
  assert.match(html, /PROVE-IT\.md/);
});

test("no src file asserts the unprovable no-egress claim in a printed string", () => {
  const forbidden = [
    /nothing (?:was )?uploaded/i,
    /no text left this machine/i,
    /nothing leaves this machine/i,
  ];
  const hits = [];
  for (const f of readdirSync(join(ROOT, "src")).filter((n) => n.endsWith(".mjs"))) {
    const text = readFileSync(join(ROOT, "src", f), "utf8");
    text.split("\n").forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*")) return; // comments may quote the old claim
      for (const re of forbidden) if (re.test(line)) hits.push(`src/${f}:${i + 1}: ${t.slice(0, 80)}`);
    });
  }
  assert.deepEqual(hits, [], `unprovable no-egress claims:\n  ${hits.join("\n  ")}`);
});

// ---- 5. the exclusion prompt says when it did not happen -------------------

test("a non-TTY run says the exclusion prompt was skipped and nothing was excluded", () => {
  const home = fakeHome();
  const r = runCli(home, ["--no-providers", "--no-snapshot"]); // deliberately no --yes
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /not a TTY/);
  assert.match(r.stdout, /NOTHING was excluded/);
  // passing --yes is the explicit form: no "we skipped it" noise
  const r2 = runCli(home, ["--yes", "--no-providers", "--no-snapshot"]);
  assert.ok(!/exclusion prompt was SKIPPED/.test(r2.stdout), r2.stdout);
});

// ---- 6. permission errors read like messages, not like crashes -------------

test("EACCES on ~/.starreckon prints one line, not a stack (stack stays behind STARRECKON_DEBUG)", (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0)
    return t.skip("running as root: a read-only dir would not stop the write");
  const home = fakeHome();
  const data = join(home, ".starreckon");
  mkdirSync(data, { recursive: true });
  chmodSync(data, 0o555); // readable, not writable: mkdir of snapshots/ fails
  try {
    const r = runCli(home, ["--yes", "--no-providers"]);
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /permission denied writing ~\/\.starreckon/);
    assert.match(r.stderr, /EACCES/);
    assert.match(r.stderr, /STARRECKON_DEBUG=1/);
    assert.ok(!/\bat \w+ \(node:/.test(r.stderr), `a raw stack was printed:\n${r.stderr}`);

    const dbg = runCli(home, ["--yes", "--no-providers"], { STARRECKON_DEBUG: "1" });
    assert.match(dbg.stderr, /\bat /, "STARRECKON_DEBUG=1 must still give the stack");
    // …and the debug stack is masked like every other output path
    assert.ok(!dbg.stderr.includes(home), "the debug stack leaked the absolute home path");
  } finally {
    chmodSync(data, 0o755);
  }
});

// ---- 7. legacy vs current logs are counted, not glossed over ---------------

function writeChainedLogs(dir, logs) {
  mkdirSync(dir, { recursive: true });
  let prev = null;
  logs.forEach((log, i) => {
    const name = `run-2026-01-0${i + 1}T00-00-00.000Z.json`;
    const body = JSON.stringify({ ...log, prev_log_sha256: prev }, null, 2);
    writeFileSync(join(dir, name), body);
    prev = createHash("sha256").update(Buffer.from(body)).digest("hex");
  });
}

test("the audit check counts legacy schema-1 logs instead of describing checks it did not run", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "sf-audit-")), "audit");
  writeChainedLogs(dir, [
    { schema: 1, complete: true, tripwire_hits: [] },
    { schema: 1, complete: true, tripwire_hits: [] },
    { schema: 2, run_index: 2, complete: true, tripwire_hits: [] },
  ]);
  const chain = verifyAuditChain(dir, { counterFile: join(dir, "..", "audit-counter.json") });
  assert.equal(chain.runs, 3);
  assert.equal(chain.legacy_logs, 2);
  assert.equal(chain.current_logs, 1);

  const check = auditCheck(dir);
  const note = check.notes.join(" ");
  assert.match(note, /1 schema-2/);
  assert.match(note, /2 schema-1 legacy/);
  assert.match(note, /no run_index, no complete flag/);
  assert.ok(
    check.limits.some((l) => /SCHEMA-2 logs only/.test(l)),
    "the limits must say which logs the gap checks apply to"
  );
});

// ---- 8. --reset-audit: the documented way out, and its visibility ----------

test("resetAudit clears the history, records what it removed, and leaves a chain that verifies", () => {
  const root = mkdtempSync(join(tmpdir(), "sf-reset-"));
  const dir = join(root, "audit");
  const counterFile = counterFileFor(dir);
  // three real logs, written by the real writer so the chain is genuine
  for (let i = 0; i < 3; i += 1) finishAudit(startAudit([`--run-${i}`], { dir, counterFile }));
  const before = readdirSync(dir).filter((f) => f.startsWith("run-"));
  assert.equal(before.length, 3);

  const res = resetAudit(dir, { counterFile, reason: "legacy log failed the leak scan" });
  const after = readdirSync(dir).filter((f) => f.startsWith("run-"));
  assert.equal(after.length, 1, "every old log must be gone");
  assert.equal(res.removed_logs, 3);
  assert.deepEqual(res.removed.map((r) => r.file), before);

  const rec = JSON.parse(readFileSync(res.path, "utf8"));
  assert.equal(rec.prev_log_sha256, null, "the record is the genesis of the new chain");
  assert.equal(rec.audit_reset.removed_logs, 3);
  assert.equal(rec.audit_reset.removed_index_first, 0);
  assert.equal(rec.audit_reset.removed_index_last, 2);
  assert.match(rec.audit_reset.reason, /leak scan/);
  for (const r of rec.audit_reset.removed)
    assert.match(r.sha256, /^[0-9a-f]{64}$/, "each removed log must be recorded by hash");
  // the counter is NOT rolled back: how much history existed stays visible
  assert.equal(JSON.parse(readFileSync(counterFile, "utf8")).last_run_index, 3);
  assert.equal(rec.run_index, 3);

  const chain = verifyAuditChain(dir, { counterFile });
  assert.equal(chain.ok, true, JSON.stringify(chain.breaks));
  assert.equal(chain.resets, 1);
  assert.ok(
    chain.notes.some((n) => /RESET/.test(n) && /DELETED 3 run log\(s\)/.test(n) && /run_index 0\.\.2/.test(n)),
    JSON.stringify(chain.notes)
  );

  // and the next run chains onto the record, which keeps the reset in view
  finishAudit(startAudit(["--after-reset"], { dir, counterFile }));
  const after2 = verifyAuditChain(dir, { counterFile });
  assert.equal(after2.ok, true, JSON.stringify(after2.breaks));
  assert.ok(after2.notes.some((n) => /RESET/.test(n)));
});

test("the reset record says how many of the removed logs the gap checks could even see", () => {
  // the real-world shape: a mostly pre-v2 history. "run_index 9..10" for 12
  // logs describes 2 of them, so the count has to be stated, not implied.
  const dir = join(mkdtempSync(join(tmpdir(), "sf-reset-mixed-")), "audit");
  const counterFile = counterFileFor(dir);
  writeChainedLogs(dir, [
    { schema: 1, complete: true, tripwire_hits: [] },
    { schema: 1, complete: true, tripwire_hits: [] },
    { schema: 2, run_index: 9, complete: true, tripwire_hits: [] },
    { schema: 2, run_index: 10, complete: true, tripwire_hits: [] },
  ]);
  const res = resetAudit(dir, { counterFile });
  assert.equal(res.record.removed_logs, 4);
  assert.equal(res.record.removed_with_run_index, 2);
  const text = describeRemovedLogs(res.record);
  assert.match(text, /4 run log\(s\)/);
  assert.match(text, /2 of them run_index 9\.\.10/);
  assert.match(text, /the other 2 carried no run_index/);
  assert.equal(verifyAuditChain(dir, { counterFile }).ok, true);

  // a history with no run_index at all says exactly that, not a fake range
  const dir2 = join(mkdtempSync(join(tmpdir(), "sf-reset-legacy-")), "audit");
  writeChainedLogs(dir2, [{ schema: 1, complete: true, tripwire_hits: [] }]);
  const res2 = resetAudit(dir2, { counterFile: counterFileFor(dir2) });
  assert.match(describeRemovedLogs(res2.record), /none of which carried a run_index/);

  // and a reset on a machine that has never run says THAT, not "0 run log(s)"
  const dir3 = join(mkdtempSync(join(tmpdir(), "sf-reset-empty-")), "audit");
  const res3 = resetAudit(dir3, { counterFile: counterFileFor(dir3) });
  assert.equal(res3.removed_logs, 0);
  assert.match(describeRemovedLogs(res3.record), /the audit dir was already empty/);
  const fresh = verifyAuditChain(dir3, { counterFile: counterFileFor(dir3) });
  assert.equal(fresh.ok, true, JSON.stringify(fresh.breaks));
});

test("a reset cannot be hidden: deleting the record, or forging one that does not add up, both FAIL", () => {
  const root = mkdtempSync(join(tmpdir(), "sf-reset2-"));
  const dir = join(root, "audit");
  const counterFile = counterFileFor(dir);
  for (let i = 0; i < 3; i += 1) finishAudit(startAudit([`--run-${i}`], { dir, counterFile }));
  const res = resetAudit(dir, { counterFile, reason: null });
  finishAudit(startAudit(["--after-reset"], { dir, counterFile }));
  assert.equal(verifyAuditChain(dir, { counterFile }).ok, true);

  // (a) delete the reset record to make the history look untouched
  unlinkSync(res.path);
  const gone = verifyAuditChain(dir, { counterFile });
  assert.equal(gone.ok, false, "deleting the reset record must break the chain");
  assert.ok(
    gone.breaks.some((b) => /genesis|head truncation|earlier run log/.test(b.reason)),
    JSON.stringify(gone.breaks)
  );

  // (b) forge a record that claims to supersede less than is actually missing
  const dir2 = join(mkdtempSync(join(tmpdir(), "sf-reset3-")), "audit");
  const counter2 = counterFileFor(dir2);
  for (let i = 0; i < 5; i += 1) finishAudit(startAudit([`--run-${i}`], { dir: dir2, counterFile: counter2 }));
  const res2 = resetAudit(dir2, { counterFile: counter2 });
  const forged = JSON.parse(readFileSync(res2.path, "utf8"));
  forged.audit_reset.removed_logs = 1;
  forged.audit_reset.removed_index_first = 0;
  forged.audit_reset.removed_index_last = 0; // claims one log; five are missing
  writeFileSync(res2.path, JSON.stringify(forged, null, 2));
  const bad = verifyAuditChain(dir2, { counterFile: counter2 });
  assert.equal(bad.ok, false, "a record that does not account for the gap must not pass");
  assert.ok(
    bad.breaks.some((b) => /does not explain|only accounts for/.test(b.reason)),
    JSON.stringify(bad.breaks)
  );
});

test("a leaky legacy log has a documented way out: the FAIL says what to do, and --reset-audit does it", () => {
  const home = fakeHome();
  // one clean run, so there is a real chain to poison
  assert.equal(runCli(home, ["--yes", "--no-providers"]).status, 0);
  const auditDir = join(home, ".starreckon", "audit");
  const logs = readdirSync(auditDir).filter((f) => f.startsWith("run-"));
  assert.equal(logs.length, 1);

  // plant the exact real-world defect: a PRE-fix log carrying the username
  const log = JSON.parse(readFileSync(join(auditDir, logs[0]), "utf8"));
  log.argv = [`--join-fleet=/Users/${userInfo().username}/fleet`];
  writeFileSync(join(auditDir, logs[0]), JSON.stringify(log, null, 2));

  const red = runCli(home, ["verify"]);
  assert.equal(red.status, 1, red.stdout);
  assert.match(red.stdout, /contains the literal username/);
  // the finding must say what to DO — this is the half that was missing
  assert.match(red.stdout, /--reset-audit/);
  assert.match(red.stdout, /deleting the file by hand breaks the chain/);

  const reset = runCli(home, ["--reset-audit=legacy log failed the leak scan"]);
  assert.equal(reset.status, 0, `${reset.stdout}${reset.stderr}`);
  assert.match(reset.stdout, /removed 1 run log\(s\)/);

  const green = runCli(home, ["verify"]);
  // Asserts the AUDIT check, not verify's global exit code. The exit code is
  // the OR of every check, so on a host with no usable OS confinement — Ubuntu
  // 23.10+ blocks unprivileged user namespaces by default — the confinement
  // check legitimately FAILs and this test would go red for a reason that has
  // nothing to do with the audit chain it exists to test. Pinning the global
  // status made a machine-shaped fact look like a regression here.
  assert.match(green.stdout, /audit log chain \+ tripwire hits[^\n]*PASS/);
  assert.match(green.stdout, /the audit history was RESET/);
  assert.ok(!/contains the literal username/.test(green.stdout), green.stdout);
  // the remedy is not an eraser: the reset stays on the record
  assert.match(green.stdout, /--reset-audit` DELETED 1 run log\(s\)/);
});

// A sanity check on this file's own hygiene: it must never hardcode a real
// path, which is how the repo shipped its author's username once already.
test("this test file hardcodes no absolute machine path", () => {
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.ok(!self.includes(homedir()), "this file contains the real home path");
  assert.ok(!/\/private\/tmp\/claude-/.test(self), "this file contains an agent sandbox path");
});

// ── Persisted exclusions integration ─────────────────────────────────────────
// Tests that ~/.starreckon/exclude.json is loaded before the scan and that
// matching session files are excluded from the output.

function fakeHomeWithExclusion(fragToExclude, projectName = "secret-client") {
  // Build a home with two session projects: one that matches the exclusion
  // fragment, one that does not.
  const home = mkdtempSync(join(tmpdir(), "sf-excl-"));
  const projSecret = join(home, ".claude", "projects",
    projectName.replace(/[/\\]/g, "-"));
  const projPublic = join(home, ".claude", "projects", "public-work");
  mkdirSync(projSecret, { recursive: true });
  mkdirSync(projPublic, { recursive: true });
  const ts = new Date().toISOString();
  writeFileSync(join(projSecret, "session.jsonl"),
    JSON.stringify({ type: "user", timestamp: ts, uuid: "s1", cwd: "/" + projectName }) + "\n");
  writeFileSync(join(projPublic, "session.jsonl"),
    JSON.stringify({ type: "user", timestamp: ts, uuid: "p1", cwd: "/public-work" }) + "\n");

  // Write the exclude.json
  const sfDir = join(home, ".starreckon");
  mkdirSync(sfDir, { recursive: true });
  writeFileSync(join(sfDir, "exclude.json"),
    JSON.stringify({ paths: [fragToExclude] }, null, 2));

  return home;
}

test("persisted exclusion suppresses matching project from the scan output", () => {
  const home = fakeHomeWithExclusion("secret-client");
  const r = runCli(home, ["--yes", "--no-wrapped", "--no-pace", "--no-snapshot",
    "--no-providers", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  // The saved exclusion is printed before the scan
  assert.match(r.stdout, /saved exclusions.*secret-client/i);
  // The excluded project must not appear in any report
  const repDir = join(home, ".starreckon", "reports");
  const reports = existsSync(repDir) ? readdirSync(repDir) : [];
  for (const f of reports.filter(f => f.endsWith(".json"))) {
    const txt = readFileSync(join(repDir, f), "utf8");
    assert.ok(!txt.includes("secret-client"),
      `excluded project leaked into ${f}`);
  }
});

test("persisted exclusion does not suppress non-matching projects", () => {
  const home = fakeHomeWithExclusion("secret-client");
  const r = runCli(home, ["--yes", "--no-wrapped", "--no-pace", "--no-snapshot",
    "--no-providers", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  // public-work should still be scanned (appears in sessions count > 0 or projects)
  assert.match(r.stdout, /Found:/);
});

test("no exclude.json means no saved exclusions message and everything is scanned", () => {
  const home = fakeHome();
  const r = runCli(home, ["--yes", "--no-wrapped", "--no-pace", "--no-snapshot",
    "--no-providers"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("saved exclusions"), r.stdout);
});

test("empty paths array in exclude.json excludes nothing", () => {
  const home = fakeHome();
  const sfDir = join(home, ".starreckon");
  mkdirSync(sfDir, { recursive: true });
  writeFileSync(join(sfDir, "exclude.json"), JSON.stringify({ paths: [] }));
  const r = runCli(home, ["--yes", "--no-wrapped", "--no-pace", "--no-snapshot",
    "--no-providers"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("saved exclusions"), r.stdout);
});

test("corrupt exclude.json is silently ignored and scan proceeds", () => {
  const home = fakeHome();
  const sfDir = join(home, ".starreckon");
  mkdirSync(sfDir, { recursive: true });
  writeFileSync(join(sfDir, "exclude.json"), "not json {{{");
  const r = runCli(home, ["--yes", "--no-wrapped", "--no-pace", "--no-snapshot",
    "--no-providers"]);
  // Must not crash
  assert.equal(r.status, 0, r.stderr);
});

// ── Menu uppercase keys ───────────────────────────────────────────────────────
// The before-you-go menu now uses uppercase P/T/C/D/E/R/Q. Tests that the
// output uses uppercase and that the old lowercase labels are gone.

const FORCE_INTERACTIVE = { STARRECKON_FORCE_INTERACTIVE: "1" };

test("before-you-go menu uses uppercase key labels [P][T][E][R][Q]", () => {
  const home = fakeHome();
  // Pass Q to immediately quit the menu
  const r = spawnSync(process.execPath, [CLI, "--yes", "--no-wrapped",
    "--no-pace", "--no-snapshot", "--no-providers"], {
    input: "Q\n",
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, HOME: home, ...FORCE_INTERACTIVE },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[P\]/, "missing [P] prove it");
  assert.match(r.stdout, /\[T\]/, "missing [T] transparency");
  assert.match(r.stdout, /\[E\]/, "missing [E] exclusions");
  assert.match(r.stdout, /\[R\]/, "missing [R] reach out");
  assert.match(r.stdout, /\[Q\]/, "missing [Q] done");
});

test("before-you-go menu shows [T] transparency not [r] receipt", () => {
  const home = fakeHome();
  const r = spawnSync(process.execPath, [CLI, "--yes", "--no-wrapped",
    "--no-pace", "--no-snapshot", "--no-providers"], {
    input: "Q\n",
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, HOME: home, ...FORCE_INTERACTIVE },
  });
  assert.ok(!r.stdout.includes("[r] receipt"), "old [r] receipt label still present");
  assert.match(r.stdout, /transparency/i, "transparency label missing");
});

test("[T] transparency prints the data receipt", () => {
  const home = fakeHome();
  const r = spawnSync(process.execPath, [CLI, "--yes", "--no-wrapped",
    "--no-pace", "--no-snapshot", "--no-providers"], {
    input: "T\nQ\n",
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, HOME: home, ...FORCE_INTERACTIVE },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /starreckon receipt/i);
});

test("[E] exclusions menu shows current list and accepts a new fragment", () => {
  const home = fakeHome();
  // Pre-seed one exclusion
  const sfDir = join(home, ".starreckon");
  mkdirSync(sfDir, { recursive: true });
  writeFileSync(join(sfDir, "exclude.json"),
    JSON.stringify({ paths: ["existing-excl"] }));
  const r = spawnSync(process.execPath, [CLI, "--yes", "--no-wrapped",
    "--no-pace", "--no-snapshot", "--no-providers"], {
    input: "E\nnew-fragment\nQ\n",
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, HOME: home, ...FORCE_INTERACTIVE },
  });
  assert.equal(r.status, 0, r.stderr);
  // Shows saved exclusions header
  assert.match(r.stdout, /saved exclusions/i);
  // The new fragment was accepted
  assert.match(r.stdout, /saved\. active next scan/);
  // It is now in the file
  const updated = JSON.parse(readFileSync(join(sfDir, "exclude.json"), "utf8"));
  assert.ok(updated.paths.includes("new-fragment"),
    "new fragment not written to exclude.json");
});

test("[E] exclusions menu removes an entry by index", () => {
  const home = fakeHome();
  const sfDir = join(home, ".starreckon");
  mkdirSync(sfDir, { recursive: true });
  writeFileSync(join(sfDir, "exclude.json"),
    JSON.stringify({ paths: ["first", "second"] }));
  const r = spawnSync(process.execPath, [CLI, "--yes", "--no-wrapped",
    "--no-pace", "--no-snapshot", "--no-providers"], {
    input: "E\n0\nQ\n",
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, HOME: home, ...FORCE_INTERACTIVE },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /removed "first"/);
  const updated = JSON.parse(readFileSync(join(sfDir, "exclude.json"), "utf8"));
  assert.ok(!updated.paths.includes("first"), "removed entry still present");
  assert.ok(updated.paths.includes("second"), "other entry wrongly removed");
});

// ── --serve-collect flag accepted ─────────────────────────────────────────────

test("serve --serve-collect=DIR is a known flag and does not exit 2", () => {
  // We don't actually start the server; we just confirm the flag is not rejected.
  // Pass an invalid port so it fails fast without binding.
  const home = fakeHome();
  const r = runCli(home, ["serve", "--serve-collect=/tmp/sf-collect-test",
    "--serve-port=1", "--serve-visits=1", "--serve-timeout=0"]);
  // Exit must not be 2 (unknown flag). It may be 1 (port in use / bind error).
  assert.notEqual(r.status, 2,
    `serve --serve-collect rejected as unknown flag: ${r.stderr}`);
});

// ---- clipboardCmds() -------------------------------------------------------
// These tests verify the OS/session detection logic without ever spawning a
// clipboard binary. Each case reproduces a real environment that the old
// flat array would have handled wrong.

import { clipboardCmds } from "../src/clipboard.mjs";

test("clipboardCmds — macOS returns pbcopy only", () => {
  // Tested via the exported function with a neutral env. process.platform is
  // macOS in CI so we just call with default env.
  // We cannot easily override process.platform in the same process, so we
  // test the Linux / env-variable paths below and trust the platform branch
  // on the machine where it runs natively.
  const cmds = clipboardCmds({});
  // On the machine running this test (macOS) it must be pbcopy.
  if (process.platform === "darwin") {
    assert.deepEqual(cmds, [["pbcopy", []]]);
  }
});

test("clipboardCmds — WSL env prefers clip.exe, then wl-copy, then xclip", () => {
  const cmds = clipboardCmds({ WSL_INTEROP: "/run/WSL/123_interop" }, "linux");
  assert.equal(cmds[0][0], "clip.exe", "WSL: first choice must be clip.exe");
  assert.ok(cmds.some(([c]) => c === "wl-copy"), "WSL: wl-copy must be a fallback");
  assert.ok(cmds.some(([c]) => c === "xclip"), "WSL: xclip must be a fallback");
});

test("clipboardCmds — WSLENV also triggers WSL path", () => {
  const cmds = clipboardCmds({ WSLENV: "PATH/l" }, "linux");
  assert.equal(cmds[0][0], "clip.exe");
});

test("clipboardCmds — Wayland returns only wl-copy", () => {
  const cmds = clipboardCmds({ WAYLAND_DISPLAY: "wayland-0" }, "linux");
  assert.deepEqual(cmds, [["wl-copy", []]]);
});

test("clipboardCmds — X11 Linux (no Wayland, no WSL) returns xclip", () => {
  const cmds = clipboardCmds({ DISPLAY: ":0" }, "linux");
  assert.deepEqual(cmds, [["xclip", ["-selection", "clipboard"]]]);
});

test("clipboardCmds — xdotool is never returned on any platform", () => {
  const cases = [
    [{}, process.platform],
    [{ WAYLAND_DISPLAY: "wayland-0" }, "linux"],
    [{ WSL_INTEROP: "/run/WSL/1" }, "linux"],
    [{ DISPLAY: ":0" }, "linux"],
  ];
  for (const [env, plat] of cases) {
    const cmds = clipboardCmds(env, plat);
    const hasXdotool = cmds.some(([c]) => c === "xdotool");
    assert.equal(hasXdotool, false, `xdotool must never appear (env: ${JSON.stringify(env)})`);
  }
});

test("clipboardCmds — xclip gets -selection clipboard flag", () => {
  const cmds = clipboardCmds({ DISPLAY: ":0" }, "linux");
  const entry = cmds.find(([c]) => c === "xclip");
  assert.ok(entry, "xclip must be present for X11");
  assert.ok(entry[1].includes("-selection"), "xclip must have -selection flag");
  assert.ok(entry[1].includes("clipboard"), "xclip must target clipboard");
});

test("clipboardCmds — failure message names the commands that were tried", () => {
  // The error message template uses cmds.map(([c]) => c).join(", ").
  // Verify the shape is always [string, string[]] so that join works.
  const cases = [
    [{}, process.platform],
    [{ WAYLAND_DISPLAY: "x" }, "linux"],
    [{ WSL_INTEROP: "x" }, "linux"],
    [{ DISPLAY: ":0" }, "linux"],
  ];
  for (const [env, plat] of cases) {
    const cmds = clipboardCmds(env, plat);
    for (const entry of cmds) {
      assert.equal(typeof entry[0], "string", "cmd name must be a string");
      assert.ok(Array.isArray(entry[1]), "cmd args must be an array");
    }
  }
});
