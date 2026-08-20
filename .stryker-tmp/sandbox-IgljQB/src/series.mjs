// @ts-nocheck
// `starreckon series` — how much ordered history this machine holds, and what
// stands between it and a forecast band that would mean anything.
//
// IT DRAWS NO BAND, AND THAT IS THE FEATURE.
//
// deadreckon carries the time-series witness (forecast_check.py, the Cisco
// model): a second opinion that commits to a band BEFORE anyone knows the
// outcome, so it cannot be shaped by the result the way a test written after
// the fact can. starreckon has no witness at all. This command is not a
// half-built one — it reports the one fact that decides whether a witness here
// could ever mean anything: HOW MANY POINTS OF HISTORY EXIST.
//
// The bar is 10 and it is not ours to soften. It is a property of the model —
// its short contexts are trained only down to 10 points — and forecast_check.py
// refuses anything shorter outright, in its own words: "a band over nothing is
// worse than no band". Drawing a band over 8 points, or widening the interval
// to cover the shortfall, would be a check that cannot fail wearing 250M
// parameters. That is the failure mode this file exists to refuse, so nothing
// below predicts, scores, or gates: it prints counts and exits 0 either way.
//
// THREE ANSWERS, AND THEY ARE NEVER ONE ANSWER.
//
//   not enough yet   the history is 8 of 10. The data is short.
//   ran, nothing     the witness IS installed, it ran, and it recorded nothing.
//   not installed    there is no witness on this machine. Nothing ran, so
//                    "nothing was found" was never measured.
//
// Collapsing those is this project's signature defect — absent rendering
// exactly like zero — and it has cost this system 59,131 files, a 2.71x
// inflation and 4.07 billion orphaned tokens on separate occasions. The row
// states below carry the same split one level down: a series no snapshot has
// ever measured reports `no history`, never `0 of 10`.
//
// EVERY NUMBER IS COUNTED OFF THE FILES, ON EVERY RUN.
//
// Nothing here reads a stored count, a lifetime total or a `months_tracked`
// field. The reason is on the record: a Math.max over a stored record made
// corrections unreachable in ledger.mjs, and 16,636 sessions stood against a
// true 132 permanently because the stored number could only ever go up. A count
// that is re-derived at read time can be corrected by deleting a file; a stored
// one cannot be corrected at all.
//
// AND IT NEVER COMPUTES A VALUE. It counts POSITIONS — which months carry a
// measurement — and does no arithmetic on the measurements themselves. A view
// that sums nothing cannot be silently wrong about a sum, which is the shape of
// every scar this project has.
//
// WHY IT DOES NOT GO THROUGH loadTimeline(). Measured on a 3-month fixture whose
// oldest month predates two keys:
//
//     loadTimeline sessions     [1,2,3]     3 finite points
//     loadTimeline tool_calls   [0,2,3]     3 finite points   <- the 0 is a lie
//     loadTimeline night_hours  [null,2,3]  2 finite points
//
// loadTimeline() zero-fills its accumulator, so a month written before a field
// existed comes back as 0 — a fabricated point, indistinguishable from a month
// that genuinely measured zero, and exactly the thing you must not hand a
// forecaster as history. night_hours disagrees only because snapshots.mjs:212
// already had to fix that ONE field after 137.3 real night hours were drawn as
// 450,107. Every other field still has it. So the counting reads the raw
// records, where absent is absent.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SNAP_DIR } from "./snapshots.mjs";
import { resolveHome } from "./layerlog.mjs";
import { maskPath } from "./redact.mjs";

// forecast_check.py — `MIN_POINTS = 10`, with the reason stated in the comment
// above it. Cited by SYMBOL, not by line: the same constant sits at :93 in one
// checkout of that file and :115 in another, and a line number that drifts is a
// citation a reader cannot follow.
export const MIN_POINTS = 10;
export const MIN_POINTS_SOURCE = "deadreckon forecast_check.py (MIN_POINTS)";

/**
 * The sequences starreckon actually has: one snapshot per calendar month, so a
 * month is a point and there is no finer ordered history in ~/.starreckon.
 *
 * `keys` are SNAPSHOT KEYS VERBATIM, so a row here traces straight into the
 * JSON it was counted from — no prettier label stands between the two.
 *
 * A series with more than one key needs ALL of them in the SAME machine record.
 * `tokens` is input + output + cache; if cache_tokens was never written, the
 * total is not a smaller total, it is an unmeasured one, and counting the month
 * anyway would feed the model a point that nothing measured.
 */
export const SERIES = Object.freeze([
  Object.freeze({ name: "sessions", keys: Object.freeze(["sessions"]) }),
  Object.freeze({ name: "duration_hours", keys: Object.freeze(["duration_hours"]) }),
  Object.freeze({ name: "tokens", keys: Object.freeze(["input_tokens", "output_tokens", "cache_tokens"]) }),
  Object.freeze({ name: "tool_calls", keys: Object.freeze(["tool_calls"]) }),
  Object.freeze({ name: "active_days", keys: Object.freeze(["active_days"]) }),
  Object.freeze({ name: "night_hours", keys: Object.freeze(["night_hours"]) }),
]);

const MONTH_RE = /^\d{4}-\d{2}$/;
const finite = (v) => typeof v === "number" && Number.isFinite(v);

// The month a snapshot file is about. `snap.month` is the record's own
// statement and wins; the filename stem is the fallback, because writeSnapshots
// derives it from the same value. A file that carries neither is not a month
// and is REPORTED as unusable rather than counted or quietly dropped.
function monthOf(snap, file) {
  if (MONTH_RE.test(snap?.month)) return snap.month;
  const stem = file.replace(/\.json$/, "");
  return MONTH_RE.test(stem) ? stem : null;
}

/**
 * Every month on disk and which series it is a point for. Read fresh, always.
 *
 * FOUR STORE STATES, BECAUSE THEY ARE FOUR FACTS. `absent` (no snapshots
 * directory — this machine has never completed a scan), `unreadable` (it is
 * there and cannot be entered), `empty` (it is there, readable, and holds no
 * snapshot) and `present`. sources.mjs:probe draws the same four distinctions
 * for the same reason, and 28 of the 106 defects confirmed on 2026-08-16 were
 * one of these rendering as another.
 *
 * A month is a point for a series when AT LEAST ONE machine record in it
 * carries the measurement. Requiring every machine would drop a real month the
 * first time a second laptop joins the fleet.
 *
 * `superseded` records are not machines and are never counted: they are an
 * older scanner's statement about a month already counted, so counting them
 * would pad the history with restatements.
 */
export function readSnapshots(dir = SNAP_DIR) {
  const empty = { dir, files: 0, months: [], unusable: [] };
  if (!existsSync(dir)) return { ...empty, store: "absent" };
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch (e) {
    return { ...empty, store: "unreadable", why: e.code ?? "unreadable" };
  }
  const files = names.filter((f) => f.endsWith(".json"));
  if (!files.length) return { ...empty, store: "empty" };

  const byMonth = new Map();   // month -> Set(series name)
  const unusable = [];
  for (const f of files) {
    let snap;
    try {
      snap = JSON.parse(readFileSync(join(dir, f), "utf-8"));
    } catch (e) {
      // loadTimeline() swallows a corrupt snapshot, which is right for drawing
      // a star and wrong here: a month that silently drops out of the count
      // reads as history this machine does not have. Named, never skipped.
      unusable.push({ file: f, why: e.code === "EACCES" ? "unreadable" : "not valid JSON" });
      continue;
    }
    const month = monthOf(snap, f);
    if (!month) {
      unusable.push({ file: f, why: "no YYYY-MM month in the file or its name" });
      continue;
    }
    if (!byMonth.has(month)) byMonth.set(month, new Set());
    const hit = byMonth.get(month);
    for (const m of Object.values(snap?.machines ?? {})) {
      if (!m || typeof m !== "object") continue;
      for (const s of SERIES) if (s.keys.every((k) => finite(m[k]))) hit.add(s.name);
    }
  }
  const months = [...byMonth.keys()].sort()
    .map((month) => ({ month, series: byMonth.get(month) }));
  return { dir, store: "present", files: files.length, months, unusable };
}

// Calendar months between the first and last snapshot with no file of their own.
//
// REPORTED, NEVER IMPUTED AND NEVER COUNTED. forecast_check.py settles this one:
// indexing deadreckon's data by wall clock made it 95% zeros because the gaps
// were nights and weekends, so its sequences are ordered BY POSITION — "a
// session that did not happen has no slot". Same rule one unit up. The gap is
// printed so nobody reads "8 points" as a claim that the calendar is unbroken.
export function calendarGaps(months) {
  const idx = (m) => { const [y, mo] = m.split("-").map(Number); return y * 12 + (mo - 1); };
  const have = months.filter((m) => MONTH_RE.test(m)).map(idx).sort((a, b) => a - b);
  if (have.length < 2) return [];
  const set = new Set(have);
  const out = [];
  for (let i = have[0] + 1; i < have[have.length - 1]; i += 1)
    if (!set.has(i))
      out.push(`${String(Math.floor(i / 12)).padStart(4, "0")}-${String((i % 12) + 1).padStart(2, "0")}`);
  return out;
}

// ── the witness layer, which this machine does not have ──────────────────────
//
// WHERE THESE PATHS COME FROM, AND THE ONE ASSUMPTION IN THIS FILE. They mirror
// deadreckon exactly — `.venv-forecast` beside the program's own state, and a
// JSONL of bands — and they sit beside `~/.starreckon/.venv-search`, the venv
// consent.mjs:MODELS_DEST already names for the search models. They are
// EXPORTED so that the installer, when it lands, binds to these constants
// instead of restating the path: two files that must agree about where a
// directory lives are two files that will one day disagree, and the disagreement
// would surface here as a permanent false `not installed` — the exact defect
// this command exists to make visible.
export const WITNESS_VENV_BASENAME = ".venv-forecast";
export const WITNESS_RECORD_BASENAME = "forecast_record.jsonl";

export function witnessPaths(home) {
  const root = join(resolveHome(home), ".starreckon");
  return { venv: join(root, WITNESS_VENV_BASENAME), record: join(root, WITNESS_RECORD_BASENAME) };
}

/**
 * Whether a band could be produced here at all, and whether one ever was.
 *
 * `not installed` and `ran, nothing recorded` ARE NOT THE SAME ANSWER and are
 * never folded together. deadreckon's own grade step already draws this line —
 * "no forecast_record.jsonl" and "forecast_record.jsonl is empty" are two
 * different sentences there — and it draws it because a layer that was never
 * present cannot have found nothing. Nothing was looked for.
 *
 * The venv is detected the way forecast_check.py:infer() detects it: the
 * interpreter inside it. A directory with no python in it is a failed install,
 * not an installed layer.
 */
export function witnessState(home) {
  const { venv, record } = witnessPaths(home);
  const python = [join(venv, "bin", "python"), join(venv, "Scripts", "python.exe")]
    .find((p) => existsSync(p)) ?? null;
  const base = { venv, record, python, bands: null, malformed: 0 };
  if (!python) return { ...base, state: "not installed" };
  if (!existsSync(record)) return { ...base, state: "never run" };
  let text;
  try {
    text = readFileSync(record, "utf-8");
  } catch (e) {
    return { ...base, state: "unreadable", why: e.code ?? "unreadable" };
  }
  let bands = 0, malformed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { JSON.parse(line); bands += 1; } catch { malformed += 1; }
  }
  return { ...base, bands, malformed, state: bands ? "on record" : "ran, nothing recorded" };
}

/**
 * The whole answer, measured. `dir` and `home` are parameters so a test can
 * point at a fixture; the defaults are the only place the real locations are
 * named, and both come from the modules that own them.
 */
export function surveySeries({ dir = SNAP_DIR, home = undefined } = {}) {
  const store = readSnapshots(dir);
  const names = store.months.map((m) => m.month);
  const series = SERIES.map((s) => {
    const points = store.months.filter((m) => m.series.has(s.name)).length;
    return {
      name: s.name,
      keys: s.keys,
      points,
      needed: Math.max(0, MIN_POINTS - points),
      // FOUR ROW STATES, AND `no history` IS NOT `0 of 10`.
      //
      //   no snapshots     there is no history here at all, for anything. The
      //                    store is absent, empty or unreadable, and this row
      //                    is not a statement about this series.
      //   no history       months exist and NOT ONE of them measured this. More
      //                    of the same snapshots would not move it — a different
      //                    fact from a series that is simply young.
      //   not enough yet   8 of 10. Young.
      //   ready            clears the bar.
      state: names.length === 0 ? "no snapshots"
           : points === 0 ? "no history"
           : points >= MIN_POINTS ? "ready" : "not enough yet",
    };
  });
  return {
    ...store,
    monthNames: names,
    gaps: calendarGaps(names),
    minPoints: MIN_POINTS,
    series,
    witness: witnessState(home),
  };
}

const MARK = Object.freeze({
  ready: "ok",
  "not enough yet": "--",
  "no snapshots": "--",
  "no history": "!!",
});

export function renderSeries(survey, { color = true } = {}) {
  const B = color ? "\x1b[1m" : "", D = color ? "\x1b[2m" : "",
        Y = color ? "\x1b[33m" : "", R = color ? "\x1b[0m" : "";
  const { store, files, monthNames, gaps, unusable, series, minPoints, witness } = survey;
  const span = monthNames.length
    ? `${monthNames[0]} … ${monthNames[monthNames.length - 1]}`
    : "no months";
  const L = [
    `${B}series${R}  ${D}what a band could be built from · `
    + `${monthNames.length} monthly snapshot${monthNames.length === 1 ? "" : "s"} · ${span}${R}`,
    `        ${D}${maskPath(survey.dir)}${R}`,
    "",
  ];

  const w = Math.max(...series.map((s) => s.name.length));
  for (const s of series) {
    const count = `${s.points} of ${minPoints}`;
    const note =
      s.state === "ready" ? `${minPoints} points is the bar and this clears it`
      : s.state === "no snapshots" ? `no history on this machine at all — see below`
      : s.state === "no history"
        ? `${Y}no history${R} — no snapshot here carries ${s.keys.join(" + ")}`
        : `not enough yet — ${s.needed} more monthly snapshot${s.needed === 1 ? "" : "s"}`;
    L.push(`  ${s.state === "no history" ? Y : ""}${MARK[s.state]}${R}  `
         + `${s.name.padEnd(w)}  ${count.padStart(8)}  ${D}${note}${R}`);
  }

  L.push("");
  const tally = (st) => series.filter((s) => s.state === st).length;
  L.push(`  ${D}ready ${tally("ready")} · not enough yet ${tally("not enough yet")}`
       + ` · no history ${tally("no history")} · no snapshots ${tally("no snapshots")}${R}`);

  // The store's own state, which is not a series state. "no scan has ever run
  // here" and "eight months of history" are the two ends of this command, and
  // an empty table between them would say neither.
  if (store === "absent") {
    L.push(`  ${D}no snapshots directory yet — a default run writes one snapshot for the`);
    L.push(`  current month, so every series starts at 1 point after your first scan.${R}`);
  } else if (store === "empty") {
    L.push(`  ${D}the snapshots directory is here and holds no snapshot. That is an empty`);
    L.push(`  store, not a missing one, and not a scan that ran and found nothing.${R}`);
  } else if (store === "unreadable") {
    L.push(`  ${Y}the snapshots directory cannot be read (${survey.why}) — every count above`);
    L.push(`  is 0 because nothing could be opened, NOT because nothing is there.${R}`);
  }
  else if (files - unusable.length !== monthNames.length)
    L.push(`  ${D}${files} file${files === 1 ? "" : "s"} · ${monthNames.length} distinct`
         + ` month${monthNames.length === 1 ? "" : "s"} — a month is one point however many`
         + ` machines wrote it.${R}`);

  if (gaps.length) {
    L.push(`  ${D}no snapshot for ${gaps.join(", ")} — a month that was not recorded has no slot`);
    L.push(`  and nothing is imputed into it. The counts are POINTS, not calendar length.${R}`);
  }
  if (unusable.length) {
    L.push(`  ${Y}${unusable.length} file(s) could not be counted — those months are NOT points`
         + ` and NOT zeros:${R}`);
    for (const u of unusable) L.push(`      ${Y}${u.file}${R}  ${D}${u.why}${R}`);
  }

  // ── the layer, which is a different question from the history ─────────────
  L.push("");
  L.push(`  ${B}witness${R}  ${witness.state === "not installed" || witness.state === "never run" ? Y : ""}${witness.state}${R}`);
  if (witness.state === "not installed") {
    L.push(`  ${D}no forecaster environment at ${maskPath(witness.venv)}, so no band is drawn`);
    L.push(`  here at ANY point count. That is the layer being ABSENT — it is not a model`);
    L.push(`  that ran and found nothing, and it is not a series being too short. Nothing`);
    L.push(`  was looked for, so nothing was found is not a thing this machine can say.${R}`);
  } else if (witness.state === "never run") {
    L.push(`  ${D}the forecaster is installed at ${maskPath(witness.venv)} and has never run`);
    L.push(`  here — there is no ${WITNESS_RECORD_BASENAME}. Installed and never used is`);
    L.push(`  not the same as used and empty.${R}`);
  } else if (witness.state === "ran, nothing recorded") {
    L.push(`  ${D}the forecaster is installed, and its record`);
    L.push(`  ${maskPath(witness.record)}`);
    L.push(`  is present and EMPTY. It ran and recorded no band — a measured nothing, and`);
    L.push(`  the only one of these states that is actually about the model.${R}`);
  } else if (witness.state === "unreadable") {
    L.push(`  ${Y}${maskPath(witness.record)} cannot be read (${witness.why}) — the band count`);
    L.push(`  is unknown, which is not the same as none.${R}`);
  } else {
    L.push(`  ${D}${witness.bands} band(s) on record in ${maskPath(witness.record)}`
         + `${witness.malformed ? `, ${witness.malformed} unparseable line(s)` : ""}.`);
    L.push(`  Grading them is forecast_check.py's job, not this view's.${R}`);
  }

  L.push("");
  L.push(`  ${B}NO BAND IS DRAWN HERE, AND NOTHING IS BROKEN.${R}`);
  L.push(`  ${D}${minPoints} points is the bar and it is ${MIN_POINTS_SOURCE}, not a`);
  L.push(`  preference of this program: the model's short contexts are trained only down`);
  L.push(`  to ${minPoints} points and it refuses anything shorter outright:`);
  L.push(`  "a band over nothing is worse than no band". So a short count above is a`);
  L.push(`  statement about this machine's history and about nothing else. One`);
  L.push(`  snapshot per month: run starreckon monthly, or \`starreckon daemon on\` to`);
  L.push(`  have it taken on a schedule, and these counts rise on their own.${R}`);
  return L.join("\n");
}
