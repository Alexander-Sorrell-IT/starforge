// Regressions for the four ship blockers a publication review found in the
// build that was about to go public. Each test fails against the code as it
// was, and each names the user-visible damage rather than the internal detail:
//
//   1. A machine with no AI-coding logs made the headline proof print
//      "FAIL: … do not trust the no-egress claim" — after the kernel had just
//      refused the escape attempt in front of the reader.
//   2. That same path never closed the run log, so a clean machine's first run
//      was recorded as an abort and `verify` announced it as one.
//   3. verifyCli's crash handler printed an UNMASKED stack: absolute module
//      paths with the real username, in the output people paste into bug
//      reports.
//   4. outputScrub walked three subdirectories and three extensions while
//      printing a note that implied full coverage — so verify exited 0 with an
//      API key on disk.
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
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { outputScrub, verifyCli, checkState } from "../src/verify.mjs";
import { verifyAuditChain } from "../src/audit.mjs";
import { detectConfinement } from "../src/confine.mjs";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(PKG_ROOT, "src", "cli.mjs");
const PROOF = join(PKG_ROOT, "bin", "starforge-proof.sh");
const tmp = (p = "sf-blocker-") => mkdtempSync(join(tmpdir(), p));

const newestLog = (home) => {
  const dir = join(home, ".starforge", "audit");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => /^run-.*\.json$/.test(f)).sort();
  if (!files.length) return null;
  return JSON.parse(readFileSync(join(dir, files[files.length - 1]), "utf8"));
};

// ---- 1 + 2: the clean machine ----------------------------------------------

test("a machine with no AI-coding logs exits 0 and says so — it is not a failure", (t) => {
  const home = tmp("sf-empty-home-");
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const r = spawnSync(process.execPath, [CLI, "--yes"], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, HOME: home },
  });
  assert.equal(
    r.status,
    0,
    `having nothing to scan must not be an error (bin/starforge-proof.sh gates its verdict on this):\n${r.stdout}${r.stderr}`
  );
  assert.match(r.stdout, /No AI-coding session logs found/);
  assert.match(r.stdout, /not a failure/i);
});

test("the clean-machine run is logged COMPLETE, not as a crash", (t) => {
  const home = tmp("sf-empty-home-");
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const r = spawnSync(process.execPath, [CLI, "--yes"], {
    encoding: "utf8",
    timeout: 120000,
    env: { ...process.env, HOME: home },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);

  const log = newestLog(home);
  assert.ok(log, "the run wrote no audit log at all");
  assert.equal(log.complete, true, `logged as an abort: ${log.abort_reason}`);
  assert.equal(log.abort_reason, null);
  assert.deepEqual(log.reads, {}, "nothing was read, so reads must be empty — not absent");
  assert.deepEqual(log.writes, []);

  // and the chain check must not then announce an INCOMPLETE run to the user
  const chain = verifyAuditChain(join(home, ".starforge", "audit"));
  assert.equal(chain.incomplete_runs, 0, JSON.stringify(chain.notes));
  assert.ok(
    !chain.notes.some((n) => /INCOMPLETE/.test(n)),
    `verify still reports an incomplete run: ${JSON.stringify(chain.notes)}`
  );
});

test("an abort_reason never asserts a crash it cannot know about", (t) => {
  // The exit hook fires on a path that did NOT close the log: SIGTERM here.
  // Whatever it writes must not claim to know why.
  const home = tmp("sf-abort-home-");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const proj = join(home, ".claude", "projects", "P", "Q");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "s.jsonl"),
    JSON.stringify({ type: "user", timestamp: new Date().toISOString(), uuid: "u1", cwd: "/x/y" }) + "\n"
  );

  const r = spawnSync(process.execPath, ["-e", `
    process.env.HOME = ${JSON.stringify(home)};
    const { startAudit, armAuditExitHook } = await import(${JSON.stringify(join(PKG_ROOT, "src", "audit.mjs"))});
    const a = startAudit(["--yes"], { dir: ${JSON.stringify(join(home, ".starforge", "audit"))} });
    armAuditExitHook(a);
    process.exit(7);
  `, "--input-type=module"], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 7, r.stderr);

  const log = newestLog(home);
  assert.ok(log, "the exit hook wrote nothing");
  assert.equal(log.complete, false);
  assert.match(
    log.abort_reason,
    /not recorded here|NOT RECORDED HERE/i,
    `an unexplained exit must not be described as a crash: ${log.abort_reason}`
  );
});

// ---- 1: the headline proof --------------------------------------------------

test("bin/starforge-proof.sh never reports FAIL for a machine that simply has no logs", (t) => {
  if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
    t.skip("macOS + sandbox-exec only (the script refuses to run elsewhere)");
    return;
  }
  const home = tmp("sf-proof-home-");
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const r = spawnSync("sh", [PROOF], {
    encoding: "utf8",
    timeout: 300000,
    env: { ...process.env, HOME: home },
  });
  const out = `${r.stdout}${r.stderr}`;
  // The exact regression string. It must not appear whether the run lands on
  // PASS (network available) or INCONCLUSIVE (offline) — asserting on the exit
  // code alone would conflate INCONCLUSIVE(1) with FAIL(1).
  assert.doesNotMatch(
    out,
    /do not trust the no-egress claim/,
    `the kernel proof reported a network verdict for a non-network reason:\n${out}`
  );
  assert.match(out, /PASS|INCONCLUSIVE/);
  // and the scan's own exit code is still reported, not swallowed
  assert.match(out, /scan under sandbox\s*: exit \d/);
});

// ---- 3: the crash path ------------------------------------------------------

test("verifyCli masks the stack it prints when verify itself crashes", () => {
  const home = homedir();
  const boom = new Error("verify blew up");
  boom.stack =
    `Error: verify blew up\n    at runVerify (file://${home}/starforge/src/verify.mjs:1:1)\n` +
    `    at main (${home}/starforge/src/cli.mjs:2:2)`;

  const printed = [];
  const realError = console.error;
  console.error = (...a) => printed.push(a.join(" "));
  let code;
  try {
    code = verifyCli({
      run: () => {
        throw boom;
      },
      exit: (c) => c,
    });
  } finally {
    console.error = realError;
  }
  const out = printed.join("\n");
  assert.equal(code, 2, "a crashing warden must exit 2, not 1");
  assert.ok(out.includes("verify crashed"));
  assert.ok(
    !out.includes(home),
    `an unmasked absolute stack reached the terminal — this is what gets pasted into bug reports:\n${out}`
  );
  assert.ok(out.includes("~/starforge/src/verify.mjs"), `the stack must survive masking, not vanish:\n${out}`);
});

// ---- 4: the output scrub ----------------------------------------------------

const KEY = `sk-ant-api03-${"A".repeat(40)}`;

test("outputScrub reads EVERY file under the data dir, not three subdirs and three extensions", (t) => {
  const dir = tmp("sf-scrub-wide-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "reports"), { recursive: true });
  mkdirSync(join(dir, "exports"), { recursive: true });
  // wrong extension, right subdir
  writeFileSync(join(dir, "reports", "leak.txt"), `token: ${KEY}\n`);
  // right extension, subdir the old walk never entered
  writeFileSync(join(dir, "exports", "leak.json"), JSON.stringify({ token: KEY }));
  // neither: a file parked at the root of the data dir
  writeFileSync(join(dir, "leak-at-root.md"), `# notes\n\n${KEY}\n`);

  const res = outputScrub(dir, { home: "/nonexistent-home-xyz", user: "" });
  assert.equal(res.pass, false, `verify would exit 0 with an API key on disk: ${JSON.stringify(res.notes)}`);
  for (const f of ["reports/leak.txt", "exports/leak.json", "leak-at-root.md"])
    assert.ok(
      res.findings.some((x) => x.includes(f) && /secret-shaped/.test(x)),
      `${f} was never read: ${JSON.stringify(res.findings)}`
    );
  assert.equal(res.inspected, 3);
  assert.equal(checkState(res), "FAIL");
  // the note must describe what it actually did
  assert.match(res.notes.join(" "), /scanned 3 file\(s\)/);
  assert.match(res.notes.join(" "), /EVERY file, any extension, any depth/);
});

test("what outputScrub declines to read is counted and named, never silently dropped", (t) => {
  const dir = tmp("sf-scrub-skip-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "reports"), { recursive: true });
  writeFileSync(join(dir, "reports", "ok.json"), JSON.stringify({ sessions: 1 }));
  // binary: a NUL byte in the first bytes
  writeFileSync(join(dir, "reports", "card.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  // oversize: past the read cap
  writeFileSync(join(dir, "reports", "huge.json"), Buffer.alloc(5 * 1024 * 1024, 0x20));

  const res = outputScrub(dir, { home: "/nonexistent-home-xyz", user: "" });
  const note = res.notes.join(" ");
  assert.equal(res.inspected, 1);
  assert.match(note, /NOT inspected/);
  assert.match(note, /1 binary \(reports\/card\.png\)/);
  assert.match(note, /1 over 4 MB \(reports\/huge\.json/);
  // and the limits say a leak can hide behind either skip
  const limits = res.limits.join("\n");
  assert.match(limits, /4 MB/);
  assert.match(limits, /NUL byte/);
  assert.match(limits, /symlink/i);
});

test("an empty data dir still reports SKIP, and says the walk covered everything", (t) => {
  const dir = tmp("sf-scrub-none-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const res = outputScrub(dir, { home: "/nonexistent-home-xyz", user: "" });
  assert.equal(res.pass, true);
  assert.equal(checkState(res), "SKIP", "a check that read nothing is never a green PASS");
  const note = res.notes.join(" ");
  assert.match(note, /nothing to scrub/);
  assert.match(note, /every file, any extension, any depth/i);
  assert.doesNotMatch(note, /reports\/snapshots\/audit files yet/);
});

// ---- 5: "writes only under ~/.starforge" was false whenever --join-fleet ran -

test("nothing claims starforge writes ONLY under ~/.starforge — --join-fleet writes where you point it", () => {
  const confineNote = detectConfinement().notes.join("\n");
  assert.match(confineNote, /--join-fleet/, "the confinement note still hides the second write target");
  assert.doesNotMatch(confineNote, /writes only under/);

  for (const f of [join(PKG_ROOT, "src", "confine.mjs"), join(PKG_ROOT, "bin", "starforge-proof.sh")]) {
    const body = readFileSync(f, "utf8");
    assert.doesNotMatch(body, /writes\s+(?:reports\s+)?only under ~\/\.starforge/, `${f} still claims it`);
    assert.match(body, /--join-fleet/, `${f} never mentions the directory it also writes`);
  }
});
