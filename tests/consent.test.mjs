// The consent screen for the optional layers.
//
// What these tests hold down, and why each one exists:
//
//   1. The screen says all four required things — WHAT is about to happen named
//      for the door, THAT A LOG FILE WILL BE SAVED, WHERE it runs and writes,
//      and that it is NOT required. The log sentence is checked on EVERY door
//      INCLUDING daemon-only, because that is the one an earlier draft dropped:
//      a layer that writes a record without saying so is the opposite of this
//      program's claim.
//   2. EXACTLY TWO answers. A third option ("do not agree") was struck by the
//      author as invented — declining an optional layer IS using without it —
//      so its reappearance has to fail a test, not a review.
//   3. The FLAG and the BUTTON reach the IDENTICAL screen. Not "two texts that
//      match today": the screen bytes from `--with-daemon` are compared against
//      the screen bytes from pressing [D], character for character.
//   4. Neither answer is a dead end — the scan runs after both.
//   5. NON-TTY does not hang and does not assume consent. This is the one that
//      matters most in a script or a CI job: passing the flag is a request to be
//      asked, not an answer. The proof is behavioural, not textual — after a
//      non-TTY `--with-daemon` there must be NO schedule files on disk.
//   6. The third door does BOTH in ONE press. One screen, one answer, two
//      layers — asserted by the files that appear, not by the label.
//
// Nothing here downloads anything. The models door is exercised with a
// pre-created ~/.starreckon/.venv-search so the agree path takes the
// "already installed" branch and spawns nothing: a test suite that can start a
// 600 MB download is a test suite nobody runs twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOORS,
  DOOR_KEYS,
  consentScreen,
  parseConsent,
  withoutLine,
  nonTtyNotice,
  LOG_DIR_SHAPE,
} from "../src/consent.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "src", "cli.mjs");

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "sf-consent-"));
  const proj = join(home, ".claude", "projects", "demo");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "session.jsonl"),
    JSON.stringify({ type: "user", timestamp: "2026-08-01T10:00:00.000Z", uuid: "u1" }) + "\n"
  );
  return home;
}

// Pretend the models are already there, so the agree path prints "already
// installed" and never spawns python. See the header note.
function preinstallModels(home) {
  const bin = join(home, ".starreckon", ".venv-search", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "python"), "");
  return home;
}

const SCAN_ARGS = ["--yes", "--no-wrapped", "--no-pace", "--no-snapshot", "--no-providers"];

// A 30s timeout is itself part of test 5: a prompt with nobody to answer it
// would hang here, and spawnSync would report a killed process instead of 0.
const run = (home, argv, { input = "", interactive = false, env = {} } = {}) =>
  spawnSync(process.execPath, [CLI, ...argv], {
    input,
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: "1",
      ...(interactive ? { STARRECKON_FORCE_INTERACTIVE: "1" } : {}),
      // last, so the NO_COLOR inverse case below can switch colour back ON.
      ...env,
    },
  });

// The schedule files the daemon door writes. Checked by EXISTENCE, because the
// question "was consent assumed?" is answered by the filesystem, never by what
// the transcript claims happened.
const scheduleFiles = (home) => {
  const dirs = [
    join(home, ".config", "systemd", "user"), // linux
    join(home, "Library", "LaunchAgents"), // macOS
  ];
  const out = [];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (f.includes("starreckon")) out.push(join(d, f));
  }
  return out;
};

// The screen, sliced out of a CLI transcript. Both ends are content the screen
// itself must contain, so a slice that comes back empty is already a failure.
function screenFrom(stdout, doorKey) {
  const start = stdout.indexOf(`── ${DOORS[doorKey].heading}`);
  const endMark = "use without    carry on WITHOUT this layer — the scan still runs";
  const end = stdout.indexOf(endMark, start);
  assert.ok(start !== -1, `the ${doorKey} consent screen never appeared:\n${stdout}`);
  assert.ok(end !== -1, `the ${doorKey} screen has no answer list:\n${stdout}`);
  return stdout.slice(start, end + endMark.length);
}

// ---- 1. what the screen must say, on every door -----------------------------

for (const doorKey of DOOR_KEYS) {
  test(`the ${doorKey} consent screen states what happens, the log, where, and that it is optional`, () => {
    const s = consentScreen(doorKey, { color: false });

    // (1) WHAT is about to happen, NAMED FOR THIS DOOR.
    assert.match(s, /what happens next/, "no statement of what happens");
    if (doorKey === "models" || doorKey === "both")
      assert.match(s, /DOWNLOAD the Cisco SecureBERT models/, "the models door must name the download");
    if (doorKey === "daemon" || doorKey === "both")
      assert.match(s, /WRITE THE SCHEDULE FILES/, "the daemon door must name the schedule files");

    // (2) THAT A LOG FILE WILL BE SAVED — every door, daemon-only included.
    assert.match(s, /a log file will be saved/, `${doorKey}: the log promise is missing`);
    assert.ok(s.includes(LOG_DIR_SHAPE), `${doorKey}: the log location is not named`);

    // (3) WHERE it runs and writes: locally, in THIS machine's folder.
    assert.match(s, /locally, on this machine, into this machine's own folder/, `${doorKey}: no "where"`);

    // (4) not required, and skipping breaks nothing.
    assert.match(s, /it is not required/, `${doorKey}: never says it is optional`);
    assert.match(s, /skipping it does not make anything else wrong/, `${doorKey}: no "skipping is fine"`);
  });
}

test("the daemon-only door promises a log too — the case an earlier draft dropped", () => {
  // Deliberately narrower than the loop above: the spec calls this one out by
  // name ("including when only the daemon is turned on"), so it gets a test
  // that names it too and cannot be deleted as a duplicate by accident.
  const s = consentScreen("daemon", { color: false });
  assert.match(s, /a log file will be saved/);
  assert.ok(!/DOWNLOAD/.test(s), "the daemon-only door must not talk about a download");
});

test("the third door is ONE screen naming BOTH layers, not two screens", () => {
  const s = consentScreen("both", { color: false });
  assert.match(s, /DOWNLOAD the Cisco SecureBERT models/);
  assert.match(s, /WRITE THE SCHEDULE FILES/);
  // One answer list, not two.
  assert.equal((s.match(/^\s+agree\s/gm) ?? []).length, 1, "more than one answer list on one screen");
});

// ---- 2. exactly two answers -------------------------------------------------

for (const doorKey of DOOR_KEYS) {
  test(`the ${doorKey} screen offers EXACTLY two answers — agree and use without`, () => {
    const s = consentScreen(doorKey, { color: false });
    assert.match(s, /^\s+agree\s{2,}/m, "no `agree` answer");
    assert.match(s, /^\s+use without\s{2,}/m, "no `use without` answer");
    // The struck third option, in the spellings it would come back as.
    assert.ok(!/do not agree/i.test(s), '"do not agree" is the invented third answer — it was struck');
    assert.ok(!/\bdecline\b/i.test(s), '"decline" is the third answer wearing another label');
    assert.ok(!/\[y\/n\]|\(y\/n\)/i.test(s), "y/n is a different question with a different meaning");
    // Count the answer lines: two, and only two.
    const answers = s.split("\n").filter((l) => /^\s{2}(agree|use without)\s{2,}\S/.test(l));
    assert.equal(answers.length, 2, `expected 2 answer lines, got ${answers.length}: ${answers.join(" | ")}`);
  });
}

test("parseConsent classifies exactly two answers and refuses to guess at a third", () => {
  for (const yes of ["agree", "AGREE", " agree ", "a"]) assert.equal(parseConsent(yes), "agree", yes);
  for (const no of ["use without", "USE  WITHOUT", "without", "w", "", "   "])
    assert.equal(parseConsent(no), "without", JSON.stringify(no));
  // "y"/"yes" is NOT agreement here. The screen never offered it, and reading a
  // yes into a question that was never asked as yes/no is how consent gets
  // manufactured out of a keystroke meant for a different prompt.
  for (const unknown of ["y", "yes", "no", "do not agree", "maybe", "1"])
    assert.equal(parseConsent(unknown), null, unknown);
  assert.equal(parseConsent(undefined), "without", "no input at all is not consent");
});

test("the blank default is the answer that turns NOTHING on", () => {
  assert.equal(parseConsent(""), "without");
});

// ---- 3. the flag and the button are the same door ---------------------------

test("the --with-daemon flag and the [D] button print the IDENTICAL screen", () => {
  const viaFlag = run(fakeHome(), ["--with-daemon", ...SCAN_ARGS], {
    input: "use without\n",
    interactive: true,
  });
  const viaButton = run(fakeHome(), SCAN_ARGS, { input: "D\nuse without\nQ\n", interactive: true });
  assert.equal(viaFlag.status, 0, viaFlag.stderr);
  assert.equal(viaButton.status, 0, viaButton.stderr);
  assert.equal(
    screenFrom(viaFlag.stdout, "daemon"),
    screenFrom(viaButton.stdout, "daemon"),
    "the flag and the button show different screens — they must be one door"
  );
});

test("the --with-models flag and the [I] button print the IDENTICAL screen", () => {
  // NOT preinstalled, deliberately. A door whose only layer is already on has
  // nothing to consent to and shows the nothing-to-start notice instead of a
  // screen, so preinstalling here would compare two notices and prove nothing
  // about the screen. The answer is "use without", so nothing downloads.
  const viaFlag = run(fakeHome(), ["--with-models", ...SCAN_ARGS], {
    input: "use without\n",
    interactive: true,
  });
  const viaButton = run(fakeHome(), SCAN_ARGS, {
    input: "I\nuse without\nQ\n",
    interactive: true,
  });
  assert.equal(viaFlag.status, 0, viaFlag.stderr);
  assert.equal(viaButton.status, 0, viaButton.stderr);
  assert.equal(screenFrom(viaFlag.stdout, "models"), screenFrom(viaButton.stdout, "models"));
});

test("the --with-both flag and the [A] button print the IDENTICAL screen", () => {
  const viaFlag = run(preinstallModels(fakeHome()), ["--with-both", ...SCAN_ARGS], {
    input: "use without\n",
    interactive: true,
  });
  const viaButton = run(preinstallModels(fakeHome()), SCAN_ARGS, {
    input: "A\nuse without\nQ\n",
    interactive: true,
  });
  assert.equal(viaFlag.status, 0, viaFlag.stderr);
  assert.equal(viaButton.status, 0, viaButton.stderr);
  assert.equal(screenFrom(viaFlag.stdout, "both"), screenFrom(viaButton.stdout, "both"));
});

test("--with-models --with-daemon together is the ONE both-door, asked once", () => {
  const r = run(preinstallModels(fakeHome()), ["--with-models", "--with-daemon", ...SCAN_ARGS], {
    input: "use without\n",
    interactive: true,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    (r.stdout.match(/── optional layer/g) ?? []).length,
    1,
    "two flags asked two questions — the same reader should be asked once"
  );
  assert.ok(r.stdout.includes(DOORS.both.heading), "two flags did not resolve to the both-door");
});

// ---- 4. the screen comes BEFORE anything happens, and both answers scan -----

test("[D] agree: the screen is printed BEFORE a single schedule file is written", () => {
  const home = fakeHome();
  const r = run(home, SCAN_ARGS, { input: "D\nagree\nQ\n", interactive: true });
  assert.equal(r.status, 0, r.stderr);
  const promise = r.stdout.indexOf("a log file will be saved");
  const wrote = r.stdout.indexOf("wrote ");
  assert.ok(promise !== -1, "no consent screen");
  assert.ok(wrote !== -1, `agree wrote nothing:\n${r.stdout}`);
  assert.ok(promise < wrote, "the schedule was written before the screen was shown");
  assert.ok(scheduleFiles(home).length > 0, "agree left no schedule files on disk");
  // The precedent sentence stays exactly as it was.
  assert.match(r.stdout, /this tool does not load it for you\./);
});

test("[D] use without: nothing is written, and the scan still runs", () => {
  const home = fakeHome();
  const r = run(home, SCAN_ARGS, { input: "D\nuse without\nQ\n", interactive: true });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(scheduleFiles(home), [], "`use without` scheduled something anyway");
  assert.match(r.stdout, /using starreckon WITHOUT the daemon layer/);
  assert.match(r.stdout, /before you go/, "the menu did not survive the answer");
});

test("either answer leaves the scan running — neither is a dead end", () => {
  for (const answer of ["agree", "use without"]) {
    const home = preinstallModels(fakeHome());
    const r = run(home, ["--with-models", ...SCAN_ARGS], { input: `${answer}\n`, interactive: true });
    assert.equal(r.status, 0, `${answer}: ${r.stderr}`);
    assert.match(r.stdout, /Found: claude_code/, `${answer}: the scan did not run`);
    assert.ok(
      existsSync(join(home, ".starreckon", "audit")),
      `${answer}: the run left no audit log, so the scan did not complete`
    );
  }
});

// ---- 5. non-TTY: no hang, no assumed consent --------------------------------

test("non-TTY --with-daemon does not hang, does not consent, and says so on stderr", () => {
  const home = fakeHome();
  const r = run(home, ["--with-daemon", ...SCAN_ARGS]); // no forced-interactive, no input
  // A hang would come back as a killed process, not status 0.
  assert.equal(r.signal, null, "the process had to be killed — the prompt hung with nobody to answer it");
  assert.equal(r.status, 0, r.stderr);
  // Not assumed: the filesystem is the witness, not the transcript.
  assert.deepEqual(scheduleFiles(home), [], "no terminal to ask on, and it scheduled a job anyway");
  // Said out loud, on stderr.
  assert.match(r.stderr, /no terminal to ask on/, `stderr was silent:\n${r.stderr}`);
  assert.match(r.stderr, /use without/, "stderr does not name the answer it defaulted to");
  // The screen is still printed, so a piped log records what was offered.
  assert.ok(r.stdout.includes(DOORS.daemon.heading), "the screen was skipped entirely");
  // And the scan still ran.
  assert.match(r.stdout, /Found: claude_code/);
});

test("non-TTY --with-models does not download and does not create the venv", () => {
  const home = fakeHome();
  const r = run(home, ["--with-models", ...SCAN_ARGS]);
  assert.equal(r.signal, null, "hung with nobody to answer");
  assert.equal(r.status, 0, r.stderr);
  assert.ok(
    !existsSync(join(home, ".starreckon", ".venv-search")),
    "no terminal to ask on, and it started the download anyway"
  );
  assert.match(r.stderr, /no terminal to ask on/);
});

test("non-TTY --with-both defaults both layers to `use without`", () => {
  const home = fakeHome();
  const r = run(home, ["--with-both", ...SCAN_ARGS]);
  assert.equal(r.signal, null);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(scheduleFiles(home), []);
  assert.ok(!existsSync(join(home, ".starreckon", ".venv-search")));
  assert.match(r.stderr, /no terminal to ask on/);
  assert.match(r.stderr, /were NOT turned on/);
});

// ---- 6. the third door is ONE press ----------------------------------------

test("[A] with one `agree` accounts for BOTH layers — not two presses", () => {
  // The models are preinstalled so this test can never start a 600 MB download
  // — which means [A] here has exactly one layer left to RUN. That is the point
  // the assertions moved to: one press and one answer must still ACCOUNT for
  // both layers. The daemon half really happens; the models half is named on
  // the screen as already present, rather than silently dropped, because a
  // reader of "all extras" who sees only the daemon would be entitled to think
  // the models were forgotten.
  const home = preinstallModels(fakeHome());
  const r = run(home, SCAN_ARGS, { input: "A\nagree\nQ\n", interactive: true });
  assert.equal(r.status, 0, r.stderr);
  // exactly one question was asked
  assert.equal((r.stdout.match(/── optional layer/g) ?? []).length, 1, "the both-door asked twice");
  // the layer that had work to do actually did it
  assert.ok(scheduleFiles(home).length > 0, "[A] did not turn on the daemon layer");
  // the layer that had none is accounted for out loud, and NOT promised
  assert.match(r.stdout, /ALREADY INSTALLED/, "[A] said nothing about the models layer at all");
  const screen = r.stdout.slice(r.stdout.indexOf("── optional layer"));
  const promise = screen.slice(0, screen.indexOf("use without"));
  assert.ok(!/DOWNLOAD/.test(promise), "[A] promised a download to a machine that already has the models");
});

test("[A] sits at the same menu level as [D] and [I]", () => {
  const home = fakeHome();
  const r = run(home, SCAN_ARGS, { input: "Q\n", interactive: true });
  assert.equal(r.status, 0, r.stderr);
  const menu = r.stdout.slice(r.stdout.lastIndexOf("before you go"));
  for (const k of ["[D]", "[I]", "[A]"]) assert.ok(menu.includes(k), `menu is missing ${k}`);
  assert.match(menu, /\[A\] all extras/);
});

// ---- 7. the wording that carries the promise --------------------------------

test("the without-line and the non-TTY notice both state that nothing happened", () => {
  for (const doorKey of DOOR_KEYS) {
    assert.match(withoutLine(doorKey), /nothing was downloaded and nothing was scheduled/);
    assert.match(withoutLine(doorKey), /the scan runs/);
    assert.match(nonTtyNotice(doorKey), /no terminal to ask on/);
    assert.match(nonTtyNotice(doorKey), /use without/);
    assert.match(nonTtyNotice(doorKey), /the scan continues/);
  }
});

test("an unknown door is an error, never a blank screen", () => {
  // A door name typo that rendered an empty screen would ask for consent to
  // nothing and then do something — the exact failure this file exists to stop.
  assert.throws(() => consentScreen("nope"), /unknown door/);
  assert.throws(() => withoutLine("nope"), /unknown door/);
  assert.throws(() => nonTtyNotice("nope"), /unknown door/);
});

// ---- 8. NO_COLOR, and the one screen ---------------------------------------
//
// The four tests below were added after the ones above were MUTATION-TESTED.
// Six deliberate breakages were introduced one at a time to find out which of
// the tests above were load-bearing and which only looked it. Four were caught.
// TWO SURVIVED, and these tests are those two holes:
//
//   · a hardcoded \x1b[1m inside consentScreen — invisible to every test in this
//     file (they all read the screen with NO_COLOR set but never assert on
//     escapes) and invisible to nocolor.test.mjs too, because that file's run
//     never passes a --with-* flag or presses a button, so the consent screen
//     is not on its path. Colour leaking into a redirected file is not a
//     cosmetic bug here: every capture for the submission folder had to be
//     piped through sed the last time this happened.
//   · an extra hand-written paragraph printed by a BUTTON just before the
//     screen. `screenFrom` slices between two markers the screen itself owns,
//     so anything printed OUTSIDE that slice is invisible to the identical-
//     screen tests — they prove the screen matches, not that it is the only
//     thing said. A second description of the same layer is exactly how the
//     two texts start to disagree, which is the drift those tests exist to stop.

const ESC = /\x1b\[/;

test("NO_COLOR: the screen and every line around it emit not one escape", () => {
  // Unit-level: the renderer with colour off, plus the three strings openDoor
  // prints around it. A screen that is clean while the sentence after it is not
  // still produces an unreadable redirected file.
  for (const doorKey of DOOR_KEYS) {
    assert.doesNotMatch(consentScreen(doorKey, { color: false }), ESC, `${doorKey}: screen carries colour`);
    assert.doesNotMatch(withoutLine(doorKey), ESC, `${doorKey}: withoutLine carries colour`);
    assert.doesNotMatch(nonTtyNotice(doorKey), ESC, `${doorKey}: nonTtyNotice carries colour`);
  }
});

test("NO_COLOR: a whole run through a consent door is plain, on stdout AND stderr", () => {
  // End-to-end, because the unit test above passes happily while cli.mjs
  // wraps the screen in its own BOLD/DIM. stderr is checked too: the non-TTY
  // notice is the one line of this feature that goes there, and it is the line
  // most likely to end up in a CI log that renders escapes literally.
  const r = run(fakeHome(), ["--with-both", ...SCAN_ARGS], { env: { NO_COLOR: "1" } });
  assert.equal(r.status, 0, r.stderr);
  const badOut = r.stdout.split("\n").filter((l) => ESC.test(l));
  assert.deepEqual(badOut.slice(0, 3), [], `${badOut.length} stdout line(s) carry colour: ${JSON.stringify(badOut[0])}`);
  assert.doesNotMatch(r.stderr, ESC, "the non-TTY notice carries colour under NO_COLOR");
  // and the screen was actually on this run's path, or the check proved nothing
  assert.ok(r.stdout.includes(DOORS.both.heading), "the consent screen never rendered — this test checked nothing");
});


// Everything printed between the keypress and the question, byte for byte.
// Both ends are written by ask(): it prints the prompt "  > ", then echoes the
// line it dequeued. So the region after "  > I\n" and before the next "  > " is
// exactly what the button chose to say before asking.
function betweenPressAndQuestion(stdout, keyLetter) {
  const press = `  > ${keyLetter}\n`;
  const i = stdout.indexOf(press);
  assert.ok(i !== -1, `the [${keyLetter}] keypress never appeared in the transcript`);
  const rest = stdout.slice(i + press.length);
  const j = rest.indexOf("  > ");
  assert.ok(j !== -1, `[${keyLetter}] never asked a question after the press`);
  return rest.slice(0, j);
}

for (const [keyLetter, doorKey] of [
  ["D", "daemon"],
  ["I", "models"],
  ["A", "both"],
]) {
  test(`[${keyLetter}] says the screen and NOTHING ELSE between the press and the question`, () => {
    // A machine where BOTH layers are still startable, so all three doors
    // render their full canonical screen. Preinstalling the models would send
    // [I] to the nothing-to-start notice and shrink [A] to its daemon half —
    // both correct, and both a different string than the one asserted here.
    // Safe without the preinstall because the answer is "use without".
    const home = fakeHome();
    const r = run(home, SCAN_ARGS, { input: `${keyLetter}\nuse without\nQ\n`, interactive: true });
    assert.equal(r.status, 0, r.stderr);
    // console.log adds the trailing newline the renderer does not.
    assert.equal(
      betweenPressAndQuestion(r.stdout, keyLetter),
      consentScreen(doorKey, { color: false }) + "\n",
      `[${keyLetter}] printed something other than the one canonical screen before asking`
    );
  });
}

test("without NO_COLOR the consent screen is still coloured", () => {
  // The inverse, so the cheap fix for the two NO_COLOR tests above — hardcoding
  // `color: false` at the call site — cannot pass.
  //
  // The first version of this test asserted "some escape appears within 2000
  // chars of the heading" and it PASSED against exactly the mutation it was
  // written to catch: the line openDoor prints AFTER the screen is coloured
  // too, and it fell inside the window. A window heuristic on a byte range
  // nobody owns proves nothing. This compares the whole screen, byte for byte,
  // against the coloured rendering — the same shape as the drift test, and the
  // only version of this check that fails when the screen goes plain.
  const home = fakeHome();
  const r = run(home, SCAN_ARGS, {
    input: "D\nuse without\nQ\n",
    interactive: true,
    env: { NO_COLOR: "", FORCE_COLOR: "1" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    betweenPressAndQuestion(r.stdout, "D"),
    consentScreen("daemon", { color: true }) + "\n",
    "the screen rendered without colour even though NO_COLOR was not set"
  );
});

// ---- 9. the log promise is a promise, and says so ---------------------------

test("the log sentence is a COMMITMENT, not a claim that it already happens", () => {
  // NOTHING WRITES A LOG YET — see the closing note in src/consent.mjs for the
  // three things that must land first. Until they do, the tense is the whole
  // difference between a promise and a false statement of fact: "every run of
  // this layer writes one" is not true of any run that exists today, and it is
  // read by the user BEFORE they answer. "will write one" is a commitment that
  // is not yet kept, which is what this actually is.
  //
  // DELETE THIS TEST when the writer ships. At that point present tense becomes
  // the true wording and this test becomes the thing standing in its way — that
  // is deliberate, so the wording cannot quietly go back to claiming a log
  // exists while nothing writes one.
  for (const doorKey of DOOR_KEYS) {
    const s = consentScreen(doorKey, { color: false });
    assert.match(s, /will write one/, `${doorKey}: the log sentence is not phrased as a commitment`);
    assert.ok(
      !/\blayer writes one\b/.test(s),
      `${doorKey}: the screen claims a log is written today; nothing writes one yet`
    );
  }
});
