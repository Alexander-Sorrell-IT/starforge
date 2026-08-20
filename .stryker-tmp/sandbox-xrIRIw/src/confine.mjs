// @ts-nocheck
// OS-level confinement — the only layer that actually proves no-egress.
//
// Everything else in starreckon is policy ("we don't call the network").
// This module is enforcement: it re-runs starreckon inside an OS sandbox
// where the KERNEL refuses network syscalls. That closes every bypass an
// in-process monkey-patch leaves open — Worker-thread realms, spawned
// child processes, dgram UDP, process.binding('tcp_wrap'), patch
// restoration — because the sandbox binds the whole process tree, below
// the JS layer.
//
//   macOS : /usr/bin/sandbox-exec with a deny-network profile.
//           Marked DEPRECATED in Apple's man page, but it still enforces
//           (verified on macOS 15). We do not trust that: the positive
//           control below re-verifies enforcement live on every run.
//   Linux : unshare -rn — a fresh user+network namespace with no
//           interfaces and no routes.
//
// Scope, stated honestly: this seals SOCKETS for the confined process and
// all of its descendants. It cannot stop a file written into a
// cloud-synced directory from leaving the machine later. starreckon writes
// under ~/.starreckon, PLUS any --join-fleet directory you name — and that
// one is a path you chose, so it is the one that can be inside Dropbox or
// iCloud (PROVE-IT.md §6).
//
// ---------------------------------------------------------------------------
// INTENTIONAL, NAMED EXCEPTION TO THE NO-NETWORK RULE
// @starreckon-intentional-egress
//
// proveEgressBlocked() DELIBERATELY attempts ONE outbound TCP connect
// (1.1.1.1:443, a public resolver, short timeout) so the proof can say
// "we tried to leave and the kernel stopped us" — a positive control,
// strictly stronger than "we did not try". This file is the single
// allowed importer of node:net in starreckon; the static warden allowlists
// src/confine.mjs by name for exactly this function.
//
// node:child_process is also imported here and ONLY here: runConfined()
// is the launcher that spawns the confined child. The child gets the
// sandbox; the launcher is what applies it.
// ---------------------------------------------------------------------------
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process"; // launcher exception — spawns the CONFINED child
import { connect } from "node:net"; // @starreckon-intentional-egress — used only by proveEgressBlocked()
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { maskPath } from "./redact.mjs";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

const PROBE_HOST = "1.1.1.1";
const PROBE_PORT = 443;
const PROBE_TIMEOUT_MS = 3000;

// errno values that mean "the OS refused before a packet could leave".
// EPERM  : sandbox-exec denies the connect() syscall.
// ENETUNREACH / ENETDOWN : network namespace with no interfaces/routes.
// EACCES : seccomp / LSM refusal.
const KERNEL_REFUSAL_CODES = new Set(["EPERM", "EACCES", "ENETUNREACH", "ENETDOWN"]);

// ---- detection -------------------------------------------------------------
// Does `unshare -rn` actually WORK, not merely exist?
//
// Ubuntu 23.10+ ships apparmor_restrict_unprivileged_userns=1 by default, so
// /usr/bin/unshare is installed and the kernel refuses it:
//   unshare: write failed /proc/self/uid_map: Operation not permitted
// Detecting the binary with existsSync therefore reported "netns available" on
// the most common Linux desktop, handed the user a proof command that cannot
// run, and — worse — suppressed the `!recommended` note that would have told
// them honestly there is no confinement here, only policy.
//
// This is the same shape as profileParses() below, which has always run
// /usr/bin/true under sandbox-exec rather than trusting the file to be there.
// Linux simply never got the equivalent. Presence is not capability.
function netnsWorks() {
  const u = which("unshare");
  if (!u) return false;
  try {
    return spawnSync(u, ["-rn", "/bin/true"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

export function detectConfinement() {
  const platform = process.platform;
  const available = [];
  if (platform === "darwin" && existsSync(SANDBOX_EXEC)) available.push("sandbox-exec");
  if (platform === "linux" && netnsWorks()) available.push("netns");
  const recommended = available[0] ?? null;

  const notes = [];
  if (available.includes("sandbox-exec")) {
    notes.push(
      "sandbox-exec is marked DEPRECATED in Apple's man page but still enforces; " +
        "the positive control verifies enforcement live instead of trusting it."
    );
  }
  notes.push(
    "OS confinement seals sockets, not files: a report written into a cloud-synced " +
      "folder can still leave the machine later. starreckon writes under ~/.starreckon, plus " +
      "any --join-fleet directory you name — and that directory is the one that can be inside " +
      "a synced folder, because you chose it (PROVE-IT.md §6)."
  );
  if (!recommended) {
    notes.push(
      "no OS-level confinement found on this system — without it there is no real " +
        "no-egress proof, only policy. An in-process patch would be a tripwire, not a control."
    );
    if (platform === "linux" && which("unshare")) {
      notes.push(
        "unshare IS installed here but the kernel refuses it. On Ubuntu 23.10+ " +
          "apparmor_restrict_unprivileged_userns=1 is the default; check with " +
          "`cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns`. Either run " +
          "the scan inside a container with --network none, or allow user " +
          "namespaces for this binary — do not treat the presence of unshare as proof."
      );
    }
  }
  return { platform, available, recommended, notes };
}

function which(cmd) {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, cmd))) return join(dir, cmd);
  }
  return null;
}

// ---- the sandbox profile ---------------------------------------------------
// Shown to the user as part of the proof. Allow everything by default so the
// scan behaves normally; deny only the network — explicitly in both
// directions, plus the wildcard so no network-* operation slips through.
export function sandboxProfile() {
  return [
    "(version 1)",
    ";; starreckon no-egress profile: allow everything EXCEPT the network.",
    ";; Applied by the kernel to the whole process tree — Workers, child",
    ";; processes, and raw tcp_wrap binds inside are all equally confined.",
    "(allow default)",
    "(deny network*)",
    "(deny network-outbound)",
    "(deny network-inbound)",
  ].join("\n");
}

// One-line, comment-free form for embedding in a shell command.
function profileOneLine() {
  return sandboxProfile()
    .split("\n")
    .filter((l) => !l.startsWith(";;"))
    .join(" ");
}

// ---- building the confined command -----------------------------------------
// Returns the argv array actually spawned, so the printed command string and
// the executed process can never drift apart.
//
// The child is launched through /usr/bin/env so it carries
// STARRECKON_CONFINEMENT=<mode>. That is the ONLY reason the variable exists:
// audit.mjs reads it and records which sandbox the run claims to have been
// launched under. It is a label, not evidence — any process can set it, so the
// run log stores it with verified:false. Setting it here (and in
// bin/starreckon-proof.sh) is what stops a genuinely confined run from being
// recorded as "none". Putting it INSIDE argv rather than in spawn's env keeps
// the printed command byte-identical to what is executed.
const ENV_BIN = "/usr/bin/env";
// `entry` so the POSITIVE CONTROL can be run under confinement too, not just
// the scan. Proving the scan completes with the network sealed is only half the
// demonstration; the other half is the probe being refused inside the same wall
// that let it connect outside. Hardcoding cli.mjs made that impossible to do
// from inside the tool.
function buildParts({ argv = [], srcDir = SRC_DIR, mode, entry = "cli.mjs" } = {}) {
  const cli = join(srcDir, entry);
  if (mode === "sandbox-exec") {
    return [
      ENV_BIN,
      "STARRECKON_CONFINEMENT=sandbox-exec",
      SANDBOX_EXEC,
      "-p",
      profileOneLine(),
      process.execPath,
      cli,
      ...argv,
    ];
  }
  if (mode === "netns") {
    return [ENV_BIN, "STARRECKON_CONFINEMENT=netns", "unshare", "-rn", process.execPath, cli, ...argv];
  }
  throw new Error(
    "no OS-level confinement available on this system (need sandbox-exec on macOS " +
      "or unshare on Linux) — cannot build a real no-egress proof, and will not fake one"
  );
}

function shQuote(s) {
  if (/^[A-Za-z0-9_\-./=:,~*]+$/.test(s)) return s;
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

// The exact shell command that re-runs starreckon under confinement. This is
// PRINTED for the user: they can run it themselves and see there is nothing
// hidden in it. A command the user runs is legitimate proof — the user
// controls it.
export function buildProofCommand({ argv = [], srcDir = SRC_DIR } = {}) {
  const mode = detectConfinement().recommended;
  return buildParts({ argv, srcDir, mode }).map(shQuote).join(" ");
}

// ---- running under confinement ---------------------------------------------
// The ONE place starreckon spawns a child process: the launcher for the
// confined re-run. Streams the child's output straight through.
export async function runConfined({ argv = [], srcDir = SRC_DIR, entry = "cli.mjs", quiet = false } = {}) {
  const det = detectConfinement();
  if (!det.recommended) {
    return { ok: false, code: null, mode: null, command: null, error: det.notes.at(-1) };
  }
  const parts = buildParts({ argv, srcDir, mode: det.recommended, entry });
  const command = parts.map(shQuote).join(" ");
  if (!quiet) console.log(`confined run (${det.recommended}): ${maskPath(command)}`);
  const child = spawn(parts[0], parts.slice(1), { stdio: "inherit" });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  return { ok: code === 0, code, mode: det.recommended, command };
}

/**
 * Run the positive-control probe in a CHILD process, with or without the
 * sandbox.
 *
 * The control cannot be run in-process from the CLI: the CLI arms the tripwire
 * at startup, so `net.Socket.connect` is already replaced by a thrower and the
 * probe fails for a reason that has nothing to do with the kernel. An earlier
 * version did exactly that and printed "connected" for a probe the tripwire had
 * blocked — a control that CANNOT succeed is not a control, and reporting it as
 * one turned the whole proof into theatre.
 *
 * Exit codes come from confine.mjs --probe: 0 = kernel refused, 1 = egress open,
 * 2 = ambiguous (a timeout is never counted as blocked).
 */
export async function runProbe({ confined, srcDir = SRC_DIR } = {}) {
  const probe = join(srcDir, "confine.mjs");
  let parts;
  if (confined) {
    const det = detectConfinement();
    if (!det.recommended) return { ok: false, code: null, error: det.notes.at(-1) };
    parts = buildParts({ argv: ["--probe"], srcDir, mode: det.recommended, entry: "confine.mjs" });
  } else {
    parts = [process.execPath, probe, "--probe"];
  }
  const child = spawn(parts[0], parts.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const code = await new Promise((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", resolve);
  });
  return { ok: code != null, code, output: out.trim() };
}

// ---- the positive control ---------------------------------------------------
// @starreckon-intentional-egress
// Actively TRIES to open TCP 1.1.1.1:443. Run inside confinement, the kernel
// must refuse it; run outside, it should connect — together those two results
// prove the wall is real. `blocked` is true ONLY for a definite kernel
// refusal. A timeout is reported as NOT blocked, because dropped packets may
// still have left the machine — an honest proof does not round ambiguity up.
export async function proveEgressBlocked() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    let sock;
    try {
      sock = connect({ host: PROBE_HOST, port: PROBE_PORT, timeout: PROBE_TIMEOUT_MS });
    } catch (e) {
      return done({ attempted: true, blocked: KERNEL_REFUSAL_CODES.has(e.code), error: `${e.code ?? "?"}: ${e.message}` });
    }
    sock.on("connect", () => {
      sock.destroy();
      done({
        attempted: true,
        blocked: false,
        error: `connected to ${PROBE_HOST}:${PROBE_PORT} — egress is OPEN in this context`,
      });
    });
    sock.on("timeout", () => {
      sock.destroy();
      done({
        attempted: true,
        blocked: false,
        error: `timeout after ${PROBE_TIMEOUT_MS}ms — ambiguous (packets may have left and been dropped); not a kernel refusal`,
      });
    });
    sock.on("error", (e) => {
      const refused = KERNEL_REFUSAL_CODES.has(e.code);
      done({
        attempted: true,
        blocked: refused,
        error: refused
          ? `${e.code} on connect() — the kernel refused before any packet could leave (${e.message})`
          : `${e.code ?? "?"}: ${e.message} — reached the network stack; NOT a kernel refusal`,
      });
    });
  });
}

// Self-check used by tests: does the one-line profile actually parse on this
// system? Runs /usr/bin/true under it — no network involved.
export function profileParses() {
  if (!existsSync(SANDBOX_EXEC)) return null;
  const r = spawnSync(SANDBOX_EXEC, ["-p", profileOneLine(), "/usr/bin/true"]);
  return r.status === 0;
}

// ---- CLI entry: `node src/confine.mjs --probe` ------------------------------
// Used by bin/starreckon-proof.sh so the probe logic lives HERE, in the one
// warden-allowlisted file, instead of hiding in a shell one-liner.
// Exit codes: 0 = kernel blocked the attempt, 1 = egress open, 2 = ambiguous.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--probe") {
    const r = await proveEgressBlocked();
    console.log(`egress attempt: TCP ${PROBE_HOST}:${PROBE_PORT} (timeout ${PROBE_TIMEOUT_MS}ms)`);
    console.log(`result: ${r.blocked ? "BLOCKED" : "NOT BLOCKED"} — ${r.error}`);
    process.exit(r.blocked ? 0 : r.error.startsWith("timeout") ? 2 : 1);
  } else {
    const det = detectConfinement();
    console.log(JSON.stringify({ ...det, proofCommand: det.recommended ? maskPath(buildProofCommand({ argv: ["--yes"] })) : null }, null, 2));
  }
}
