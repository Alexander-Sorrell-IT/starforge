// The scheduled re-scan.
//
// This is the one feature in the package that touches anything outside
// ~/.starforge, so it gets the strictest test in the suite: it must write a
// schedule file and NOTHING else, and it must never activate itself. A
// privacy-first tool that silently registers a background job which reads your
// disk every month would be arguing against its own pitch — so "does not
// install itself" is a behaviour worth pinning, not a nicety.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

function run(home, args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, NO_COLOR: "1" },
      encoding: "utf8",
    });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.status ?? 1, stdout: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const fresh = () => mkdtempSync(join(tmpdir(), "sf-daemon-"));

test("daemon on writes a schedule file and activates nothing", (t) => {
  if (platform() !== "darwin" && platform() !== "linux") return t.skip("no scheduler wired for this platform");
  const home = fresh();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const before = run(home, ["daemon", "status"]);
  assert.equal(before.status, 0);
  assert.match(before.stdout, /not written/, "a fresh machine must report no schedule");

  const on = run(home, ["daemon", "on"]);
  assert.equal(on.status, 0, on.stdout);

  const file =
    platform() === "darwin"
      ? join(home, "Library", "LaunchAgents", "work.starforge.scan.plist")
      : join(home, ".config", "systemd", "user", "starforge-scan.timer");
  assert.ok(existsSync(file), `expected a schedule file at ${file}`);

  // The load command must be PRINTED, not executed. If this tool ever starts
  // running it, this assertion is the thing that should stop the commit.
  assert.match(on.stdout, /load it yourself|systemctl --user enable/, "must hand the activation command to the user");
  assert.match(on.stdout, /launchctl load|systemctl --user/, "must print the exact activation command");
});

test("the scheduled command is the same local scan, with no network flags", (t) => {
  if (platform() !== "darwin") return t.skip("plist assertions are macOS-specific");
  const home = fresh();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  run(home, ["daemon", "on"]);
  const plist = readFileSync(join(home, "Library", "LaunchAgents", "work.starforge.scan.plist"), "utf8");

  assert.match(plist, /--yes/, "a scheduled run cannot answer prompts");
  assert.match(plist, /--no-wrapped/, "a background run must not render a paced story to nobody");
  assert.match(plist, /cli\.mjs/, "it must schedule this CLI");
  assert.match(plist, /<false\/>/, "RunAtLoad must be false — enabling it must not trigger a scan");
  // Whatever it schedules, it must not be able to smuggle in an upload flag.
  // Scoped to ProgramArguments: the plist DOCTYPE carries an apple.com URL by
  // format requirement, which is an XML identifier and not a fetch — asserting
  // over the whole file matches that and teaches the next person to delete the
  // check instead of tightening it.
  const argv = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist);
  assert.ok(argv, "expected a ProgramArguments array");
  assert.doesNotMatch(argv[1], /--show-accounts/, "a scheduled run must not de-pseudonymise identities");
  assert.doesNotMatch(argv[1], /curl|https?:|\bnc\b|wget/i, "the scheduled command must not invoke any network tool");
});

test("daemon off removes the file and prints the unload command", (t) => {
  if (platform() !== "darwin" && platform() !== "linux") return t.skip("no scheduler wired for this platform");
  const home = fresh();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  run(home, ["daemon", "on"]);
  const off = run(home, ["daemon", "off"]);
  assert.equal(off.status, 0, off.stdout);
  assert.match(off.stdout, /removed/);
  assert.match(off.stdout, /unload|disable/, "must print how to deactivate what may already be loaded");
  const file = join(home, "Library", "LaunchAgents", "work.starforge.scan.plist");
  if (platform() === "darwin") assert.ok(!existsSync(file), "the schedule file must be gone");
  // ...and running it twice must not be an error.
  assert.equal(run(home, ["daemon", "off"]).status, 0, "daemon off must be idempotent");
});

test("an unknown daemon action exits 2 rather than doing something", () => {
  const home = fresh();
  const r = run(home, ["daemon", "banana"]);
  rmSync(home, { recursive: true, force: true });
  assert.equal(r.status, 2, "an unrecognised action must be refused, not guessed at");
  assert.match(r.stdout, /expected "on", "off" or "status"/);
});

test("a plain scan never writes a schedule", (t) => {
  // The offer printed after a run is an OFFER. Nothing may be installed as a
  // side effect of scanning.
  if (platform() !== "darwin") return t.skip("plist path is macOS-specific");
  const home = fresh();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const r = run(home, ["--yes", "--no-providers", "--no-pace"]);
  assert.equal(r.status, 0, r.stdout);
  assert.ok(
    !existsSync(join(home, "Library", "LaunchAgents", "work.starforge.scan.plist")),
    "scanning must never register a background job"
  );
});
