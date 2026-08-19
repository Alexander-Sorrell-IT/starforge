// Every door that must NOT open, and every subcommand branch nobody had run.
//
// WHY THIS FILE EXISTS
//
// The surface was enumerated from src/cli.mjs — 10 `subcommand ===` branches,
// 41 registered flags, 14 before-you-go menu keys, one compare sub-menu, one
// contact sub-menu, one bin/ script — and then each entry was matched against
// the test that touches it. Six subcommand branches had NO end-to-end test at
// all: their modules were tested, the CLI wiring that reaches those modules was
// not. A module test passes happily while the branch that calls it is dead.
//
// Two states are covered here that the rest of the suite does not distinguish:
//
//   1. REFUSAL. cli.mjs exits 2 for an unknown subcommand, an unknown daemon
//      action, a `search` with no query, and a flag on a subcommand that reads
//      none. Exactly one of those (the flag case) was tested. A refusal that
//      stops refusing looks exactly like a feature until it writes something.
//
//   2. REGISTERED BUT NEVER READ. tests/cli-ux.test.mjs holds the flag registry
//      down in three directions — spec↔header, read→registered, proof-path→
//      registered — and there is no fourth: registered→read. That gap is not
//      hypothetical, see the KNOWN_INERT block below.
//
// Nothing here downloads, installs, or touches the real HOME. Every run gets a
// throwaway home; the `search` cases are chosen so no python is ever spawned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "src", "cli.mjs");
const CLI_SRC = readFileSync(CLI, "utf8");

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "sf-surface-"));
  const proj = join(home, ".claude", "projects", "demo");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "session.jsonl"),
    JSON.stringify({ type: "user", timestamp: "2026-08-01T10:00:00.000Z", uuid: "u1" }) + "\n"
  );
  return home;
}

const run = (home, argv, { input = "", env = {} } = {}) =>
  spawnSync(process.execPath, [CLI, ...argv], {
    input,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, HOME: home, NO_COLOR: "1", ...env },
  });

// The question a refusal test actually has to answer. Exit 2 is a claim; "the
// disk is untouched" is the fact. Every refusal below is checked both ways,
// because the whole reason cli.mjs refuses instead of ignoring is that an
// ignored flag WRITES what the reader asked it not to.
const nothingWritten = (home) =>
  !existsSync(join(home, ".starreckon")) &&
  !existsSync(join(home, "Desktop", "starreckon")) &&
  !existsSync(join(home, ".config", "systemd", "user")) &&
  !existsSync(join(home, "Library", "LaunchAgents"));

// ── 1. the subcommand allowlist ─────────────────────────────────────────────

test("an unknown subcommand exits 2, names the whole allowlist, and writes nothing", () => {
  const home = fakeHome();
  const r = run(home, ["scna"]);
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /unknown command "scna"/);
  // The message must list the real set, not a stale hand-written copy of it:
  // every subcommand the CLI dispatches has to appear in the sentence that
  // tells a reader what they may type.
  for (const known of ["scan", "verify", "prove", "daemon", "protect", "receipt", "serve", "search", "addons", "sources", "series"])
    assert.ok(r.stderr.includes(known), `the refusal does not offer "${known}": ${r.stderr}`);
  assert.ok(nothingWritten(home), "a refused subcommand read or wrote something");
});

test("the KNOWN_SUBCOMMANDS set and the dispatch branches are the same set", () => {
  // A subcommand in the allowlist with no branch falls through to the SCAN —
  // `starreckon serve` typo'd into the set would silently scan your disk. A
  // branch with no allowlist entry is unreachable. Both are one edit away.
  const setLine = CLI_SRC.match(/const KNOWN_SUBCOMMANDS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(setLine, "KNOWN_SUBCOMMANDS not found in src/cli.mjs");
  const listed = new Set([...setLine[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]));
  const dispatched = new Set(
    [...CLI_SRC.matchAll(/subcommand === "([a-z]+)"/g)].map((m) => m[1])
  );
  // `scan` is the default and has no `subcommand ===` branch — it is the
  // fall-through, which is exactly why it needs no dispatch site.
  dispatched.add("scan");
  assert.deepEqual(
    [...listed].sort(),
    [...dispatched].sort(),
    "a subcommand is allowed but not dispatched (it would silently scan), or dispatched but not allowed (unreachable)"
  );
});

// ── 2. the refusals ─────────────────────────────────────────────────────────

test("`daemon` with an unknown action exits 2 and writes no schedule file", () => {
  const home = fakeHome();
  const r = run(home, ["daemon", "enable"]);
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /expected "on", "off" or "status"/);
  assert.match(r.stderr, /got "enable"/);
  assert.ok(nothingWritten(home), "a refused daemon action wrote something");
});

test("`search` with no query and no mode exits 2 and names the three modes", () => {
  // The one `search` case that is safe to run end-to-end: it must refuse
  // BEFORE runSearch() is reached, so nothing is spawned and nothing is
  // fetched. If this ever exits 0 the next thing it does is a 600 MB download.
  const home = fakeHome();
  const r = run(home, ["search"]);
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /provide a query/);
  for (const mode of ["--search-setup", "--search-index", "--search-status"])
    assert.ok(r.stderr.includes(mode), `the refusal does not mention ${mode}`);
  assert.ok(!existsSync(join(home, ".starreckon", ".venv-search")), "a refused search created the venv");
});

test("a scan flag on a subcommand that reads none is refused, per subcommand", () => {
  // SUBCOMMAND_FLAGS is a per-subcommand allowlist and every entry in it is a
  // separate door. Only `verify --json` was covered; these four read no flags
  // at all, so a flag on them is the same silent-ignore the parser exists to
  // end — and `protect` is the one that WRITES.
  const home = fakeHome();
  for (const sub of ["protect", "addons", "sources", "series"]) {
    const r = run(home, [sub, "--json"]);
    assert.equal(r.status, 2, `${sub} --json was accepted: ${r.stdout}${r.stderr}`);
    assert.ok(
      r.stderr.includes(`\`${sub}\` takes no flags`),
      `${sub} must name itself in the refusal, got: ${r.stderr}`
    );
    assert.ok(nothingWritten(home), `${sub} --json wrote something before refusing`);
  }
});

test("`serve` accepts only its own four flags and refuses the scan's", () => {
  const home = fakeHome();
  // A scan flag on serve would be silently ignored — and --no-projects being
  // ignored is a privacy request dropped, which is the exact failure class.
  const r = run(home, ["serve", "--no-projects"]);
  assert.equal(r.status, 2, `serve --no-projects was accepted: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /`serve` takes no flags/);
  assert.ok(nothingWritten(home));
});

test("`receipt --json` is the ONE declared exception and emits parseable JSON", () => {
  // The comment above SUBCOMMAND_FLAGS calls this exception "declared, not
  // inferred". Nothing checked that the declaration works, so the exception
  // could have been deleted and only the comment would have noticed.
  const home = fakeHome();
  const r = run(home, ["receipt", "--json"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(typeof parsed, "object");
  assert.ok(parsed !== null, "receipt --json emitted null");
  // …and the same command without --json is the human rendering, not JSON.
  const human = run(home, ["receipt"]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /starreckon receipt/);
  assert.throws(() => JSON.parse(human.stdout), "bare `receipt` must not print JSON");
});

test("-h and --help print the same help, exit 0, and touch nothing", () => {
  // The help button. Neither spelling was ever spawned by a test; the only
  // reference to printHelp() in the suite is a string inside a verify fixture.
  // It runs before startAudit(), so a run log here would be a bug of its own.
  const home = fakeHome();
  const short = run(home, ["-h"]);
  const long = run(home, ["--help"]);
  assert.equal(short.status, 0, short.stderr);
  assert.equal(long.status, 0, long.stderr);
  assert.equal(short.stdout, long.stdout, "-h and --help must print the same bytes");
  assert.ok(short.stdout.length > 500, "help is suspiciously short");
  // It has to actually document the surface, not just print a banner.
  for (const needle of ["SUBCOMMANDS", "PRIVACY", "BEFORE-YOU-GO MENU", "ENVIRONMENT", "--no-projects", "receipt", "series"])
    assert.ok(short.stdout.includes(needle), `help omits ${needle}`);
  assert.ok(nothingWritten(home), "printing help wrote something");
});

// ── 3. the subcommand branches nobody had run ───────────────────────────────
//
// sources/series/addons each have a module test file and a `subcommand ===`
// branch that lazily imports that module. The branch itself — the dynamic
// import, the render call, the exit code — had no test. A renamed export would
// pass every module test in the suite and throw on the CLI.

test("`sources` runs end-to-end, exits 0, and reports states rather than silence", () => {
  const home = fakeHome();
  const r = run(home, ["sources"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(r.stdout.trim().length > 0, "sources printed nothing");
  // The whole point of the view: a source nothing can count is named, not
  // omitted and not rendered as a zero.
  assert.match(r.stdout, /claude/i, "the survey does not mention the CLI it was built for");
  assert.ok(nothingWritten(home), "`sources` wrote a run log — it is a read-only question");
});

test("`series` runs end-to-end, exits 0 whatever the counts, and writes nothing", () => {
  const home = fakeHome();
  const r = run(home, ["series"]);
  // "It is a count, not a witness. …nothing here predicts, scores or gates and
  // it exits 0 whatever the counts are." — src/cli.mjs. On this home the count
  // is zero, which is the case the sentence was written for.
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(r.stdout.trim().length > 0, "series printed nothing");
  assert.ok(nothingWritten(home), "`series` wrote a run log — it is a read-only question");
});

test("`addons` runs end-to-end, exits 0, and makes no network call", () => {
  const home = fakeHome();
  const r = run(home, ["addons"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(r.stdout.trim().length > 0, "addons printed nothing");
  assert.ok(nothingWritten(home), "`addons` wrote a run log — it is a read-only question");
});

test("`prove` prints the proof command without running anything", () => {
  // `prove` was touched by cli-ux.test.mjs — `assert.equal(runCli(home,
  // ["prove"]).status, 0)` — as the control in a flag-refusal test. Exit 0 is
  // not the behaviour; printing a command you can run is.
  const home = fakeHome();
  const r = run(home, ["prove"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /bin\/starreckon-proof\.sh/, "prove must hand over the scripted proof");
  assert.match(r.stdout, /platform:/, "prove must say what confinement this platform has");
  // It PRINTS the command; it must not have executed a scan on the way past.
  assert.ok(nothingWritten(home), "`prove` ran something — it is supposed to print and exit");
});

// ── 4. the fourth direction of the flag registry ────────────────────────────

// Flags that are registered in FLAG_SPEC and accepted by the parser but that no
// line of cli.mjs ever reads. Passing one is accepted in silence, which is the
// precise failure the FLAG_SPEC comment says it exists to end:
//
//   "A typo that quietly drops a privacy request is worse than a refusal, so an
//    unregistered flag exits 2 and nothing is read or written."
//
// A correctly-spelled, DOCUMENTED flag being dropped is the same failure with
// the typo removed. Both entries below are defects, not design:
//
//   --contact[=FILE]  the usage header (src/cli.mjs:73-77) promises "set or
//                     view contact info shown in the QR". Neither happens:
//                     `starreckon --contact=/tmp/x.json` exits 0, writes no
//                     contact.json, and prints nothing about contact at all.
//                     The [R] menu key is the only working way in.
//   --wrapped         documented as "(default)". Passing it is a no-op that
//                     happens to coincide with the default, so the behaviour is
//                     right by accident rather than by a call site.
//
// This list is a tripwire in BOTH directions: a new dead flag fails the first
// assertion, and implementing either of these fails the second. Do not add to
// it to make a build green.
const KNOWN_INERT = new Set(["--contact", "--wrapped"]);

test("no flag is registered and documented but never read (beyond the two known defects)", () => {
  const block = CLI_SRC.slice(CLI_SRC.indexOf("const FLAG_SPEC"), CLI_SRC.indexOf("const KNOWN_FLAGS"));
  assert.ok(block.length > 50, "FLAG_SPEC block not found in src/cli.mjs");
  const registered = [...block.matchAll(/"(--[a-z0-9-]+)":/g)].map((m) => m[1]);
  const read = new Set([
    ...[...CLI_SRC.matchAll(/\bflag\("(--[a-z0-9-]+)"\)/g)].map((m) => m[1]),
    ...[...CLI_SRC.matchAll(/\bopt\("([a-z0-9-]+)"\)/g)].map((m) => `--${m[1]}`),
    // optOrFlag("x") — the author's helper for a flag usable with AND without
    // =VALUE (--fleet, --join-fleet). It reads both spellings, so a flag that
    // reaches it is read, and a scanner that only knows the two literal forms
    // reported --fleet and --join-fleet as dead the day the helper landed.
    ...[...CLI_SRC.matchAll(/\boptOrFlag\("([a-z0-9-]+)"\)/g)].map((m) => `--${m[1]}`),
  ]);
  const inert = registered.filter((f) => !read.has(f));
  const surprising = inert.filter((f) => !KNOWN_INERT.has(f));
  assert.deepEqual(
    surprising,
    [],
    `registered, accepted, and never read — passing these is a silent no-op: ${surprising.join(", ")}`
  );
  const fixed = [...KNOWN_INERT].filter((f) => read.has(f));
  assert.deepEqual(
    fixed,
    [],
    `${fixed.join(", ")} now has a call site — delete it from KNOWN_INERT and assert what it does`
  );
});

test("--contact is accepted and does nothing at all — the defect, pinned", () => {
  // Pinned so the day it is implemented, this fails and gets replaced by a test
  // of what it DOES. Until then the suite states the gap out loud rather than
  // leaving a documented flag looking covered because it exits 0.
  const home = fakeHome();
  const target = join(home, "my-contact.json");
  writeFileSync(target, JSON.stringify({ github: "octocat" }));
  const r = run(home, ["--contact=" + target, "--yes", "--no-wrapped", "--no-pace", "--no-providers", "--no-snapshot"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(
    existsSync(join(home, ".starreckon", "contact.json")),
    false,
    "--contact now writes contact.json — it is implemented; replace this test"
  );
  assert.ok(
    !r.stdout.includes("octocat"),
    "--contact now reads the file it was given — it is implemented; replace this test"
  );
});

// ── 5. the shipped script ───────────────────────────────────────────────────

test("bin/starreckon-proof.sh refuses to run on a platform it cannot prove anything on", () => {
  // The headline proof. On Linux it must exit 2 with the platform note and the
  // alternative command — never print a verdict it did not earn. (On macOS it
  // would really run sandbox-exec, so the assertion is platform-scoped and the
  // gap is stated rather than faked.)
  const script = join(ROOT, "bin", "starreckon-proof.sh");
  assert.ok(existsSync(script), "the scripted proof must ship");
  if (process.platform === "darwin") {
    // Covered on macOS by running it for real; not run here because it takes
    // minutes and needs a working network for the positive control.
    return;
  }
  const r = spawnSync("sh", [script], { encoding: "utf8", timeout: 30000, env: { ...process.env, HOME: fakeHome() } });
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout + r.stderr, /macOS-only/);
  assert.match(r.stdout + r.stderr, /unshare -rn/, "it must hand a Linux reader the equivalent command");
});

test("every subcommand in the help text is one the parser accepts", () => {
  // The help is a promise. A subcommand named there that the allowlist does not
  // carry exits 2 for a reader who typed exactly what they were told to type.
  const home = fakeHome();
  const help = run(home, ["--help"]).stdout;
  const block = help.slice(help.indexOf("SUBCOMMANDS"), help.indexOf("BEFORE-YOU-GO MENU"));
  assert.ok(block.length > 50, "no SUBCOMMANDS block in the help output");
  const named = new Set(
    block
      .split("\n")
      .map((l) => l.match(/^\s{2}([a-z]+)\b/))
      .filter(Boolean)
      .map((m) => m[1])
  );
  assert.ok(named.size >= 8, `only parsed ${named.size} subcommands out of the help block`);
  const setLine = CLI_SRC.match(/const KNOWN_SUBCOMMANDS = new Set\(\[([^\]]*)\]\)/);
  const allowed = new Set([...setLine[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]));
  for (const s of named)
    assert.ok(allowed.has(s), `the help offers "${s}" but the parser rejects it`);
});

// ── 6. what this file does NOT reach ────────────────────────────────────────
//
// Stated here rather than left to be inferred from absence:
//
//   `search --search-setup` / --search-index / --search-status — every one
//   spawns python and the first downloads ~600 MB. Not run. The refusal path
//   above is the only `search` behaviour covered end-to-end.
//
//   [P] prove and [B] beacon in the menu — [P] fires a real TCP probe and runs
//   a confined child scan; [B] broadcasts on the LAN for 8 seconds. Both are
//   machine- and network-dependent and would be flaky here.
//
//   bin/starreckon-proof.sh on macOS — the real path. Only the Linux refusal
//   is asserted above.
