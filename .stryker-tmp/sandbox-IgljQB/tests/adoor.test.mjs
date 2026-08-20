// @ts-nocheck
// The [A] door tells the truth about which layers it will actually start.
//
// THE DEFECT THIS FILE EXISTS FOR
//
// [D] hid itself when the daemon was unsupported or already installed. [A] —
// "models AND daemon in ONE press" — printed unconditionally and its consent
// screen announced the schedule files on every platform. On a machine with no
// schedule format the reader was shown "about to WRITE THE SCHEDULE FILES",
// answered "agree", and nothing was written. A consent screen exists so that
// nothing optional starts without saying truthfully what will happen; a screen
// that announces work it cannot do is the exact failure it was built to prevent.
//
// The same shape was live on [I] and on --with-models: the screen quoted a
// ~600 MB download to a reader whose models were already on disk.
//
// WHY THE RULE IS TESTED AS A PURE FUNCTION
//
// The unsupported-platform case cannot be reached end-to-end on a machine that
// IS supported, and inventing an env var that lies to the CLI about its own
// platform would be a production footgun shipped for a test's convenience. So
// the decision — which doors are offered, and what a door promises — is a pure
// function of measured layer states, and every state is exercised directly.
// The states themselves are measured in cli.mjs (existsSync + daemonStatus) and
// the already-installed half IS covered end-to-end below, because that state is
// one `daemon on` away on any supported platform.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { consentScreen, doorPlan, offeredDoors, nothingToStartNotice } from "../src/consent.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "src", "cli.mjs");

const SCAN_ARGS = ["--yes", "--no-wrapped", "--no-pace", "--no-snapshot", "--no-providers"];

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "sf-adoor-"));
  const proj = join(home, ".claude", "projects", "demo");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "session.jsonl"),
    JSON.stringify({ type: "user", timestamp: "2026-08-01T10:00:00.000Z", uuid: "u1" }) + "\n"
  );
  return home;
}

// Models "already there", so no path through this file can start a 600 MB
// download. Same device the consent suite uses, for the same reason.
function preinstallModels(home) {
  const bin = join(home, ".starreckon", ".venv-search", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "python"), "");
  return home;
}

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
      ...env,
    },
  });

// Install the daemon the way a user would — through the CLI's own subcommand —
// so "already installed" is the real state daemonStatus() reads, not a guess at
// which files it looks for.
function installDaemon(home) {
  const r = run(home, ["daemon", "on"]);
  assert.equal(r.status, 0, `daemon on failed: ${r.stdout}${r.stderr}`);
  return home;
}

const scheduleFiles = (home) => {
  const out = [];
  for (const d of [join(home, ".config", "systemd", "user"), join(home, "Library", "LaunchAgents")]) {
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (f.includes("starreckon")) out.push(join(d, f));
  }
  return out;
};

const menuOf = (stdout) => stdout.slice(stdout.lastIndexOf("before you go"));
const supported = () => platform() === "darwin" || platform() === "linux";

// ---- 1. the screen never promises a layer it cannot start -------------------

test("the both-door does not promise the schedule files when the platform has none", () => {
  const s = consentScreen("both", { color: false, layers: { models: "ready", daemon: "unsupported" } });
  assert.ok(
    !/WRITE THE SCHEDULE FILES/.test(s),
    "the screen announced schedule files on a platform that has no schedule format"
  );
  // and it does not simply go silent about the daemon — silence would leave a
  // reader of "all extras" believing both layers were coming.
  assert.match(s, /no schedule format/i, "the screen dropped the daemon without saying why");
  // the half that IS available must still be promised in full
  assert.match(s, /DOWNLOAD the Cisco SecureBERT models/, "the models half went missing too");
});

test("the both-door does not promise a download when the models are already on disk", () => {
  const s = consentScreen("both", { color: false, layers: { models: "installed", daemon: "ready" } });
  assert.ok(!/DOWNLOAD/.test(s), "the screen quoted a download to a reader who already has the models");
  assert.match(s, /already installed/i, "the screen dropped the models without saying why");
  assert.match(s, /WRITE THE SCHEDULE FILES/, "the daemon half went missing");
});

test("the models door does not quote ~600 MB when nothing will be downloaded", () => {
  // A single-layer door whose layer is already on has nothing to consent to, so
  // it must not render a screen at all — asking would be asking about a
  // download that cannot happen. Rendering one is a programming error here,
  // caught loudly rather than shown to a reader.
  const layers = { models: "installed", daemon: "ready" };
  assert.throws(
    () => consentScreen("models", { color: false, layers }),
    /nothing to start/,
    "rendered a consent screen for a door with no work in it"
  );
  const notice = nothingToStartNotice("models", layers);
  assert.ok(!/600 MB/.test(notice), "a reader with the models on disk was quoted the download size");
  assert.match(notice, /already installed/i, "the notice does not say why nothing will happen");
});

test("with every layer available the screen is EXACTLY the unconditioned screen", () => {
  // The conditioning must be invisible on the machine the text was written for,
  // or every existing byte-for-byte screen test is asserting a second wording.
  for (const doorKey of ["models", "daemon", "both"]) {
    assert.equal(
      consentScreen(doorKey, { color: false, layers: { models: "ready", daemon: "ready" } }),
      consentScreen(doorKey, { color: false }),
      `${doorKey}: an all-ready machine renders something other than the canonical screen`
    );
  }
});

test("a door with nothing left to start asks no question at all", () => {
  // Consent to do nothing is theatre: a reader who answers "agree" and watches
  // nothing happen has learnt the screen is decorative.
  const plan = doorPlan("both", { models: "installed", daemon: "installed" });
  assert.equal(plan.start.length, 0, "something was still queued to run");
  const notice = nothingToStartNotice("both", { models: "installed", daemon: "installed" });
  assert.match(notice, /already/i, "the notice does not say the layers are already on");
  assert.ok(!/agree/.test(notice), "it still offered an answer to a question it should not ask");
});

// ---- 2. which doors the menu offers -----------------------------------------

test("[A] is offered only when it actually combines two startable layers", () => {
  const O = (models, daemon) => offeredDoors({ models, daemon });

  // the machine the door was designed for: both layers real, both startable
  assert.equal(O("ready", "ready").both, true, "[A] hidden on the machine it exists for");

  // one layer unavailable or already done -> "all extras" saves no press, and
  // the single-layer door is visible and does the same thing honestly
  assert.equal(O("ready", "unsupported").both, false, "[A] offered the daemon on a platform without one");
  assert.equal(O("ready", "installed").both, false, "[A] offered to re-do an installed daemon");
  assert.equal(O("installed", "ready").both, false, "[A] offered a download that would not happen");
  assert.equal(O("installed", "installed").both, false, "[A] offered when everything was already on");
  assert.equal(O("installed", "unsupported").both, false, "[A] offered with nothing to do at all");

  // [D] keeps exactly the rule it already had: supported && !installed
  assert.equal(O("ready", "ready").daemon, true);
  assert.equal(O("ready", "installed").daemon, false);
  assert.equal(O("ready", "unsupported").daemon, false);
});

// ---- 3. end-to-end: the already-installed machine ---------------------------

test("[A] disappears from the menu once the daemon is already installed", (t) => {
  if (!supported()) return t.skip("no schedule format on this platform");
  const home = installDaemon(fakeHome());
  const r = run(home, SCAN_ARGS, { input: "Q\n", interactive: true });
  assert.equal(r.status, 0, r.stderr);
  const menu = menuOf(r.stdout);
  assert.ok(!menu.includes("[D]"), "[D] offered an already-installed daemon");
  assert.ok(!menu.includes("[A]"), "[A] still offered to install a daemon that is already installed");
  assert.ok(menu.includes("[I]"), "the models door vanished along with it");
});

test("[A] pressed with everything already on says so and writes nothing new", (t) => {
  if (!supported()) return t.skip("no schedule format on this platform");
  const home = preinstallModels(installDaemon(fakeHome()));
  const before = scheduleFiles(home).map((f) => f + ":" + readdirSync(dirname(f)).length);
  const r = run(home, SCAN_ARGS, { input: "A\nQ\n", interactive: true });
  assert.equal(r.status, 0, r.stderr);
  // No question was asked, so the "Q" that follows is consumed by the MENU and
  // the run ends normally. A screen that asked would have eaten the Q instead.
  assert.ok(
    !/── optional layer/.test(r.stdout),
    "a consent screen was shown for two layers that were both already on"
  );
  assert.match(r.stdout, /already/i, "[A] said nothing about why it did nothing");
  assert.deepEqual(
    scheduleFiles(home).map((f) => f + ":" + readdirSync(dirname(f)).length),
    before,
    "[A] rewrote schedule files that were already there"
  );
});

test("[A] pressed when only the daemon is left promises the daemon and not the download", (t) => {
  if (!supported()) return t.skip("no schedule format on this platform");
  const home = preinstallModels(fakeHome());
  const r = run(home, SCAN_ARGS, { input: "A\nagree\nQ\n", interactive: true });
  assert.equal(r.status, 0, r.stderr);
  const screen = r.stdout.slice(r.stdout.indexOf("── optional layer"));
  assert.ok(screen.length > 0, "no screen was shown for a door that still had work");
  assert.ok(!/DOWNLOAD/.test(screen.slice(0, screen.indexOf("use without"))),
    "promised a 600 MB download to a machine that already has the models");
  assert.ok(scheduleFiles(home).length > 0, "agreed, and the daemon half did not happen");
});

// ---- 4. NO_COLOR ------------------------------------------------------------

test("NO_COLOR: the conditioned screens and the nothing-to-start notice are plain", () => {
  const ESC = /\x1b\[/;
  for (const models of ["ready", "installed"]) {
    for (const daemon of ["ready", "installed", "unsupported"]) {
      for (const doorKey of ["models", "daemon", "both"]) {
        const plan = doorPlan(doorKey, { models, daemon });
        const s = plan.start.length
          ? consentScreen(doorKey, { color: false, layers: { models, daemon } })
          : nothingToStartNotice(doorKey, { models, daemon });
        assert.doesNotMatch(s, ESC, `${doorKey} @ ${models}/${daemon} carries colour`);
      }
    }
  }
});

// ---- [G] history — the series view, reachable from the menu ------------------
//
// Both builds of the series view shipped without a menu key, and both reviewers
// said the same thing about it independently: a view only reachable by typing a
// subcommand you already know exists is not one that gets read. These two tests
// are the whole of that fix — the key is offered, and pressing it renders the
// same three-state answer the subcommand renders.

test("[G] is offered in the menu", () => {
  const home = fakeHome();
  const r = run(home, SCAN_ARGS, { input: "Q\n", interactive: true });
  const menu = menuOf(r.stdout);
  assert.ok(menu.includes("[G]"), "the menu never offered the history view");
  assert.match(menu, /how many months of history exist/,
    "[G] was listed without saying what it answers");
});

test("[G] renders the same view the `series` subcommand renders", () => {
  const home = fakeHome();
  const viaKey = run(home, SCAN_ARGS, { input: "G\nQ\n", interactive: true });
  const viaSub = run(home, ["series"]);
  // The subcommand's whole output must appear in the menu run. Two renderings
  // of one question drift apart; this asserts there is one rendering.
  const body = viaSub.stdout.trim();
  assert.ok(body.length > 0, "the series subcommand printed nothing to compare against");
  assert.ok(viaKey.stdout.includes(body),
    "pressing [G] did not produce what `starreckon series` produces");
});
