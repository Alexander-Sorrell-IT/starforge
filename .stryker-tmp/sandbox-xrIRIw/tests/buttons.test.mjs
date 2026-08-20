// @ts-nocheck
// Every button that WRITES, DELETES or OVERWRITES — asserted by the bytes.
//
// WHY THIS FILE EXISTS
//
// The before-you-go menu has fourteen keys. Seven of them had a test: [T], [E]
// (add and remove), [D], [I], [A], [G], [Q]. The seven that did not include
// every one that changes a file:
//
//   [R] reach out    writes ~/.starreckon/contact.json, and its [X] key
//                    DELETES the file outright
//   [C] compare      its [S] key writes ~/.starreckon/reports/compare-*.txt
//   [X] copy link    puts your name, email and phone on the clipboard
//   [Z] re-run       spawns a second full scan
//   [H] help         must print and STAY in the menu, not fall through to done
//
// And three file-writing FLAGS had no test at all: --sessions, --report, and
// the Desktop snapshot that every default run writes without any flag.
//
// The rule this file is written to: assert what the button DOES. An exit code
// is not a behaviour, and neither is a line of output claiming a file was
// saved. Every assertion below reads the filesystem after the keypress.
//
// Sandboxed HOME everywhere. Nothing here downloads, installs, or opens a
// socket; the one clipboard path is asserted through its FAILURE branch, which
// is what a machine with no clipboard tool actually takes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "src", "cli.mjs");

// Two sessions in two months, so the timeline has something to compare and the
// per-session export has more than one record to keep apart.
function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "sf-buttons-"));
  const proj = join(home, ".claude", "projects", "demo");
  mkdirSync(proj, { recursive: true });
  const row = (ts, uuid) =>
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      uuid,
      sessionId: uuid,
      message: { model: "claude-opus-4", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } },
    });
  writeFileSync(join(proj, "a.jsonl"), row("2026-07-02T10:00:00.000Z", "sess-a") + "\n");
  writeFileSync(join(proj, "b.jsonl"), row("2026-08-02T10:00:00.000Z", "sess-b") + "\n");
  return home;
}

const SCAN = ["--yes", "--no-wrapped", "--no-pace", "--no-providers"];

const run = (home, argv, { input = "", interactive = false, env = {} } = {}) =>
  spawnSync(process.execPath, [CLI, ...argv], {
    input,
    encoding: "utf8",
    timeout: 90000,
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: "1",
      ...(interactive ? { STARRECKON_FORCE_INTERACTIVE: "1" } : {}),
      ...env,
    },
  });

const reports = (home) => {
  const d = join(home, ".starreckon", "reports");
  return existsSync(d) ? readdirSync(d) : [];
};
const scheduleFiles = (home) => {
  const out = [];
  for (const d of [join(home, ".config", "systemd", "user"), join(home, "Library", "LaunchAgents")]) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (f.includes("starreckon")) out.push(join(d, f));
  }
  return out;
};

// ── 1. daemon off — the delete button ───────────────────────────────────────
//
// `daemon on` was covered (tests/layerlog.test.mjs, tests/adoor.test.mjs use it
// to reach the already-installed state). `daemon off`, which REMOVES those
// files, had no test in the suite at all.

test("`daemon off` deletes every schedule file `daemon on` wrote, and names each one", () => {
  const home = fakeHome();
  assert.equal(run(home, ["daemon", "on"]).status, 0);
  const written = scheduleFiles(home);
  if (!written.length) return; // unsupported platform: covered by the notice test below
  assert.ok(written.length >= 2, `daemon on wrote only ${written.length} file(s)`);

  const off = run(home, ["daemon", "off"]);
  assert.equal(off.status, 0, `${off.stdout}${off.stderr}`);
  assert.deepEqual(scheduleFiles(home), [], "daemon off left schedule files behind");
  // Every removed file is named — a delete you cannot audit is the one that
  // removes the file you meant to keep.
  for (const f of written) {
    const base = f.split("/").pop();
    assert.ok(off.stdout.includes(base), `daemon off deleted ${base} without saying so`);
  }
  // It removes the files; it does NOT unload the job. The unload command is
  // printed for the reader to run, and that promise is the whole design.
  assert.match(off.stdout, /this tool does not run this for you/i);
  assert.match(off.stdout, /systemctl --user disable|launchctl/, "the unload command must be printed");
});

test("`daemon off` with nothing installed says so and creates nothing", () => {
  const home = fakeHome();
  const r = run(home, ["daemon", "off"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  if (r.stdout.includes("no scheduler wired")) return; // unsupported platform
  assert.match(r.stdout, /nothing to remove/i);
  assert.deepEqual(scheduleFiles(home), [], "daemon off on a clean machine created files");
});

// ── 2. the file-writing flags nobody had run ────────────────────────────────

test("--sessions writes the per-session export with the four counters kept apart", () => {
  const home = fakeHome();
  const r = run(home, [...SCAN, "--no-snapshot", "--sessions"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const file = reports(home).find((f) => f.startsWith("sessions-"));
  assert.ok(file, `no sessions-*.json written; reports dir holds: ${reports(home).join(", ")}`);
  const doc = JSON.parse(readFileSync(join(home, ".starreckon", "reports", file), "utf8"));
  const rows = Array.isArray(doc) ? doc : doc.sessions ?? doc.records;
  assert.ok(Array.isArray(rows) && rows.length >= 2, `expected one record per session, got: ${JSON.stringify(doc).slice(0, 300)}`);
  // The stated reason this export exists: "its four token counters kept apart,
  // …so another counter can be compared session by session instead of only on
  // grand totals, which a swap between two sessions survives." A record that
  // collapsed them into one total would defeat the whole file.
  const one = rows[0];
  const keys = Object.keys(one).join(" ") + " " + Object.keys(one.tokens ?? {}).join(" ");
  for (const counter of ["input", "output", "cache"])
    assert.ok(keys.toLowerCase().includes(counter), `a session record has no ${counter} counter: ${JSON.stringify(one)}`);
});

test("--sessions obeys --no-projects, and the file says which of the two it did", () => {
  // The usage header promises exactly this ("Obeys --no-projects") and nothing
  // checked it. A privacy promise on a file-writing flag, unasserted.
  //
  // Both halves are asserted because the masking is applied TWICE — once in
  // sessionRecords({ noProjects }) and again by forFiles() on the whole payload
  // — so removing either one alone leaves the bytes unchanged and only the
  // declaration inside the file records which path ran.
  const home = fakeHome();
  assert.equal(run(home, [...SCAN, "--no-snapshot", "--sessions", "--no-projects"]).status, 0);
  let file = reports(home).find((f) => f.startsWith("sessions-"));
  assert.ok(file, "no sessions export written");
  const masked = JSON.parse(readFileSync(join(home, ".starreckon", "reports", file), "utf8"));
  const text = JSON.stringify(masked);
  assert.ok(!text.includes("demo"), `the real project name survived --no-projects: ${text.slice(0, 400)}`);
  assert.match(masked.masking.projects, /proj-<hash>/, "the file must record that it masked projects");
  assert.match(masked.masking.session_ids, /replaced with proj-<hash>/);

  // The inverse, so the assertion above is not passing because the fixture has
  // no project name to leak in the first place.
  const plain = fakeHome();
  assert.equal(run(plain, [...SCAN, "--no-snapshot", "--sessions"]).status, 0);
  file = reports(plain).find((f) => f.startsWith("sessions-"));
  const unmasked = JSON.parse(readFileSync(join(plain, ".starreckon", "reports", file), "utf8"));
  assert.match(unmasked.masking.projects, /two-segment labels/,
    "without --no-projects the file must say it kept readable labels");
  assert.notEqual(
    JSON.stringify(unmasked.sessions),
    JSON.stringify(masked.sessions),
    "--no-projects changed nothing in the records it writes"
  );
});

test("--card writes an SVG that is actually an SVG", () => {
  // Bob's branch found this one and mine had missed it: --card is named in
  // comments and in the README but nothing had ever run it and looked at the
  // file. A renderer returning "" leaves a 0-byte file that existsSync calls a
  // success.
  const home = fakeHome();
  const r = run(home, [...SCAN, "--no-snapshot", "--card"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const file = reports(home).find((f) => /^star-.*\.svg$/.test(f));
  assert.ok(file, `no star-*.svg written; reports dir holds: ${reports(home).join(", ")}`);
  const svg = readFileSync(join(home, ".starreckon", "reports", file), "utf8");
  assert.match(svg, /<svg/, "--card wrote something that is not an SVG");
  assert.match(svg, /<\/svg>/, "--card wrote a truncated SVG");
  assert.ok(svg.length > 400, `the card is ${svg.length} bytes — an empty render, not a card`);
});

test("--reset-audit with no value DELETES the run logs and records the deletion", () => {
  // The "opt" form. cli-ux.test.mjs covers --reset-audit=WHY; the bare spelling
  // — the one a person types — was never run. It is the only DELETE in the tool
  // that removes an audit trail, so what replaces the trail is the whole point.
  const home = fakeHome();
  assert.equal(run(home, [...SCAN, "--no-snapshot"]).status, 0);
  assert.equal(run(home, [...SCAN, "--no-snapshot"]).status, 0);
  const auditDir = join(home, ".starreckon", "audit");
  const before = readdirSync(auditDir);
  assert.ok(before.length >= 2, `expected at least 2 run logs, found ${before.length}`);

  const r = run(home, ["--reset-audit"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const after = readdirSync(auditDir);
  // Every log that existed is gone…
  for (const f of before)
    assert.ok(!after.includes(f), `--reset-audit left ${f} behind`);
  // …and what stands in their place records the deletion, so the history of
  // how much history there was does not vanish with it. Each field is asserted
  // on its own: an alternation over "sha256 OR removed" would pass with the
  // hashes dropped, and the hash is the whole reason a kept copy can still be
  // matched to the chain.
  assert.ok(after.length >= 1, "--reset-audit left no genesis record");
  const genesis = JSON.parse(readFileSync(join(auditDir, after.sort()[0]), "utf8"));
  const reset = genesis.audit_reset;
  assert.ok(reset, `the genesis carries no audit_reset block: ${JSON.stringify(genesis).slice(0, 300)}`);
  assert.equal(reset.removed_logs, before.length, "the genesis miscounts what it removed");
  assert.equal(reset.removed.length, before.length);
  for (const row of reset.removed) {
    assert.ok(before.includes(row.file), `the genesis names a log that was not there: ${row.file}`);
    assert.match(String(row.sha256), /^[0-9a-f]{64}$/, `no sha256 kept for ${row.file} — a saved copy can no longer be matched`);
  }
  assert.match(r.stdout, /removed /, "the reset did not say what it removed");
  assert.match(r.stdout, /run counter was NOT rolled back/i,
    "the reset must say the counter survived, or a wiped chain looks like a fresh install");
  assert.match(r.stdout, /nothing was scanned/i);
});

test("--report writes a report file with the compare bars in it", () => {
  const home = fakeHome();
  const r = run(home, ["--yes", "--no-pace", "--no-providers", "--report"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const file = reports(home).find((f) => f.startsWith("report-"));
  assert.ok(file, `no report-*.txt written; reports dir holds: ${reports(home).join(", ")}`);
  const body = readFileSync(join(home, ".starreckon", "reports", file), "utf8");
  assert.ok(body.length > 100, `the report is ${body.length} bytes — it is empty, not saved`);
  assert.match(r.stdout, /report saved/i, "the run must say where it put it");
});

test("a default run writes ~/Desktop/starreckon/<date>/ — a write the banner does not disclose", () => {
  // FINDING, pinned. The banner says the run "writes under ~/.starreckon (plus
  // any --join-fleet dir you name)" and PROVE-IT §6 repeats it. Every default
  // (wrapped) run also writes two files to the Desktop, and mkdirSync's
  // recursive:true CREATES ~/Desktop on a machine that has none — so the
  // "missing Desktop is not an error" comment above writeDesktopReport
  // describes a case that cannot happen.
  //
  // Asserted as behaviour, not blessed as correct: whichever way the author
  // resolves it — disclose it, or gate it — this test has to be revisited.
  const home = fakeHome();
  assert.equal(existsSync(join(home, "Desktop")), false, "fixture home must start with no Desktop");
  const r = run(home, ["--yes", "--no-pace", "--no-providers"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const base = join(home, "Desktop", "starreckon");
  assert.ok(existsSync(base), "the default run no longer writes the Desktop snapshot");
  // The author's F3c layout: data/YYYY/YYYY-MM/week-NN/YYYY-MM-DD/, with a
  // snapshots/ folder BESIDE the week folders. Find the day folder by what it
  // holds rather than by walking first-child — the FINDING this test pins is
  // the undisclosed write itself, not the shape of the tree it writes.
  const findReport = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name === "report.txt") return dir;
      if (e.isDirectory()) { const hit = findReport(join(dir, e.name)); if (hit) return hit; }
    }
    return null;
  };
  const folder = findReport(base);
  assert.ok(folder, "no report.txt anywhere under the Desktop tree");
  for (const f of ["report.txt", "star.svg"])
    assert.ok(existsSync(join(folder, f)), `Desktop snapshot is missing ${f}`);
  assert.ok(readFileSync(join(folder, "star.svg"), "utf8").includes("<svg"), "star.svg is not an SVG");
  // The banner as it stands today, quoted so the mismatch is visible in the
  // failure message rather than only in this comment.
  assert.match(r.stdout, /writes under ~\/\.starreckon/);
  assert.ok(
    !r.stdout.includes("Desktop/starreckon") || r.stdout.includes("desktop "),
    "if the banner starts naming the Desktop, update this test and the finding it pins"
  );
});

test("--no-wrapped is what suppresses the Desktop write", () => {
  // Which is why the whole suite missed it: almost every existing CLI test
  // passes --no-wrapped, and the Desktop write lives inside the wrapped block.
  const home = fakeHome();
  assert.equal(run(home, [...SCAN, "--no-snapshot"]).status, 0);
  assert.equal(existsSync(join(home, "Desktop", "starreckon")), false,
    "--no-wrapped must not write the Desktop snapshot");
});

// ── 3. [R] reach out — the contact writer and its delete ────────────────────

test("[R] writes the field you typed into contact.json, and only that field", () => {
  const home = fakeHome();
  // R -> G (github) -> E (edit) -> value -> blank (back to R menu) -> Q
  const r = run(home, [...SCAN, "--no-snapshot"], { input: "R\nG\nE\noctocat\n\nQ\n", interactive: true });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const path = join(home, ".starreckon", "contact.json");
  assert.ok(existsSync(path), "[R] did not write contact.json");
  const doc = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(doc.github, "octocat");
  assert.deepEqual(Object.keys(doc), ["github"], `[R] wrote fields nobody typed: ${JSON.stringify(doc)}`);
  // And the menu shows the new value back, so the reader can see what was kept.
  assert.match(r.stdout, /GitHub\s+octocat/);
});

test("[R] with an empty value saves nothing rather than writing a blank field", () => {
  const home = fakeHome();
  const r = run(home, [...SCAN, "--no-snapshot"], { input: "R\nE\nE\n\n\nQ\n", interactive: true });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /empty — not saved/);
  const path = join(home, ".starreckon", "contact.json");
  if (existsSync(path)) {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    assert.ok(!("email" in doc), `a blank answer wrote an empty email: ${JSON.stringify(doc)}`);
  }
});

test("[R] then [X] Clear ALL DELETES the contact file — not just its fields", () => {
  // The most destructive key in the menu, and the one with no test. It does not
  // empty the object; writeContact(undefined, {}) removes the file.
  const home = fakeHome();
  mkdirSync(join(home, ".starreckon"), { recursive: true });
  const path = join(home, ".starreckon", "contact.json");
  writeFileSync(path, JSON.stringify({ name: "Test Person", github: "octocat", email: "a@b.c" }));

  const r = run(home, [...SCAN, "--no-snapshot"], { input: "R\nX\n\nQ\n", interactive: true });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /all contact info cleared/i);
  assert.equal(existsSync(path), false, "Clear ALL left contact.json on disk");
});

test("[R] field-level [X] clears one field and leaves the rest", () => {
  const home = fakeHome();
  mkdirSync(join(home, ".starreckon"), { recursive: true });
  const path = join(home, ".starreckon", "contact.json");
  writeFileSync(path, JSON.stringify({ github: "octocat", email: "a@b.c" }));
  // R -> G (github) -> X (clear this field) -> blank -> Q
  const r = run(home, [...SCAN, "--no-snapshot"], { input: "R\nG\nX\n\nQ\n", interactive: true });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(!("github" in doc), "the field-level clear did not remove github");
  assert.equal(doc.email, "a@b.c", "the field-level clear took a field it was not asked for");
});

// ── 4. [C] compare — the sub-menu and its save ──────────────────────────────

test("[C] compare is offered only once history exists, and [M][S] writes the report", () => {
  const home = fakeHome();
  // The key is guarded by `timeline.length`, and the timeline is read from the
  // snapshots. --no-snapshot means there are none, so [C] must NOT be offered:
  // a menu key that leads nowhere is its own defect.
  const none = run(home, [...SCAN, "--no-snapshot"], { input: "Q\n", interactive: true });
  assert.equal(none.status, 0, `${none.stdout}${none.stderr}`);
  assert.ok(!/\[C\] compare/.test(none.stdout), "[C] was offered with no history behind it");
  assert.deepEqual(reports(home).filter((f) => f.startsWith("compare-")), []);

  // With snapshots on, [C] appears, and [M] then [S] writes the file.
  const r = run(home, [...SCAN], { input: "C\nM\nS\n\nQ\n", interactive: true });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /\[C\] compare/);
  const file = reports(home).find((f) => f.startsWith("compare-") && f.endsWith("-mine.txt"));
  assert.ok(file, `[S] wrote no compare report; reports dir holds: ${reports(home).join(", ")}`);
  const body = readFileSync(join(home, ".starreckon", "reports", file), "utf8");
  assert.ok(body.length > 100, `the compare report is ${body.length} bytes — the button saved an empty file`);
  assert.match(r.stdout, /saved /, "the save must name the path it wrote");
});

test("[C] with no fleet loaded does not offer [F], and back returns to the main menu", () => {
  const home = fakeHome();
  assert.equal(run(home, [...SCAN], { input: "Q\n", interactive: true }).status, 0);
  const r = run(home, [...SCAN], { input: "C\n\nQ\n", interactive: true });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const sub = r.stdout.slice(r.stdout.indexOf("\ncompare\n"));
  assert.ok(!/\[F\]\s+fleet/.test(sub), "[F] fleet was offered with no --fleet=DIR");
  // Blank = back: the main menu must be rendered again after the sub-menu.
  assert.ok(
    (r.stdout.match(/before you go/g) ?? []).length >= 2,
    "back from the compare sub-menu did not return to the main menu"
  );
  assert.deepEqual(reports(home).filter((f) => f.startsWith("compare-")), [], "backing out wrote a report anyway");
});

// ── 5. [X] copy link, [Z] re-run, [H] help ──────────────────────────────────

test("[X] prints the share URL and carries exactly the contact fields that were opted in", () => {
  // This is the button that puts your details on a clipboard headed for a
  // social platform. What it carries is the whole question, and no test asked.
  const home = fakeHome();
  mkdirSync(join(home, ".starreckon"), { recursive: true });
  writeFileSync(
    join(home, ".starreckon", "contact.json"),
    JSON.stringify({ name: "Test Person", github: "octocat" })
  );
  const r = run(home, [...SCAN, "--no-snapshot"], { input: "X\nQ\n", interactive: true });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const url = (r.stdout.match(/https:\/\/[^\s]*github\.io[^\s]*/) ?? [])[0];
  assert.ok(url, `[X] printed no share URL:\n${r.stdout}`);
  // The results live in the FRAGMENT, which is never sent to any server. A
  // build that moved them into the query string would upload them on every
  // paste, and would still look identical in the terminal.
  const [base, fragment] = url.split("#");
  assert.ok(fragment, "the share URL has no fragment — the results would be sent to the server");
  assert.ok(!base.includes("?"), `the share URL has a query string: ${base}`);
  assert.ok(fragment.includes("n=Test+Person") || fragment.includes("n=Test%20Person"), `name missing from ${fragment}`);
  assert.ok(fragment.includes("gh=octocat"), `github missing from ${fragment}`);
  // Nothing the reader did not opt in to. email/phone were never set here and
  // must not appear from anywhere else.
  for (const key of ["em=", "tel=", "web=", "li=", "tw="])
    assert.ok(!fragment.includes(key), `${key} appeared in the share URL but was never set`);
});

test("[X] reports a failed clipboard copy honestly instead of claiming success", () => {
  // On a machine with no clipboard binary — a container, a headless CI box, an
  // SSH session — the copy cannot happen. Saying it did would be the one thing
  // worse than not copying: the reader pastes stale content and never checks.
  const home = fakeHome();
  const r = run(home, [...SCAN, "--no-snapshot"], {
    input: "X\nQ\n",
    interactive: true,
    // Empty PATH: no pbcopy, no xclip, no wl-copy can be found.
    env: { PATH: "", DISPLAY: "", WAYLAND_DISPLAY: "" },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /clipboard copy failed/i, "a failed copy was not reported");
  assert.match(r.stdout, /tried:/, "the failure must name what it tried");
  assert.match(r.stdout, /copy the URL above manually/i, "the failure must leave the reader a way through");
  assert.ok(!/copied to clipboard/.test(r.stdout), "it claimed a copy that could not have happened");
});

test("[H] prints the full help and STAYS in the menu", () => {
  // A key that printed and then fell through to `done` would end the session
  // on the one press whose entire purpose is to help you choose the next one.
  const home = fakeHome();
  const r = run(home, [...SCAN, "--no-snapshot"], { input: "H\nQ\n", interactive: true });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /SUBCOMMANDS/, "[H] did not print the help");
  assert.match(r.stdout, /OPTIONAL LAYERS/);
  assert.ok(
    (r.stdout.match(/before you go/g) ?? []).length >= 2,
    "[H] printed the help and then left the menu"
  );
});

test("an unrecognised menu key ends the menu rather than looping or throwing", () => {
  const home = fakeHome();
  const r = run(home, [...SCAN, "--no-snapshot"], { input: "?\n", interactive: true });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal((r.stdout.match(/before you go/g) ?? []).length, 1, "an unknown key re-rendered the menu");
  assert.match(r.stdout, /run log:/, "the run did not finish cleanly after an unknown key");
});

test("[Z] re-run spawns a second full scan and its run log lands on disk", () => {
  // The child inherits argv, so it writes its own audit log. Two logs is the
  // fact that proves a second scan really happened — the parent's own output
  // would look the same if [Z] silently did nothing.
  const home = fakeHome();
  const first = run(home, [...SCAN, "--no-snapshot"], { input: "Q\n", interactive: true });
  assert.equal(first.status, 0, first.stderr);
  const before = readdirSync(join(home, ".starreckon", "audit")).length;
  assert.ok(before >= 1, "the first run wrote no audit log");

  // Z re-runs; the child is non-interactive (its stdin is the exhausted pipe),
  // so it completes on its own and the parent returns.
  const r = run(home, [...SCAN, "--no-snapshot"], { input: "Z\n", interactive: true });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  // The parent must wait for the child and then leave. A hang shows up as a
  // killed process, not a failed assertion — worth naming separately, because
  // spawnSync reports it in `signal` and nowhere else. (Taken from Bob's
  // branch; it catches a different failure than the log count below.)
  assert.equal(r.signal, null, "[Z] hung the parent process");
  const after = readdirSync(join(home, ".starreckon", "audit")).length;
  assert.ok(after >= before + 2, `[Z] did not spawn a fresh scan: ${before} audit logs before, ${after} after`);
});

test("[P] prove-it runs all three steps and never claims PASS on a partial result", () => {
  // [P] EXECUTES: a TCP probe outside the sandbox, the same probe inside it, and
  // a confined scan. The outcomes depend on the machine — this box has no
  // sandbox, so steps 2 and 3 come back null and the verdict is INCONCLUSIVE —
  // but the STRUCTURE does not, and neither does the rule connecting the two.
  //
  // So the assertion is the invariant rather than the outcome: all three steps
  // are reported, a verdict is printed, and PASS is printed ONLY when all three
  // conditions actually held. A loosened pass condition fails this on any
  // machine, including one where the proof genuinely passes.
  const home = fakeHome();
  const r = run(home, [...SCAN, "--no-snapshot"], { input: "P\nQ\n", interactive: true });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  for (const step of ["1/3", "2/3", "3/3"])
    assert.ok(r.stdout.includes(step), `[P] did not report step ${step}`);
  assert.match(r.stdout, /control (VALID|INVALID)/, "[P] did not report whether the control was valid");
  assert.match(r.stdout, /\bPASS\b|INCONCLUSIVE/, "[P] printed no verdict");

  if (/\bPASS\b/.test(r.stdout)) {
    assert.match(r.stdout, /control VALID/, "PASS was printed with an invalid control");
    const exits = [...r.stdout.matchAll(/exit (\S+)/g)].map((m) => m[1]);
    assert.ok(exits.length >= 2, "PASS was printed without both exit codes reported");
    for (const e of exits.slice(0, 2))
      assert.equal(e, "0", `PASS was printed while a step exited ${e}`);
  }
  // And it must keep saying this is the weaker form, whichever way it went.
  assert.match(r.stdout, /weaker/i, "[P] stopped marking itself as the weaker proof");
  assert.match(r.stdout, /bin\/starreckon-proof\.sh/, "[P] must point at the strong form");
});

test("--ledger is accepted, and writes nothing when there is nothing it can record", () => {
  // Bob's branch found the shape of this and asserted only that the flag is
  // accepted. The behaviour worth pinning is the one that surprises: --ledger
  // records `providers.perSession`, and the Claude half only when --accounts
  // also ran. On a Claude-only home with --no-providers there is nothing to
  // record, ledgerRecord() returns early, and NO ledger file appears — a run
  // that exits 0 having recorded nothing at all.
  //
  // That is the honest contract, so it is what is asserted. If --ledger ever
  // starts recording the Claude sessions a plain scan already read, this fails
  // and the promise ("transcript deletion cannot lower the lifetime total")
  // gets to be re-read against what the flag does.
  const home = fakeHome();
  const r = run(home, ["--yes", "--no-wrapped", "--no-pace", "--no-snapshot", "--no-providers", "--ledger"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const dir = join(home, ".starreckon");
  const ledgerFiles = readdirSync(dir).filter((f) => /ledger/i.test(f));
  assert.deepEqual(
    ledgerFiles,
    [],
    `--ledger now writes ${ledgerFiles.join(", ")} for a Claude-only scan — the contract changed; assert what it records`
  );
});

// ── 6. POST /submit under --serve-collect ───────────────────────────────────

test("POST /submit OVERWRITES an existing machine folder with no existence check", async () => {
  // FINDING, pinned. --serve-collect accepts submissions from other machines on
  // the LAN and hands each one to writeMachineFolder(), which validates the
  // NAME (no slashes, no dot-prefix, not a reserved word) and then writes. It
  // never asks whether that folder already exists. Two machines that pick the
  // same hostname — or one machine submitting twice — and the second silently
  // replaces the first's numbers, with a 200 and an "✓ submitted" line.
  //
  // Asserted through makeHandler directly: no socket is opened, and the writer
  // is the same one the LAN path calls.
  const { makeHandler } = await import("../src/serve.mjs");
  const dir = join(mkdtempSync(join(tmpdir(), "sf-collect-")), "fleet");
  const post = (handler, payload) =>
    new Promise((resolve) => {
      const res = {
        writeHead(status) { this._status = status; },
        end(body) { resolve({ status: this._status, body }); },
      };
      const listeners = {};
      handler(
        { method: "POST", url: "/submit", socket: { remoteAddress: "10.0.0.9" }, on: (e, f) => { listeners[e] = f; } },
        res
      );
      listeners.data(JSON.stringify(payload));
      listeners.end();
    });

  const handler = makeHandler("<html></html>", 99, dir).handler;
  // The shape writeMachineFolder validates: per-account totals, and a by_model
  // split that sums to them exactly.
  const four = (n) => ({ input_tokens: n, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  const acct = (total) => ({
    account: "a@b.c",
    sessions: 1,
    totals: four(total),
    by_model: { "claude-opus-4": four(total) },
  });

  const first = await post(handler, { folderName: "laptop", accounts: [acct(1000)] });
  assert.equal(first.status, 200, first.body);
  const totalsPath = join(dir, "laptop", "machine-readable", "totals.json");
  assert.ok(existsSync(totalsPath), `first submission wrote nothing; dir holds ${readdirSync(dir).join(", ")}`);
  assert.equal(JSON.parse(readFileSync(totalsPath, "utf8")).grand_total_tokens, 1000);

  // The same folder name, from a different machine, with different numbers.
  const second = await post(handler, { folderName: "laptop", accounts: [acct(7)] });
  assert.equal(second.status, 200, `the second submission was refused — the overwrite has been fixed: ${second.body}`);
  assert.equal(
    JSON.parse(readFileSync(totalsPath, "utf8")).grand_total_tokens,
    7,
    "the second submission did not overwrite — a guard now exists; replace this test with an assertion of what it does"
  );
  // And the response says nothing about having replaced anything.
  assert.ok(
    !/overwrote|replaced|already exists/i.test(second.body),
    "the response now warns about the overwrite — update this test"
  );

  // The asymmetry that shows this is an oversight rather than a policy:
  // writeMachineFolder guards human-readable/REPORT.md with an existsSync check
  // ("so a real report is never clobbered", src/fleet.mjs) while the three
  // machine-readable files it writes beside it carry no such guard. The
  // protected file is prose; the clobbered ones are the numbers.
  const report = readFileSync(join(dir, "laptop", "human-readable", "REPORT.md"), "utf8");
  assert.ok(
    report.includes("1,000"),
    "REPORT.md was clobbered too — the one guard that existed is gone; update this finding"
  );
});

test("POST /submit never lets a submitted name escape the collect dir", async () => {
  // The guard that DOES exist, and the one that matters most: the folder name
  // arrives from another machine on the LAN and is used as a path segment.
  //
  // It SANITISES rather than refuses — "../escape" is accepted as "escape" —
  // so the assertion is not "it says no", it is "whatever it says, the write
  // lands inside collectDir and nowhere else". Traversal and dot-files are the
  // two ways out of a directory, and both are checked by the filesystem.
  const { makeHandler } = await import("../src/serve.mjs");
  const parent = mkdtempSync(join(tmpdir(), "sf-collect-"));
  const dir = join(parent, "fleet");
  const handler = makeHandler("<html></html>", 99, dir).handler;
  const post = (payload) =>
    new Promise((resolve) => {
      const res = { writeHead(s) { this._s = s; }, end(b) { resolve({ status: this._s, body: b }); } };
      const l = {};
      handler({ method: "POST", url: "/submit", socket: { remoteAddress: "10.0.0.9" }, on: (e, f) => { l[e] = f; } }, res);
      l.data(JSON.stringify(payload));
      l.end();
    });

  for (const bad of ["../escape", "a/b/c", "..", "....//....//etc", "  ", "-", " null"]) {
    const r = await post({ folderName: bad, accounts: [] });
    if (r.status === 200) {
      const folder = JSON.parse(r.body).folder;
      // The sanitiser's own contract, asserted as a whole rather than as a list
      // of the characters someone remembered to exclude. writeMachineFolder
      // refuses separators and dot-prefixes on its own, so checking only those
      // would pass with the sanitiser deleted — a whitespace or unicode name
      // would sail through the deeper guard and become a real directory.
      assert.match(folder ?? "", /^[a-z0-9_-]+$/,
        `an accepted folder name is outside the sanitiser's contract: ${JSON.stringify(folder)}`);
      assert.ok(existsSync(join(dir, folder, "machine-readable", "totals.json")),
        `accepted ${JSON.stringify(bad)} as ${folder} but wrote nothing there`);
    }
  }
  // The decisive check: the collect dir's PARENT gained nothing. A traversal
  // that worked would show up here and nowhere else.
  assert.deepEqual(readdirSync(parent), ["fleet"], "a submitted name wrote outside the collect dir");
  // Empty and non-string names are refused outright — there is nothing to
  // sanitise them into.
  for (const bad of ["", null, 42, { a: 1 }]) {
    const r = await post({ folderName: bad, accounts: [] });
    assert.equal(r.status, 400, `folderName ${JSON.stringify(bad)} was accepted: ${r.body}`);
  }
  // …and a reserved fleet directory name is refused by writeMachineFolder even
  // though it sanitises cleanly, so a submission cannot overwrite the fleet's
  // own bookkeeping directories.
  const reserved = await post({ folderName: "archive", accounts: [] });
  assert.equal(reserved.status, 400, `a reserved fleet dir name was accepted: ${reserved.body}`);
});
