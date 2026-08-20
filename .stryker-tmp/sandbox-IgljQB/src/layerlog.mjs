// @ts-nocheck
// The log the consent screen promises, and the ledger that reads it back.
//
// WHAT THIS PAYS OFF
//
// src/consent.mjs prints, before any optional layer starts:
//
//     a log file will be saved
//       every run of this layer will write one, under
//       ~/.starreckon/logs/<year>/<month>/<day>/ — inside THIS machine's own
//       folder, by year / month / day.
//
// Until this file existed that was a debt: the screen said it, nothing did it.
// consent.mjs owns the SENTENCE (it must stay free of fs — see its header) and
// this file owns the BYTES. The two are bound by a test, not by hope:
// tests/layerlog.test.mjs parses consent.LOG_DIR_SHAPE and requires the path
// this module actually writes to match it. Change either one alone and that
// test fails, which is the only arrangement in which a promise and its keeper
// cannot drift.
//
// TWO KINDS OF FILE, AND ONLY ONE OF THEM IS A FACT
//
//   a RUN RECORD   logs/YYYY/MM/DD/<time>-<layer>-<event>-<pid>-<rand>.json
//                  One per run of an optional layer. Written once, never
//                  reopened, never edited. This is the truth.
//
//   a LEDGER       logs/ledger.json, logs/YYYY/ledger.json,
//                  logs/YYYY/MM/ledger.json, logs/YYYY/MM/DD/ledger.json
//                  A VIEW of the run records beneath it. Recomputed in full,
//                  from the records, every time it is written.
//
// THE LEDGER IS NEVER A COUNTER. This is the author's explicit rule and it is
// the one thing in this file that must not be "optimised" later: there is no
// `+= 1` anywhere below, no stored subtotal that a later run adds to, and no
// level that derives from another level's ledger. Every level re-reads the leaf
// records. The reason is measured, not theoretical — this project has already
// shipped a second counter that inflated a number 2.71x (src/accounts.mjs:443,
// which summed rows a dedup should have collapsed), and a stored floor that
// froze 16,636 sessions against a true 132 (src/snapshots.mjs, quoted in
// src/ledger.mjs:116). Two numbers that must agree are two numbers that will
// disagree, and the one that is wrong is always the one nobody can recompute.
//
// The practical test of the rule: delete every ledger.json in the tree. The
// next run must rebuild them all identically. If that is ever not true, the
// ledger has become a counter and this file has failed its job.
//
// WHICH RUNS LAND HERE, AND WHY IT IS NOT "ALL OF THEM"
//
//   the models layer — EVERY invocation, scheduled or typed. The layer exists
//       only because someone agreed to the screen, so every use of it is a use
//       of the thing they agreed to. Hooked inside search.mjs's runSearch(),
//       which is the single door every model call goes through.
//   the daemon layer — every SCHEDULED run. The daemon layer IS the schedule;
//       a `starreckon protect` a user types and watches is a foreground command
//       whose account is the terminal it printed to. Writing a file for it would
//       mean writing files for people who never turned any layer on, which is
//       the opposite of the bargain the screen struck.
//
// A scheduled run identifies itself with STARRECKON_LAYER_RUN, set by the
// schedule files daemon.mjs writes. It is a claim, not evidence — anyone can
// export it — and the record says so in its own `trigger_claimed_by` field
// rather than presenting it as a measurement.
//
// MASKING — DECIDED, NOT INHERITED
//
// This program masks before it writes, in four layers (src/redact.mjs):
// redactSecrets (25+ credential patterns), maskPath (home, username),
// accountPseudonym (identities), maskProjects (project names, under
// --no-projects). Which of them apply HERE:
//
//   redactSecrets + maskPath — YES, unconditionally, to every string that goes
//       into a record. maskText() is both, and it is applied at the boundary in
//       detailOf() so a future caller cannot forget it. src/audit.mjs:133 does
//       exactly this to argv for exactly this reason: a path or a flag value is
//       where the home directory and the username get in.
//
//   accountPseudonym — NOT APPLIED, because no identity is collected. A record
//       describes a RUN (which layer, when, how long, what came back), never a
//       user. There is nothing here to pseudonymise, and the way to keep that
//       true is to not have the field.
//
//   maskProjects — the same answer for a sharper reason. Project names are kept
//       readable BY DEFAULT in reports (src/redact.mjs:181) because a report is
//       most of the product; that trade was made for a file the user asks for
//       and reads. It is the wrong trade for a file written unattended by a
//       scheduled job. So no project label is recorded at all.
//
//   the search QUERY is the case worth naming. It is the user's own words about
//       their own code, and it is exactly what `starreckon receipt` exists to
//       prove this tool does not keep — receipt flags stored prose over 400
//       chars (src/receipt.mjs:33) and it walks this tree, so storing a query
//       here would make the tool's own disclosure command point at the tool.
//       A record therefore carries the query's LENGTH and a salted-free sha256
//       prefix, which answers "was this the same search as yesterday?" without
//       keeping the search. Auditing a layer needs to know a search ran, not
//       what was asked.
//
// CONCURRENCY
//
// The 6-hour protect tick and a person at a terminal can write in the same
// second; on the 1st of a month the monthly scan can join them. Two mechanisms,
// because the two kinds of file have opposite problems:
//
//   run records  — never share a file, and a record is NEVER overwritten. The
//       name carries the time to the millisecond, the pid and 2 random bytes,
//       so two PROCESSES cannot collide at all; the only remaining case is one
//       process writing twice in the same millisecond and drawing the same
//       bytes, and that draws again rather than replacing what is there. The
//       placement uses link(2), which is atomic AND fails on an existing name,
//       so there is no check-then-write window either. No lock is needed to
//       record the truth, which is the property that matters: whatever else
//       fails, the record lands, and it never lands on top of another one.
//       (fleet.mjs:628 is the counter-example in this repo: mkdir -p then
//       writeFileSync, no existence check, so a second write silently replaces
//       a machine's totals. Not a pattern to inherit one directory over.)
//
//   ledgers      — one writer at a time, via an O_EXCL-equivalent lock
//       (mkdir is atomic on every platform this runs on). Without it two runs
//       could each walk the tree and the slower one's write would erase the
//       faster one's, and the tree would look one run short until the next run
//       fixed it. A lock that cannot be taken is NOT an error and never blocks
//       a run: the record is already on disk, so the next successful run
//       rebuilds the view. src/audit.mjs:59 records the same race in the audit
//       dir as a known limit; here it is a lock and a self-healing view.
//
// THE CLOCK
//
// The directory is the LOCAL calendar date, because the tree is a person's
// index of their own machine and "what ran on Tuesday" means their Tuesday.
// The record also carries `at` (UTC instant) and `tz_offset_minutes`, so the
// ordering is never ambiguous even across a timezone change or a DST fold.
// audit.mjs stamps UTC only; that is right for a hash chain and wrong for a
// folder someone opens, and the difference is why both are written here.
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { maskText } from "./redact.mjs";

export const LOGS_SUBDIR = "logs";
export const LEDGER_BASENAME = "ledger.json";
export const RECORD_KIND = "layer-run";
export const LEDGER_KIND = "layer-ledger";

// The env var a scheduled job sets to say which job it is: "daemon:scan" or
// "daemon:protect". daemon.mjs writes it into the plist/unit it generates.
export const TRIGGER_ENV = "STARRECKON_LAYER_RUN";

export const LAYERS = Object.freeze(["daemon", "models"]);

// os.homedir() returns $HOME verbatim, and $HOME can arrive as a literal "~"
// from a wrapper that exported an unexpanded path — snapshots.mjs:20-27 records
// the npx run that died on `mkdir '~/.starreckon/snapshots'`, and the silent
// variant is worse: a literal "~" directory beside wherever the scheduler
// happened to be standing, which nothing ever reads again. userInfo().homedir
// reads the passwd entry and ignores $HOME, so it is the one source that cannot
// come back with a tilde — but it is consulted ONLY in that case, because a run
// with HOME deliberately pointed somewhere else (every test in this repo, and
// the sandboxed proof run) must be believed.
export function resolveHome(home) {
  const h = home ?? homedir();
  if (!h.startsWith("~")) return h;
  let pw = "";
  try { pw = userInfo().homedir ?? ""; } catch {}
  return pw && !pw.startsWith("~") ? join(pw, h.slice(1)) : h;
}

/** ~/.starreckon/logs — the root of this machine's optional-layer tree. */
export function logsRoot(home) {
  return join(resolveHome(home), ".starreckon", LOGS_SUBDIR);
}

const p2 = (n) => String(n).padStart(2, "0");
const p3 = (n) => String(n).padStart(3, "0");

/**
 * The local calendar parts of an instant, as the tree spells them.
 * Returned as strings because they are path components, and "08" is a
 * directory name while 8 is a number that would render as "8".
 */
export function dateParts(when = new Date()) {
  const d = when instanceof Date ? when : new Date(when);
  const year = String(d.getFullYear());
  const month = p2(d.getMonth() + 1);
  const day = p2(d.getDate());
  return {
    year,
    month,
    day,
    date: `${year}-${month}-${day}`,
    time: `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`,
    // Date.getTimezoneOffset() is minutes to ADD to local to get UTC; negating
    // it gives the sign people write (UTC-7 => -420), which is what the record
    // has to say if it is to be read without a footnote.
    tz_offset_minutes: -d.getTimezoneOffset(),
  };
}

/** The directory a run at this instant belongs in. */
export function dayDir(home, when = new Date()) {
  const { year, month, day } = dateParts(when);
  return join(logsRoot(home), year, month, day);
}

// A short, stable fingerprint of a string this tool must NOT keep. Enough to
// answer "the same one again?", useless for recovering the text.
function fingerprint(s) {
  return createHash("sha256").update(String(s)).digest("hex").slice(0, 12);
}

// Everything a caller hands as `detail` goes through here: masked, truncated,
// and flattened to scalars. A record is a fixed-size fact about a run, so a
// caller cannot accidentally park an object graph — or a transcript — in one.
function detailOf(detail) {
  const out = {};
  for (const [k, v] of Object.entries(detail ?? {})) {
    if (v === null || v === undefined) { out[k] = null; continue; }
    if (typeof v === "number" || typeof v === "boolean") { out[k] = v; continue; }
    out[k] = maskText(String(v)).slice(0, 200);
  }
  return out;
}

/**
 * Describe a search invocation without keeping the search.
 * The argument list is search.py's own, e.g. ["query", "<text>", "--top", "10"]
 * or ["setup"]. Written this way on purpose: tests/cli-ux.test.mjs scans src/
 * for `argv:` followed by an array and requires every flag inside it to be a
 * REGISTERED CLI FLAG, because a proof-path command with an unregistered flag
 * exits 2 and reports a parse error as a network verdict. --top belongs to
 * search.py, not to the CLI, so this must not look like a CLI argv.
 */
export function searchDetail(argv) {
  const a = Array.isArray(argv) ? argv : [];
  const event = typeof a[0] === "string" && a[0] ? a[0] : "run";
  const detail = {};
  if (event === "query") {
    const q = typeof a[1] === "string" ? a[1] : "";
    // NOT the query. See the masking note in this file's header.
    detail.query_chars = q.length;
    detail.query_sha256_12 = fingerprint(q);
    const i = a.indexOf("--top");
    if (i >= 0 && a[i + 1] != null) detail.top = Number(a[i + 1]) || null;
  }
  return { event, detail };
}

/**
 * What STARRECKON_LAYER_RUN says this run is, or null for a run nobody
 * scheduled. Shape: "<layer>:<event>", e.g. "daemon:scan".
 */
export function scheduledRun(env = process.env) {
  const raw = env?.[TRIGGER_ENV];
  if (typeof raw !== "string" || !raw.trim()) return null;
  const [layer, event] = raw.trim().split(":");
  if (!LAYERS.includes(layer)) return null;
  return { layer, event: event && /^[a-z0-9-]{1,32}$/.test(event) ? event : "run" };
}

// Write via a temp name in the same directory, then rename. rename(2) is atomic
// within a filesystem, so a concurrent reader — `starreckon receipt`, or the
// ledger walk of another run — sees either the whole file or no file, never a
// half-written one it would count as unreadable.
//
// This REPLACES. It is used for the ledgers, which are views and must replace.
// It is never used for a run record; see writeNewFile.
function writeAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// The same, but it REFUSES TO OVERWRITE. Returns true if the file is now on
// disk because this call put it there, false if something was already at that
// name and was left alone.
//
// Why a record gets this and a ledger does not: a ledger is derived and can be
// rebuilt from the records, so replacing one loses nothing. A record is the
// only copy of a fact, and this codebase has the exact scar — fleet.mjs's
// writeMachineFolder() does mkdir -p then writeFileSync with no existence
// check, so a second submission silently replaces a machine's totals.json and
// the fleet then publishes the replacement as that machine's number. That is
// not a pattern to inherit one directory over.
//
// link(2) is the primitive that does both halves: it is atomic and it FAILS
// with EEXIST rather than clobbering, so there is no check-then-write window
// for anything to slip through — unlike an existsSync guard, which two writers
// can both pass (audit.mjs:272 has exactly that shape, and bob was right to
// name it). The temp file is unlinked afterwards either way.
export function writeNewFile(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(3).toString("hex")}`;
  writeFileSync(tmp, text);
  try {
    linkSync(tmp, file);
    return true;
  } catch (e) {
    // Filesystems without hard links (rare, but FAT and some network mounts)
    // report EPERM/ENOSYS rather than EEXIST. Fall back to the weaker guard
    // and say so by returning what actually happened, never by pretending.
    if (e?.code !== "EEXIST" && !existsSync(file)) {
      try { renameSync(tmp, file); return true; } catch {}
    }
    return false;
  } finally {
    try { rmSync(tmp, { force: true }); } catch {}
  }
}

/**
 * Record one run of one optional layer.
 *
 * Never throws: a run must not fail because its accounting could not be
 * written. Returns what happened, so a caller (and a test) can see the
 * difference between "written" and "could not write", which are not the same
 * fact and must never look the same.
 */
export function logLayerRun(entry, { home = null, now = new Date(), root = null } = {}) {
  const result = { ok: false, record: null, ledgers: [], ledger_written: false, error: null };
  try {
    const parts = dateParts(now);
    const base = root ?? logsRoot(home);
    const dir = join(base, parts.year, parts.month, parts.day);
    mkdirSync(dir, { recursive: true });

    const layer = LAYERS.includes(entry?.layer) ? entry.layer : "unknown";
    const event = /^[a-z0-9-]{1,32}$/.test(String(entry?.event ?? "")) ? entry.event : "run";
    const record = {
      record: RECORD_KIND,
      schema: 1,
      layer,
      event,
      // "interactive" | "schedule". A schedule claim comes from an env var any
      // process can set, so the record names its own source instead of
      // presenting the claim as a measurement.
      trigger: entry?.trigger === "schedule" ? "schedule" : "interactive",
      trigger_claimed_by: entry?.trigger === "schedule" ? TRIGGER_ENV : null,
      at: (now instanceof Date ? now : new Date(now)).toISOString(),
      date: parts.date,
      tz_offset_minutes: parts.tz_offset_minutes,
      pid: process.pid,
      outcome: ["ok", "failed", "skipped"].includes(entry?.outcome) ? entry.outcome : "ok",
      exit_code: Number.isInteger(entry?.exit_code) ? entry.exit_code : null,
      duration_ms: Number.isFinite(entry?.duration_ms) ? Math.round(entry.duration_ms) : null,
      detail: detailOf(entry?.detail),
    };

    // The name carries the pid, so two PROCESSES can never choose the same one
    // however closely they fire — the cross-process race does not exist here,
    // which is why this is not the check-then-write window audit.mjs has. What
    // is left is one process writing twice inside the same millisecond and
    // drawing the same 2 bytes, and that case is not resolved by overwriting
    // the earlier record: it is resolved by drawing again. A record that cannot
    // be placed without destroying another is reported as unwritten.
    const body = JSON.stringify(record, null, 2) + "\n";
    let file = null;
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, `${parts.time}-${layer}-${event}-${process.pid}-${randomBytes(2).toString("hex")}.json`);
      if (writeNewFile(candidate, body)) { file = candidate; break; }
    }
    if (!file) {
      result.error = "refused to overwrite an existing run record; no free name after 8 tries";
      return result;
    }
    result.ok = true;
    result.record = file;

    const led = writeLedgers(base, parts);
    result.ledgers = led.written;
    result.ledger_written = led.locked;
    result.ledger_skipped_reason = led.reason;
  } catch (e) {
    result.error = maskText(String(e?.message ?? e)).slice(0, 200);
  }
  return result;
}

/**
 * Arm the record for a scheduled DAEMON run, written from the process exit
 * hook so the outcome is the real one.
 *
 * Why the exit hook rather than a line at the end of main(): a scheduled run is
 * precisely the run with no terminal to account for it, so the case that most
 * needs a record is the run that died — and a record written only on the happy
 * path would be missing exactly then. src/audit.mjs:307 arms its own log the
 * same way and for the same reason. It cannot survive SIGKILL, a power cut or a
 * full disk; nothing in a process can.
 *
 * ONLY the daemon layer. A scheduled models run already writes its record
 * inside runSearch() — arming here as well would put two records on disk for
 * one run, and a double count is the failure this whole file is shaped against,
 * whatever the size of the number.
 */
export function armScheduledRunLog(run, opts = {}) {
  if (!run || run.layer !== "daemon") return null;
  const started = Date.now();
  let written = false;
  const write = (code) => {
    if (written) return null;
    written = true;
    return logLayerRun(
      {
        layer: run.layer,
        event: run.event,
        trigger: "schedule",
        outcome: code === 0 ? "ok" : "failed",
        exit_code: Number.isInteger(code) ? code : null,
        duration_ms: Date.now() - started,
      },
      opts
    );
  };
  try { process.on("exit", write); } catch {}
  return write;
}

// ---- reading the tree back --------------------------------------------------

function readRecord(file) {
  const raw = readFileSync(file, "utf8");
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== "object" || obj.record !== RECORD_KIND) return null;
  return obj;
}

/**
 * Every run record in the tree, with an honest account of what could not be
 * read. The counts are not decoration: this project's recurring bug is that an
 * absent thing looks exactly like a zero, so a record that failed to parse is
 * reported as a failure to parse and never quietly dropped into "no runs".
 *
 * Reads ONLY logs/YYYY/MM/DD/*.json — the shape the consent screen names.
 * Anything else in the tree is left alone and counted as `foreign`, so a stray
 * file can never be mistaken for a run and a run can never hide as a stray.
 */
export function collectRuns(base) {
  const out = { records: [], unreadable: 0, foreign: 0, ledgers: 0 };
  const dirs = (d) => {
    try { return readdirSync(d, { withFileTypes: true }); } catch { return []; }
  };
  const numeric = (name, len) => name.length === len && /^\d+$/.test(name);
  if (!existsSync(base)) return out;
  for (const y of dirs(base)) {
    if (ours(y.name)) continue;
    if (!y.isDirectory()) { countFlat(y, out); continue; }
    if (!numeric(y.name, 4)) { out.foreign += 1; continue; }
    for (const m of dirs(join(base, y.name))) {
      if (ours(m.name)) continue;
      if (!m.isDirectory()) { countFlat(m, out); continue; }
      if (!numeric(m.name, 2)) { out.foreign += 1; continue; }
      for (const d of dirs(join(base, y.name, m.name))) {
        if (ours(d.name)) continue;
        if (!d.isDirectory()) { countFlat(d, out); continue; }
        if (!numeric(d.name, 2)) { out.foreign += 1; continue; }
        const dir = join(base, y.name, m.name, d.name);
        for (const f of dirs(dir)) {
          if (ours(f.name)) continue;
          if (!f.isFile()) { out.foreign += 1; continue; }
          if (f.name === LEDGER_BASENAME) { out.ledgers += 1; continue; }
          if (!f.name.endsWith(".json")) { out.foreign += 1; continue; }
          let rec = null;
          try { rec = readRecord(join(dir, f.name)); } catch { rec = null; }
          if (!rec) { out.unreadable += 1; continue; }
          // The DIRECTORY is what the tree is indexed by, so the directory is
          // what the rollup groups on. A record whose own `date` disagrees with
          // the folder it sits in (hand-moved, or written across a clock change)
          // is still counted, under the folder — the alternative is a run that
          // is in the tree and in no level's ledger.
          out.records.push({ ...rec, _date: `${y.name}-${m.name}-${d.name}`, _file: f.name });
        }
      }
    }
  }
  return out;
}

// Our own furniture is not "foreign": the lock directory, and the temp name a
// concurrent writeAtomic is holding for the microsecond before its rename.
// Counting either as a stray file would put a permanent non-zero in the one
// field whose job is to say "something is in this tree that should not be".
function ours(name) {
  return name === LOCK_NAME || name.includes(".tmp-");
}

function countFlat(entry, out) {
  if (entry.isFile() && entry.name === LEDGER_BASENAME) out.ledgers += 1;
  else if (!ours(entry.name)) out.foreign += 1;
}

const bump = (o, k) => { if (k != null) o[k] = (o[k] ?? 0) + 1; };

/**
 * Tally a set of records. Pure — same records in, same numbers out, every time.
 *
 * The `+= 1` here is not the counter the rule forbids: it is a local sum over a
 * list this call just read, discarded when the call returns. What the rule
 * forbids is a number that OUTLIVES its records — one stored on disk and added
 * to by a later run, which is then the only place that number exists.
 */
function tally(records) {
  const t = { runs: records.length, by_layer: {}, by_event: {}, by_outcome: {}, first_at: null, last_at: null };
  for (const r of records) {
    bump(t.by_layer, r.layer);
    bump(t.by_event, `${r.layer}:${r.event}`);
    bump(t.by_outcome, r.outcome);
    if (typeof r.at === "string" && r.at) {
      if (!t.first_at || r.at < t.first_at) t.first_at = r.at;
      if (!t.last_at || r.at > t.last_at) t.last_at = r.at;
    }
  }
  return t;
}

const LEDGER_VIEW_NOTE =
  "a view, not a counter: recomputed in full from the run records below this " +
  "level on every write. delete it and the next run rebuilds it identically.";

/**
 * Build the ledger for one level from a set of records. `children` maps the
 * next level down to its run count — also derived, never stored anywhere else.
 */
export function ledgerFor(level, scope, records, { children = null, files = null, derived = null } = {}) {
  return {
    record: LEDGER_KIND,
    schema: 1,
    level,
    scope,
    view: LEDGER_VIEW_NOTE,
    clock: "local calendar date of the machine that wrote the records",
    generated_at: new Date().toISOString(),
    derived_from: derived ?? { record_files: records.length, unreadable: 0, foreign: 0 },
    ...tally(records),
    ...(children ? { children } : {}),
    ...(files ? { records: files } : {}),
  };
}

// ---- the lock ---------------------------------------------------------------
//
// mkdir is the portable atomic test-and-set: it either creates the directory or
// fails because someone else holds it. No lockfile contents, no pid to trust —
// a stale lock is broken by AGE alone, because a pid check cannot tell a dead
// writer from a live one in another container sharing the home directory.
const LOCK_NAME = ".ledger.lock";
const LOCK_TRIES = 60;
const LOCK_WAIT_MS = 20;
const LOCK_STALE_MS = 30_000;

// Node has no sync sleep; Atomics.wait on a private buffer is one, and this
// path must be synchronous because it is reachable from a process-exit hook.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

function takeLock(base) {
  const lock = join(base, LOCK_NAME);
  for (let i = 0; i < LOCK_TRIES; i++) {
    try { mkdirSync(lock); return lock; } catch {}
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
    } catch {}
    sleepSync(LOCK_WAIT_MS);
  }
  return null;
}

/**
 * Rewrite the ledger at the four levels on this run's path: day, month, year,
 * root. Other branches of the tree are untouched because nothing under them
 * changed — their ledgers are still exactly what a rebuild would produce.
 *
 * One walk of the tree feeds all four, so the levels cannot disagree with each
 * other: they are four filters over one list, not four traversals that might
 * see different disks.
 */
export function writeLedgers(base, parts) {
  const written = [];
  const lock = takeLock(base);
  if (!lock) {
    // Not an error, and deliberately not retried forever. The run record is
    // already on disk; the view is stale until the next run, and the next run
    // rebuilds it from the records rather than from this stale copy.
    return { locked: false, written, reason: "another run held the ledger lock" };
  }
  try {
    const all = collectRuns(base);
    const derived = {
      record_files: all.records.length,
      unreadable: all.unreadable,
      foreign: all.foreign,
    };
    const inYear = all.records.filter((r) => r._date.startsWith(parts.year));
    const inMonth = inYear.filter((r) => r._date.startsWith(`${parts.year}-${parts.month}`));
    const inDay = inMonth.filter((r) => r._date === parts.date);

    const childCounts = (records, keyOf) => {
      const o = {};
      for (const r of records) bump(o, keyOf(r));
      // Sorted so the file is byte-stable for the same tree — a ledger that
      // reshuffles its own keys looks like a change to anything diffing it.
      return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
    };

    const levels = [
      [join(base, LEDGER_BASENAME),
        ledgerFor("root", "all", all.records, { children: childCounts(all.records, (r) => r._date.slice(0, 4)), derived })],
      [join(base, parts.year, LEDGER_BASENAME),
        ledgerFor("year", parts.year, inYear, { children: childCounts(inYear, (r) => r._date.slice(5, 7)), derived })],
      [join(base, parts.year, parts.month, LEDGER_BASENAME),
        ledgerFor("month", `${parts.year}-${parts.month}`, inMonth, { children: childCounts(inMonth, (r) => r._date.slice(8, 10)), derived })],
      [join(base, parts.year, parts.month, parts.day, LEDGER_BASENAME),
        ledgerFor("day", parts.date, inDay, { files: inDay.map((r) => r._file).sort(), derived })],
    ];
    for (const [file, doc] of levels) {
      mkdirSync(join(file, ".."), { recursive: true });
      writeAtomic(file, JSON.stringify(doc, null, 2) + "\n");
      written.push(file);
    }
  } finally {
    try { rmSync(lock, { recursive: true, force: true }); } catch {}
  }
  return { locked: true, written, reason: null };
}

/**
 * What the tree holds, for `starreckon receipt`.
 *
 * Derived from the RECORDS, never read off the ledger files — a receipt that
 * repeated a stored number could be made to repeat a wrong one, which is the
 * one thing a receipt may not do. The on-disk root ledger is then compared
 * against that derivation and any disagreement is reported, so a stale or
 * edited view is visible instead of authoritative.
 */
export function summariseLayerLogs(base) {
  const summary = {
    dir: base,
    exists: existsSync(base),
    runs: 0,
    by_layer: {},
    by_event: {},
    by_outcome: {},
    first_at: null,
    last_at: null,
    days: 0,
    unreadable: 0,
    foreign: 0,
    ledger_files: 0,
    ledger_runs: null,
    ledger_agrees: null,
  };
  if (!summary.exists) return summary;
  const all = collectRuns(base);
  Object.assign(summary, tally(all.records));
  summary.days = new Set(all.records.map((r) => r._date)).size;
  summary.unreadable = all.unreadable;
  summary.foreign = all.foreign;
  // collectRuns already counted the root ledger (it is a plain file directly
  // under base, so the year loop hands it to countFlat). Adding it again here
  // is the whole bug class this file exists to avoid, in miniature.
  summary.ledger_files = all.ledgers;
  try {
    const root = JSON.parse(readFileSync(join(base, LEDGER_BASENAME), "utf8"));
    if (root && root.record === LEDGER_KIND && Number.isInteger(root.runs)) {
      summary.ledger_runs = root.runs;
      summary.ledger_agrees = root.runs === summary.runs;
    }
  } catch {}
  return summary;
}
