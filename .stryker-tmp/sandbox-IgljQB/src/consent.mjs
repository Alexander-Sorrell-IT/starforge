// @ts-nocheck
// The consent screen for the optional layers — models, daemon, or both.
//
// WHY THIS IS ITS OWN FILE, AND WHY IT ONLY RETURNS STRINGS
//
// The screen is reached two ways: a FLAG (`--with-models`, `--with-daemon`,
// `--with-both`) and a BUTTON in the before-you-go menu ([I], [D], [A]). The
// author's requirement is that those are the SAME screen, not two texts that
// happen to agree today. Two renderings of one promise are two things that will
// drift, and this repo has the scar tissue for exactly that shape of bug (see
// the COPY_DIRS divergence and the double-counted floor in the sibling project).
// So there is one renderer, both entry points call it, and a test reads the
// text through this module rather than through a screenshot of the CLI.
//
// It does no I/O of any kind: no fs, no child_process, no network. It builds
// strings and classifies an answer. That keeps it off `verify`'s static-scan
// allowlist entirely — a file that cannot spawn or connect needs no exemption,
// and adding one would have meant a new pin and a new promise to keep.
//
// WHAT THE SCREEN MUST SAY (author ruling, SPEC-optional-layers.md §7)
//   1. WHAT is about to happen, named for the door taken.
//   2. THAT A LOG FILE WILL BE SAVED — for every door, daemon-only included.
//   3. WHERE it runs and writes: locally, in this machine's own folder.
//   4. That it is NOT required, and skipping it makes nothing else wrong.
//
// EXACTLY TWO ANSWERS. An earlier draft had three — agree / do not agree / use
// without — and the author struck the middle one as invented: the question is
// only ever "do you want this optional layer?", so declining IS using without
// it. Offering both makes the reader choose between synonyms and wonder what
// they missed. Neither answer is a dead end; the scan runs either way.

// The download figure printed on the models door. It is the same "~600 MB" the
// [I] button and `search --search-setup` have always quoted — approximate, and
// the model publisher's, not a measurement taken here. It lives in a named
// constant so the consent screen and any future re-wording move together.
export const MODELS_SIZE = "~600 MB";
export const MODELS_DEST = "~/.starreckon/.venv-search";

// Where a layer's log goes. NOT A GLOBAL PILE: the spec's phrase is "saved
// inside of that computer's folder", organised year / month / day, so that a
// ledger exists at every level of the architecture rather than only at the leaf.
//
// This constant is the promise the screen makes. src/layerlog.mjs is what keeps
// it, and tests/layerlog.test.mjs parses THIS STRING and requires the path the
// writer actually produces to match it — so the sentence and the bytes cannot
// drift apart without a test failing. The shape lives here, on the screen side,
// because consent.mjs must do no I/O (see the header) and importing the writer
// would drag node:fs into a file whose whole value is not having it.
export const LOG_DIR_SHAPE = "~/.starreckon/logs/<year>/<month>/<day>/";

/**
 * The three doors. `both` is a door in its own right, not a loop over the other
 * two: the author's requirement is ONE flag and ONE button that turn on models
 * and daemon together — "Not two presses" — and a door that renders as one
 * screen is the only way the reader agrees to one thing once.
 */
export const DOORS = Object.freeze({
  models: Object.freeze({
    name: "models",
    phrase: "the models layer",
    heading: "optional layer — the models",
    // (1) WHAT is about to happen, named for this door.
    about: Object.freeze([
      `about to DOWNLOAD the Cisco SecureBERT models (${MODELS_SIZE}) into`,
      `${MODELS_DEST}, so that \`starreckon search\` can read your`,
      `sessions by meaning instead of by substring.`,
    ]),
    // (3) WHERE — the door-specific half. The generic half is shared below.
    where: Object.freeze([
      `the download is the one moment this tool touches the network, and it`,
      `fetches model weights ONLY — nothing of yours is sent, then or later.`,
      `search itself runs offline, on this machine, against files already on`,
      `your disk.`,
    ]),
    agreeVerb: "download the models now",
  }),
  daemon: Object.freeze({
    name: "daemon",
    phrase: "the daemon layer",
    heading: "optional layer — the daemon",
    about: Object.freeze([
      `about to WRITE THE SCHEDULE FILES for two jobs that would run later,`,
      `unattended: a monthly scan (so the history outlives the ~30-day log`,
      `retention) and a 6-hour protect tick.`,
    ]),
    where: Object.freeze([
      `both jobs are local: they read files already on this disk and write`,
      `under ~/.starreckon. no network, scheduled or otherwise.`,
      `this tool does not load it for you — it writes the files and prints`,
      `the one command that makes them live, which you type yourself.`,
    ]),
    agreeVerb: "write the schedule files now",
  }),
  both: Object.freeze({
    name: "both",
    phrase: "the models and daemon layers",
    heading: "optional layers — models AND daemon, in one press",
    about: Object.freeze([
      `about to do BOTH in one answer:`,
      `  · DOWNLOAD the Cisco SecureBERT models (${MODELS_SIZE}) into ${MODELS_DEST}`,
      `  · WRITE THE SCHEDULE FILES for the monthly scan and the 6-hour protect tick`,
    ]),
    where: Object.freeze([
      `the model download is the one moment this tool touches the network, and`,
      `it fetches model weights ONLY — nothing of yours is sent. everything`,
      `else is local: both scheduled jobs read files already on this disk and`,
      `write under ~/.starreckon.`,
      `this tool does not load the schedule for you — it writes the files and`,
      `prints the one command that makes them live, which you type yourself.`,
    ]),
    agreeVerb: "do both now",
  }),
});

export const DOOR_KEYS = Object.freeze(Object.keys(DOORS));

// ── WHAT A DOOR CAN ACTUALLY START, ON THIS MACHINE ──────────────────────────
//
// THE DEFECT THIS SECTION EXISTS FOR. [D] hid itself when the daemon was
// unsupported or already installed; [A] — "models AND daemon in ONE press" —
// printed unconditionally, and the `both` screen announced "about to WRITE THE
// SCHEDULE FILES" on every platform. On a machine with no schedule format the
// reader was told the files were coming, answered "agree", and none were
// written. The same shape was live on the models half: a reader whose venv was
// already on disk was quoted a ~600 MB download that could not happen.
//
// A screen that announces work it cannot do is precisely the failure a consent
// screen exists to prevent, so the promise is conditioned on measured state.
//
// WHY THE STATES ARE PASSED IN. This module does no I/O — that is the whole
// reason it stays off verify's static-scan allowlist (see the header). It
// cannot look at the disk to find out whether a venv exists or a plist is
// written, so the caller measures and passes the answer down. That also makes
// every state testable without owning the machine it describes.
//
// WHY THE MENU RULE LIVES HERE TOO. `offeredDoors` is the same question one
// step earlier — which buttons to print. Keeping the rule beside the text it
// gates is what stops the two from drifting, which is the bug this whole file
// was written to avoid, and it is the exact way [A] came apart from [D].
export const LAYER_KEYS = Object.freeze(["models", "daemon"]);

/** Which layers each door is made of. `both` is the only composite. */
export const DOOR_LAYERS = Object.freeze({
  models: Object.freeze(["models"]),
  daemon: Object.freeze(["daemon"]),
  both: Object.freeze(["models", "daemon"]),
});

// "ready"       — this layer would really run, right now, on this machine
// "installed"   — already on; running it again would do nothing the reader wants
// "unsupported" — cannot happen here at all (no schedule format for the platform)
export const LAYER_STATES = Object.freeze(["ready", "installed", "unsupported"]);

// Why each skipped layer is skipped, said in the reader's terms. A layer that
// silently vanishes from the screen is no better than one falsely promised:
// "all extras" that quietly became one extra still leaves a reader believing
// both are coming.
const SKIP_LINES = Object.freeze({
  "models:installed": Object.freeze([
    `the models are ALREADY INSTALLED at ${MODELS_DEST} —`,
    `nothing will be downloaded. run \`starreckon search "your query"\`.`,
  ]),
  "daemon:installed": Object.freeze([
    `the schedule files are ALREADY WRITTEN — they will not be rewritten.`,
    `\`starreckon daemon off\` removes them; \`starreckon daemon on\` writes`,
    `them again.`,
  ]),
  "daemon:unsupported": Object.freeze([
    `this platform has NO SCHEDULE FORMAT, so nothing will be scheduled — not`,
    `now and not by agreeing. run the scan from your own cron or timer instead.`,
  ]),
});

/** Reject a typo'd state rather than render a full promise for it. */
function readStates(layers, fn) {
  const out = {};
  for (const k of LAYER_KEYS) {
    const v = layers?.[k];
    if (!LAYER_STATES.includes(v)) throw new Error(`${fn}: unknown state "${v}" for layer "${k}"`);
    out[k] = v;
  }
  return out;
}

/**
 * What this door would actually do on a machine in this state.
 *
 *   start — layers that will really run if the reader agrees
 *   skip  — layers that will not, each with the reason, in door order
 *
 * `start` empty means there is nothing to consent to. See nothingToStartNotice.
 */
export function doorPlan(doorKey, layers) {
  const door = DOORS[doorKey];
  if (!door) throw new Error(`doorPlan: unknown door "${doorKey}"`);
  const st = readStates(layers, "doorPlan");
  const start = [],
    skip = [];
  for (const layer of DOOR_LAYERS[doorKey]) {
    if (st[layer] === "ready") start.push(layer);
    else skip.push({ layer, state: st[layer] });
  }
  return { key: doorKey, start: Object.freeze(start), skip: Object.freeze(skip) };
}

/**
 * Which optional doors the menu offers, given the same measured states.
 *
 *   [D] keeps exactly the rule it always had: offered only when the daemon is
 *       supported and not yet installed.
 *
 *   [I] is offered ALWAYS, and deliberately unlike [D]. Pressing it with the
 *       models already on disk is not a wasted press: it names the venv path
 *       and the search command, which is real information the menu's absence
 *       cannot convey. [D] has no such thing to say — its whole content is the
 *       scheduling — so hiding it says everything hiding it needs to.
 *
 *   [A] is offered only when it genuinely combines TWO startable layers. Its
 *       entire promise is "in ONE press"; a door that can only ever start one
 *       layer saves no press and duplicates a single-layer door that is right
 *       there and visible. Degenerating to one layer is not a reason to keep
 *       it — it is the reason to drop it. Nothing is lost: whichever half is
 *       still startable has its own visible door.
 *
 * The FLAGS are not gated by this. `--with-both` is a request a user can type
 * on any platform and it must be answered honestly rather than ignored — it
 * gets the conditioned screen, or the nothing-to-start notice.
 */
export function offeredDoors(layers) {
  const st = readStates(layers, "offeredDoors");
  const ready = (k) => st[k] === "ready";
  return { models: true, daemon: ready("daemon"), both: ready("models") && ready("daemon") };
}

/**
 * Printed INSTEAD of the screen when a door has nothing left to start.
 *
 * Asking for consent to do nothing is its own small dishonesty: a reader who
 * answers "agree" and watches nothing happen has learnt that the screen is
 * decorative, which costs more than the question was worth. So the state is
 * stated and no question is asked.
 */
export function nothingToStartNotice(doorKey, layers) {
  const door = DOORS[doorKey];
  if (!door) throw new Error(`nothingToStartNotice: unknown door "${doorKey}"`);
  const { skip } = doorPlan(doorKey, layers);
  // Deliberately NOT "already on": that is true of an installed layer and false
  // of an unsupported one, and a platform with no scheduler being told its
  // daemon is "already" set up is a fresh untruth in the line meant to end one.
  // The neutral lead-in holds for every mix; the per-layer reasons below say
  // which case this actually is.
  const L = [
    `nothing to turn on here — none of what ${door.phrase} ` +
      `${doorKey === "both" ? "offer" : "offers"} would actually happen:`,
  ];
  for (const s of skip) for (const line of SKIP_LINES[`${s.layer}:${s.state}`]) L.push(`  ${line}`);
  L.push(`nothing was downloaded and nothing was scheduled. the scan runs exactly as it would have.`);
  return L.join("\n");
}

/**
 * The screen. Returns a string; the caller prints it.
 *
 * `color` is a parameter rather than a read of process.env because this module
 * is meant to be readable by a test without a terminal, and because NO_COLOR is
 * already emptied at one source in cli.mjs — a second reader of it here is a
 * second thing to keep in step.
 *
 * `layers` is the measured state of each layer. Omitting it renders the door's
 * full text — the machine the wording was written for — and that fallback is
 * load-bearing: when nothing is skipped the conditioned screen must be the
 * canonical screen BYTE FOR BYTE, or every screen test in the suite is quietly
 * asserting a second wording. That is guaranteed here by construction rather
 * than by keeping two texts in step: if nothing is skipped, this is the same
 * code path as before.
 */
export function consentScreen(doorKey, { color = true, layers = null } = {}) {
  const door = DOORS[doorKey];
  if (!door) throw new Error(`consentScreen: unknown door "${doorKey}"`);
  const plan = layers ? doorPlan(doorKey, layers) : null;
  if (plan && plan.start.length === 0)
    throw new Error(`consentScreen: door "${doorKey}" has nothing to start — use nothingToStartNotice`);
  // With one layer left, the body IS the surviving layer's own door: the same
  // wording [D] or [I] would have shown, rather than a third text describing
  // half of [A]. The HEADING stays the door the reader actually took.
  const body = plan && plan.skip.length ? DOORS[plan.start[0]] : door;
  const B = color ? "\x1b[1m" : "",
    D = color ? "\x1b[2m" : "",
    C = color ? "\x1b[36m" : "",
    R = color ? "\x1b[0m" : "";

  const L = [];
  L.push("");
  L.push(`${B}${C}── ${door.heading} ─────────────────────────${R}`);
  L.push("");
  // (1) what happens
  L.push(`${B}what happens next${R}`);
  for (const line of body.about) L.push(`  ${line}`);
  L.push("");
  // (1b) and what does NOT — only ever reached when a layer was dropped, so an
  //      all-ready machine renders the canonical screen unchanged.
  if (plan && plan.skip.length) {
    L.push(`${B}what will NOT happen${R}`);
    for (const s of plan.skip) for (const line of SKIP_LINES[`${s.layer}:${s.state}`]) L.push(`  ${line}`);
    L.push("");
  }
  // (2) the log — stated for EVERY door, daemon-only included. A layer that
  //     writes a record without saying so is the opposite of this program's
  //     claim, and the daemon-only case is the one an earlier draft dropped.
  L.push(`${B}a log file will be saved${R}`);
  // Tense is load-bearing, and it is now RIGHT for the second reason rather
  // than the first. It was written as "will write one" because nothing wrote a
  // log at all and "writes one" would have been a false statement of present
  // fact. src/layerlog.mjs writes them now — and the future tense is still the
  // true one, because this screen is printed BEFORE the layer runs and it is
  // describing runs that have not happened. Unchanged, deliberately: the words
  // the reader agreed to are the same words, and now they are backed.
  L.push(`  every run of this layer will write one, under`);
  L.push(`  ${LOG_DIR_SHAPE} — inside THIS machine's own folder,`);
  L.push(`  by year / month / day. that log is what makes the layer auditable`);
  L.push(`  after this terminal is closed, which for a scheduled run is the`);
  L.push(`  only accounting there can be.`);
  L.push("");
  // (3) where it runs and writes
  L.push(`${B}where it runs, and where it writes${R}`);
  L.push(`  locally, on this machine, into this machine's own folder.`);
  for (const line of body.where) L.push(`  ${line}`);
  L.push("");
  // (4) not required
  L.push(`${B}it is not required${R}`);
  L.push(`  skipping it does not make anything else wrong. the scan, the star,`);
  L.push(`  the snapshots and the report are all complete without it — this is`);
  L.push(`  an extra sense, not a prerequisite.`);
  L.push("");
  // exactly two answers
  L.push(`  ${B}agree${R}          ${body.agreeVerb}`);
  L.push(`  ${B}use without${R}    carry on WITHOUT this layer — the scan still runs`);
  L.push("");
  return L.join("\n");
}

// The accepted spellings of each of the two answers. A blank line is "use
// without": the default has to be the one that turns nothing on, because the
// cost of a wrong "agree" is a download and a scheduled job the reader did not
// ask for, and the cost of a wrong "use without" is that they press the button
// again.
const AGREE_WORDS = Object.freeze(["agree", "a"]);
const WITHOUT_WORDS = Object.freeze(["use without", "without", "use-without", "w", ""]);

/** "agree" | "without" | null (nothing recognisable). Never throws. */
export function parseConsent(raw) {
  const s = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (AGREE_WORDS.includes(s)) return "agree";
  if (WITHOUT_WORDS.includes(s)) return "without";
  return null;
}

/** Printed when the answer was neither, before asking once more. */
export const UNRECOGNISED_LINE =
  'not an answer I recognise. type "agree" or "use without" (blank = use without).';

/** Printed once the reader has chosen to carry on without the layer. */
export function withoutLine(doorKey) {
  const door = DOORS[doorKey];
  if (!door) throw new Error(`withoutLine: unknown door "${doorKey}"`);
  return `using starreckon WITHOUT ${door.phrase}. nothing was downloaded and nothing was scheduled. the scan runs exactly as it would have.`;
}

/**
 * The non-TTY answer, printed on STDERR.
 *
 * A flag can be typed in a script, a CI job, or the sandboxed proof run, where
 * there is nobody to ask. Two failure modes are ruled out here and both have
 * shipped in other tools: HANGING on a prompt nobody can see, and ASSUMING the
 * answer is yes because the flag was passed. Passing the flag is a request to be
 * asked, not an answer — so with no terminal, the answer is "use without", it is
 * said out loud, and the scan carries on.
 *
 * stderr, not stdout, because the scan's own output is routinely piped into a
 * file or a parser and this line is about the RUN, not about the results.
 */
export function nonTtyNotice(doorKey) {
  const door = DOORS[doorKey];
  if (!door) throw new Error(`nonTtyNotice: unknown door "${doorKey}"`);
  return (
    `starreckon: no terminal to ask on, so ${door.phrase} ${doorKey === "both" ? "were" : "was"} NOT turned on — ` +
    `defaulting to "use without". nothing was downloaded and nothing was scheduled, ` +
    `and the scan continues. passing the flag asks to be asked; it is not an answer. ` +
    `run it in a terminal to be asked.`
  );
}

// ── WHERE THE PROMISE IS KEPT ────────────────────────────────────────────────
// The screen promises a log file. Three things had to land for that sentence to
// be true, and all three are in the tree now:
//
//   1. the writer — src/layerlog.mjs. One immutable record per layer run under
//      LOG_DIR_SHAPE, resolved against the real home (it handles the literal-"~"
//      $HOME that snapshots.mjs:20-27 records an npx run dying on).
//   2. the callers — src/search.mjs's runSearch() records every MODEL run, and
//      src/cli.mjs arms a record for every SCHEDULED daemon run above the
//      subcommand dispatch, since a scheduled run is precisely the run with no
//      terminal to account for it. The schedule files carry the marker that
//      says which job they are (src/daemon.mjs, STARRECKON_LAYER_RUN).
//   3. the reader — src/receipt.mjs surfaces the tree, so the log appears in
//      the list of what this program has KEPT about you.
//
// The per-level ledger is a VIEW recomputed from the run records on every
// write, never a second counter — two counters that must agree are two counters
// that will disagree. The cheap check that it stayed one: delete every
// ledger.json in the tree and the next layer run must rebuild them identically.
//
// What is still open, and is the author's to answer (SPEC-optional-layers.md
// §6): whether a MODEL record should carry the full three-statement protocol
// (your claim / the model's band / the outcome) rather than the run's shape
// alone. Today it carries the run.
