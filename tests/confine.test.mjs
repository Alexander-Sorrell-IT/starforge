import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectConfinement,
  sandboxProfile,
  buildProofCommand,
  runConfined,
  proveEgressBlocked,
  profileParses,
} from "../src/confine.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFINE = join(HERE, "..", "src", "confine.mjs");
const det = detectConfinement();
const onMacWithSandbox = det.platform === "darwin" && det.available.includes("sandbox-exec");

test("detectConfinement reports platform, available modes, and honest notes", () => {
  assert.equal(det.platform, process.platform);
  assert.ok(Array.isArray(det.available));
  assert.ok(Array.isArray(det.notes) && det.notes.length > 0);
  if (det.platform === "darwin") {
    // this repo is developed on a Mac with sandbox-exec present
    assert.ok(det.available.includes("sandbox-exec"));
    assert.equal(det.recommended, "sandbox-exec");
    assert.ok(det.notes.some((n) => n.includes("DEPRECATED")));
  }
  // the filesystem-egress caveat must always be stated
  assert.ok(det.notes.some((n) => n.includes("sockets, not files")));
});

test("sandboxProfile denies the network explicitly and allows the rest", () => {
  const p = sandboxProfile();
  assert.ok(p.startsWith("(version 1)"));
  assert.ok(p.includes("(allow default)"));
  assert.ok(p.includes("(deny network*)"));
  assert.ok(p.includes("(deny network-outbound)"));
  assert.ok(p.includes("(deny network-inbound)"));
});

test("the profile actually parses under sandbox-exec", { skip: !onMacWithSandbox }, () => {
  assert.equal(profileParses(), true);
});

test("buildProofCommand is an inspectable one-line shell command", { skip: !det.recommended }, () => {
  const cmd = buildProofCommand({ argv: ["--yes", "--no-snapshot"] });
  assert.equal(typeof cmd, "string");
  assert.ok(cmd.includes("cli.mjs"));
  assert.ok(cmd.includes("--yes"));
  assert.ok(cmd.includes("--no-snapshot"));
  assert.ok(!cmd.includes("\n"));
  if (det.recommended === "sandbox-exec") {
    // the confined child is launched through /usr/bin/env so it carries the
    // confinement label into its own audit log — see the next test for why
    assert.ok(cmd.startsWith("/usr/bin/env STARRECKON_CONFINEMENT=sandbox-exec /usr/bin/sandbox-exec -p "), cmd);
    assert.ok(cmd.includes("deny network"));
  }
});

test("the confined command SETS STARRECKON_CONFINEMENT, so a confined run is not logged as unconfined", { skip: !det.recommended }, async () => {
  // The audit log's confinement field used to be dead-wired: nothing in the
  // tree ever set the variable, so a genuinely sandboxed run recorded
  // mode "none". The launcher must set it — as a self-reported CLAIM
  // (audit.mjs keeps verified:false; only the user-run probe is proof).
  const cmd = buildProofCommand({ argv: ["--yes"] });
  assert.ok(cmd.includes(`STARRECKON_CONFINEMENT=${det.recommended}`), cmd);

  // and the value really reaches the child: a stub cli that prints it, run
  // through the exact command string the tool prints for the user (which also
  // pins that the printed command is runnable verbatim in a shell).
  const dir = mkdtempSync(join(tmpdir(), "confine-env-"));
  writeFileSync(
    join(dir, "cli.mjs"),
    'console.log("CLAIM:" + (process.env.STARRECKON_CONFINEMENT ?? "unset"));\n'
  );
  const res = await runConfined({ argv: [], srcDir: dir });
  assert.equal(res.ok, true);
  const r = spawnSync("/bin/sh", ["-c", res.command], { encoding: "utf8", timeout: 15000 });
  assert.match(r.stdout, new RegExp(`CLAIM:${det.recommended}`), r.stdout + r.stderr);
});

test("runConfined spawns the command inside confinement and streams output", { skip: !det.recommended }, async () => {
  // stub cli so this test is fast and independent of the real scan
  const dir = mkdtempSync(join(tmpdir(), "confine-test-"));
  writeFileSync(join(dir, "cli.mjs"), 'console.log("stub-cli-ok");\n');
  const res = await runConfined({ argv: [], srcDir: dir });
  assert.equal(res.ok, true);
  assert.equal(res.code, 0);
  assert.equal(res.mode, det.recommended);
  assert.ok(res.command.includes("cli.mjs"));
});

test("proveEgressBlocked returns an honest, typed result", async () => {
  const r = await proveEgressBlocked();
  assert.equal(r.attempted, true);
  assert.equal(typeof r.blocked, "boolean");
  assert.equal(typeof r.error, "string");
  assert.ok(r.error.length > 0);
});

test("kernel-verified: probe INSIDE sandbox-exec is refused (exit 0)", { skip: !onMacWithSandbox }, () => {
  const profile = "(version 1) (allow default) (deny network*) (deny network-outbound) (deny network-inbound)";
  const r = spawnSync(
    "/usr/bin/sandbox-exec",
    ["-p", profile, process.execPath, CONFINE, "--probe"],
    { encoding: "utf8", timeout: 15000 }
  );
  assert.equal(r.status, 0, `expected BLOCKED (exit 0), got exit ${r.status}: ${r.stdout} ${r.stderr}`);
  assert.ok(r.stdout.includes("BLOCKED"));
  assert.ok(r.stdout.includes("kernel refused"));
});

test("probe outside the sandbox does not claim a kernel refusal it did not see", () => {
  // Offline machines legitimately produce ENETDOWN/ENETUNREACH (a real kernel
  // refusal), so we only pin the shape here; the INSIDE/OUTSIDE contrast is
  // asserted by bin/starreckon-proof.sh, which requires the outside control to
  // CONNECT before it will print PASS.
  const r = spawnSync(process.execPath, [CONFINE, "--probe"], { encoding: "utf8", timeout: 15000 });
  assert.ok([0, 1, 2].includes(r.status));
  assert.ok(r.stdout.includes("egress attempt: TCP 1.1.1.1:443"));
});

test("the intentional-egress exception is statically detectable by name", () => {
  const src = readFileSync(CONFINE, "utf8");
  const markers = src.match(/@starreckon-intentional-egress/g) ?? [];
  assert.ok(markers.length >= 2, "marker must appear in the header AND at the net import/probe");
  assert.ok(src.includes('from "node:net"'), "the net import lives here, nowhere else");
});
