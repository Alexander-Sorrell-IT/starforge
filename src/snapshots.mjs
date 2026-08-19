// Rolling snapshot architecture. Each run writes/updates one snapshot per
// calendar month into ~/.starreckon/snapshots/YYYY-MM.json (already redacted +
// masked — snapshots are safe to sync between machines). Velocity = the
// month-over-month trend across every snapshot present, from any machine.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { auditWrite } from "./audit.mjs";
import { scannerVersion } from "./scanners.mjs";
import { computeLevels } from "./star.mjs";
import { renderStarSvg } from "./starsvg.mjs";

// os.homedir() returns $HOME verbatim, and $HOME can arrive as a literal "~"
// from a wrapper that exported an unexpanded path — an npx run died here on
// `mkdir '~/.starreckon/snapshots'` after the star had already rendered. The
// silent variant is worse than the crash: where cwd is writable the same path
// creates a literal "~" directory beside wherever you were standing, and
// loadTimeline() never finds those snapshots again. os.userInfo().homedir reads
// the passwd entry and ignores $HOME, so it is the one source that cannot come
// back with a tilde in it.
const HOME = (() => {
  const h = homedir();
  if (!h.startsWith("~")) return h;
  let pw = "";
  try { pw = userInfo().homedir ?? ""; } catch {}
  return pw && !pw.startsWith("~") ? join(pw, h.slice(1)) : null;
})();

export const SNAP_DIR = join(HOME ?? resolve(homedir()), ".starreckon", "snapshots");
export const STAR_DIR = join(HOME ?? resolve(homedir()), ".starreckon", "stars");

// $HOME is a tilde AND there is no passwd entry to expand it against (a
// container running as an unmapped uid). resolve() at least makes the paths
// absolute instead of relative-to-cwd, but the location is then a guess, and a
// guess that writes snapshots somewhere loadTimeline will not look must say so
// rather than appear to have worked. Once per process, not once per month.
let warnedHome = false;
function warnUnresolvedHome() {
  if (warnedHome) return;
  warnedHome = true;
  console.warn(
    `starreckon: $HOME is ${JSON.stringify(homedir())} and no passwd entry can expand it — ` +
    `writing snapshots to ${SNAP_DIR}, which may not be your home directory.`
  );
}

// Pass { audit } so these writes land in the run log — snapshots are written on
// every default run, and an audit log that skipped them would report no writes
// at all for the most common invocation. auditWrite(null, …) is a pass-through,
// so callers that have no audit object keep working unchanged.
export function writeSnapshots(monthlyBuckets, meta = {}, { audit = null } = {}) {
  if (!HOME) warnUnresolvedHome();
  mkdirSync(SNAP_DIR, { recursive: true });
  const host = hostname();
  for (const bucket of monthlyBuckets) {
    const file = join(SNAP_DIR, `${bucket.month}.json`);
    let snap = { month: bucket.month, machines: {} };
    if (existsSync(file)) {
      try {
        snap = JSON.parse(readFileSync(file, "utf-8"));
      } catch {}
    }
    snap.machines ??= {};
    // Assigning the scan straight in REPLACED the stored month, which threw
    // away exactly what this file exists to keep: one month re-scanned after
    // its logs aged off went 18,000,000 -> 3,600,000 input tokens, permanently.
    // Merge instead, field-wise max.
    const held = [];
    const superseded = [];
    snap.machines[host] = mergeMonth(
      snap.machines[host],
      {
        ...bucket,
        updated_at: new Date().toISOString(),
        scanner_version: scannerVersion(),
        ...meta,
      },
      held,
      superseded
    );
    // The case the merge exists for used to be the one case it could not
    // decide: a month that came back smaller is log rotation, but a scanner fix
    // that corrects an over-count looked identical from here. It is decidable
    // now, by the rule ledger.mjs has always used one level down — the record
    // carries the fingerprint of the code that produced it, so "same code, so a
    // smaller number is rotation" and "different code, so this is a restatement"
    // are different questions with different answers. Either way the run SAYS
    // what it did, rather than the file quietly disagreeing with the scan
    // printed above it.
    if (held.length)
      console.warn(
        `starreckon: ${bucket.month} — this scan is smaller than the stored snapshot ` +
        `(${held.join(", ")}); kept the stored value. Same scanner, so a smaller ` +
        `number is logs ageing off after ~30 days; the snapshot is a floor and does not shrink.`
      );
    if (superseded.length)
      console.warn(
        `starreckon: ${bucket.month} — the stored snapshot was written by ${superseded.join(", ")}, ` +
        `so its numbers are a different scanner's statement, not a floor under this one. ` +
        `Took this scan and kept the old record under "superseded" — nothing is deleted.`
      );
    writeFileSync(file, auditWrite(audit, file, JSON.stringify(snap, null, 2)));
  }
}

// ledger.mjs:160 takes the field-wise max of two observations of one session so
// that "a partial write cannot shrink a session". This is the same rule one
// level up: a partial SCAN cannot shrink a month. Numbers take the max — per
// numeric field, per language/model key, per hour bucket — and anything else
// (month, updated_at, meta) takes the incoming value, because a re-run is the
// newer statement about those. Numeric fields the stored month won are pushed
// onto `held` so the caller can report them — every branch, see below.
//
// THE FLOOR ONLY APPLIES BETWEEN TWO RUNS OF THE SAME CODE.
//
// Math.max answers "which observation saw more of the same thing", and that is
// only the question when both observations were produced by the same scanner.
// Across a scanner change it is the wrong question, and answering it anyway is
// how a corrected over-count becomes permanent: the correction is smaller by
// construction, so it loses the max, forever, in every future run. Measured on
// this machine — the stored 2026-07 record claimed 16,636 sessions against a
// true 132, and no scanner fix could ever have dislodged it.
//
// So versions decide first, exactly as ledger.mjs:132-163 does one level down
// (with the caveat ledger.mjs now spells out: rows whose version could not be
// determined share a bucket with nothing, so they supersede instead of maxing):
//
//   same version        -> floor. A smaller number is logs ageing off.
//   different version   -> restatement. The newer scanner's number wins.
//   either absent       -> NOT COMPARABLE, which is not the same as matching
//                          (scanners.mjs:82-89 states that rule for this exact
//                          field). An unversioned record cannot outrank one
//                          that names its producer, so the scan wins.
//
// Nothing is discarded when a record is superseded: the whole old record is
// kept under `superseded` so any number that was ever published stays on disk
// and can be read back or rolled back.
function sameScanner(stored, incoming) {
  const s = stored?.scanner_version;
  const i = incoming?.scanner_version;
  // Two nulls are two unknowns, not a match.
  if (typeof s !== "string" || typeof i !== "string" || !s || !i) return false;
  return s === i;
}

function mergeMonth(stored, incoming, held, superseded = []) {
  if (!stored || typeof stored !== "object") return { ...incoming };

  if (!sameScanner(stored, incoming)) {
    superseded.push(
      typeof stored.scanner_version === "string" && stored.scanner_version
        ? `scanner ${stored.scanner_version}`
        : "a scanner that recorded no version"
    );
    // Stored-only keys still survive, for the same reason they do below.
    // `superseded` is one level deep on purpose: keeping the previous record
    // preserves what was published, keeping a chain of them grows without
    // bound in a file that is written on every default run.
    const { superseded: _prior, ...priorRecord } = stored;
    return { ...priorRecord, ...incoming, superseded: priorRecord };
  }

  // Stored-only keys survive: a field this scan did not produce at all is not
  // evidence that the field is now zero.
  const out = { ...stored, ...incoming };
  for (const [k, v] of Object.entries(incoming)) {
    const s = stored[k];
    if (typeof v === "number" && typeof s === "number") {
      if (s > v) held.push(k);
      out[k] = Math.max(s, v);
    } else if (Array.isArray(v)) {
      const n = Math.max(v.length, Array.isArray(s) ? s.length : 0);
      // Held silently until 2026-08-16: `held` was pushed only in the number
      // branch above, so hour_buckets (array) and languages/models (object)
      // kept the stored value with no report at all. A held value and an
      // agreed value rendered identically, which is the four-states defect
      // inside the snapshot writer itself.
      let anyHeld = false;
      out[k] = Array.from({ length: n }, (_, i) => {
        const sv = numOr0(s?.[i]), iv = numOr0(v[i]);
        if (sv > iv) anyHeld = true;
        return Math.max(sv, iv);
      });
      if (anyHeld) held.push(k);
    } else if (v && typeof v === "object" && s && typeof s === "object" && !Array.isArray(s)) {
      const keys = new Set([...Object.keys(s), ...Object.keys(v)]);
      let anyHeld = false;
      // fromEntries, not assignment: these keys come from file extensions and
      // model names, and `out[k]["__proto__"] = 3` is a no-op that would drop
      // the count silently — the same footgun scan.mjs guards EXT_TO_LANG from.
      out[k] = Object.fromEntries(
        [...keys].map((kk) => {
          const sv = numOr0(s[kk]), iv = numOr0(v[kk]);
          if (sv > iv) anyHeld = true;
          return [kk, Math.max(sv, iv)];
        })
      );
      if (anyHeld) held.push(k);
    }
  }
  return out;
}

// ledger.mjs's intOr0 rejects non-integers; a monthly bucket carries
// duration_hours (50.5), so this keeps finite floats and zeroes only
// null/undefined/NaN/non-numeric.
function numOr0(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Snapshots written before monthly buckets carried night_hours hold no night
// measurement, and there is nothing on disk to rebuild one from: hour_buckets
// is a per-EVENT histogram, and star.mjs's old fallback summing its first six
// slots priced log LINES as hours (measured: 137.3 real night hours drawn as
// 450,107). So those months are UNMEASURED, not zero and not 450,107 — and a
// run that quietly drops a whole axis input for most of its history has to say
// which months. Once per process, not once per load. Months whose logs are
// still on disk regain the key on the next scan; older ones never will.
let warnedNights = false;
function warnUnmeasuredNights(months) {
  if (warnedNights || months.length === 0) return;
  warnedNights = true;
  console.warn(
    `starreckon: no night_hours in ${months.length} snapshot month(s) (${months.join(", ")}) — ` +
    `written before the key existed. Night hours are UNMEASURED there, not 0: they add nothing to ` +
    `OUTSIDE THE BOX, and lifetime night hours are a floor. They cannot be recomputed from the ` +
    `stored hour_buckets, which count events, not hours. Re-scan restores any month whose logs survive.`
  );
}

// Load every snapshot (including ones imported from other machines) and merge
// per-month across machines.
export function loadTimeline() {
  if (!existsSync(SNAP_DIR)) return [];
  const months = [];
  const unmeasuredNights = [];
  for (const f of readdirSync(SNAP_DIR).sort()) {
    if (!f.endsWith(".json")) continue;
    try {
      const snap = JSON.parse(readFileSync(join(SNAP_DIR, f), "utf-8"));
      const merged = {
        month: snap.month,
        sessions: 0,
        duration_hours: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_tokens: 0,
        tool_calls: 0,
        languages: {},
        models: {},
        projects_count: 0,
        top_projects: {},   // name -> max sessions seen across machines, collapsed to array below
        hour_buckets: new Array(24).fill(0),
        active_days: 0,
        longest_streak_days: 0,
        machines: Object.keys(snap.machines ?? {}),
      };
      for (const m of Object.values(snap.machines ?? {})) {
        merged.sessions += m.sessions ?? 0;
        merged.duration_hours += m.duration_hours ?? 0;
        merged.input_tokens += m.input_tokens ?? 0;
        merged.output_tokens += m.output_tokens ?? 0;
        merged.cache_tokens += m.cache_tokens ?? 0;
        // Additive across machines: work done on one laptop does not overlap
        // work done on another.
        merged.tool_calls += m.tool_calls ?? 0;
        // Projects are the exception to that, and summing them was wrong: the
        // normal reason a repo appears on two machines is that it is the SAME
        // repo, synced. Adding gave a laptop+desktop pair with three shared
        // projects a projects_count of 6 and a longer ENGINEERING arm for no
        // additional work. Only the names could tell overlap from breadth, and
        // snapshots deliberately do not carry names — so this takes the largest
        // single machine's count, a floor rather than an invented total.
        merged.projects_count = Math.max(merged.projects_count, m.projects_count ?? 0);
        // top_projects: union across machines, keeping the highest session count
        // per name. Same reason as projects_count — the same repo on two machines
        // is one project, so we merge by name, not sum.
        for (const p of (m.top_projects ?? [])) {
          if (p?.name) {
            merged.top_projects[p.name] = Math.max(
              merged.top_projects[p.name] ?? 0, p.sessions ?? 0
            );
          }
        }
        for (const [k, v] of Object.entries(m.languages ?? {}))
          merged.languages[k] = (merged.languages[k] ?? 0) + v;
        for (const [k, v] of Object.entries(m.models ?? {}))
          merged.models[k] = (merged.models[k] ?? 0) + v;
        const hb = m.hour_buckets ?? [];
        for (let h = 0; h < 24; h++) merged.hour_buckets[h] += hb[h] ?? 0;
        // NOT additive: a calendar day you worked on two machines is one day,
        // and two 4-day streaks on two machines are not an 8-day streak. Max is
        // a floor, not a total — the union of the day sets is not recoverable
        // from the counts each machine stored, and inventing it would overstate
        // the one axis (TENACITY) that is meant to be hard to inflate.
        merged.active_days = Math.max(merged.active_days, m.active_days ?? 0);
        merged.longest_streak_days = Math.max(
          merged.longest_streak_days,
          m.longest_streak_days ?? 0
        );
      }
      // Night hours are distinct night MINUTES / 60, so they are a wall-clock
      // fact and NOT additive the way hour_buckets are: the 02:00 minute you
      // spent driving two machines is one minute of night, and summing reports
      // two. Same rule as active_days for the same reason — max is a floor, and
      // the union of the minute sets is not recoverable from the hours each
      // machine stored.
      //
      // Set only when some machine actually measured it. Left ABSENT otherwise,
      // so computeLevels scores the term as 0 and explainLevels marks it
      // not-measured; writing 0 here would make a pre-key snapshot indis-
      // tinguishable from a month somebody worked entirely in daylight.
      const nights = Object.values(snap.machines ?? {})
        .map((m) => m.night_hours)
        .filter((v) => typeof v === "number" && Number.isFinite(v));
      if (nights.length) merged.night_hours = +Math.max(...nights).toFixed(1);
      else unmeasuredNights.push(merged.month);
      // Collapse the temp object back to a sorted array before publishing.
      merged.top_projects = Object.entries(merged.top_projects)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, sessions]) => ({ name, sessions }));
      merged.duration_hours = +merged.duration_hours.toFixed(1);
      merged.levels = computeLevels(merged);
      months.push(merged);
    } catch {}
  }
  warnUnmeasuredNights(unmeasuredNights);
  return months;
}

// The whole timeline folded into one aggregate, for the LIFETIME star.
//
// WHY THIS EXISTS AND WHY IT IS NOT THE SCAN
//
// The scan can only see logs that are still on disk, and AI-coding logs age off
// after ~30 days. So a star drawn from the scan is not a lifetime — it is "the
// last month or so", and it silently SHRINKS as older work is deleted. The
// snapshots outlive the logs, so they are the only durable record of what came
// before. Lifetime therefore accumulates from the timeline, not from the scan.
//
// On the first ever run the timeline holds exactly one month — the one just
// written — so lifetime and monthly are the same star. That is correct, not a
// bug: with no history yet there is nothing for lifetime to add.
//
// The merge rules are NOT the same as loadTimeline's cross-machine rules, and
// the difference is the calendar:
//
//   active_days   SUMS here. Two machines can share a Tuesday; two MONTHS
//                 cannot share a day, so max would throw away every month but
//                 the busiest.
//   streak        still MAX, and still a floor: a run that crosses a month
//                 boundary is recorded in both months and recoverable from
//                 neither, so the true streak can only be longer than this.
//   projects      still MAX, for the reason loadTimeline gives — the normal
//                 reason a project appears in two months is that it is the
//                 same project, and the names are deliberately not stored.
//   night_hours   SUMS, like active_days and for the same reason: two months
//                 cannot share a minute. Months that never measured it are
//                 skipped rather than counted as 0, which makes the lifetime
//                 figure a FLOOR — loadTimeline names those months on stderr.
export function lifetimeFromTimeline(timeline) {
  const life = {
    month: "lifetime",
    months: timeline.length,
    from: timeline[0]?.month ?? null,
    to: timeline[timeline.length - 1]?.month ?? null,
    sessions: 0,
    duration_hours: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_tokens: 0,
    tool_calls: 0,
    languages: {},
    models: {},
    projects_count: 0,
    // Temp object for accumulation — collapsed to array at the end.
    // top_projects across months: a project that appeared in any month is
    // kept; session count is the max seen in any one month (not a sum,
    // because the same project across 12 months is still one project).
    _topProjectsMap: {},
    hour_buckets: new Array(24).fill(0),
    active_days: 0,
    longest_streak_days: 0,
  };
  for (const m of timeline) {
    life.sessions += m.sessions ?? 0;
    life.duration_hours += m.duration_hours ?? 0;
    life.input_tokens += m.input_tokens ?? 0;
    life.output_tokens += m.output_tokens ?? 0;
    life.cache_tokens += m.cache_tokens ?? 0;
    life.tool_calls += m.tool_calls ?? 0;
    life.active_days += m.active_days ?? 0;
    life.projects_count = Math.max(life.projects_count, m.projects_count ?? 0);
    life.longest_streak_days = Math.max(
      life.longest_streak_days,
      m.longest_streak_days ?? 0
    );
    for (const [k, v] of Object.entries(m.languages ?? {}))
      life.languages[k] = (life.languages[k] ?? 0) + v;
    for (const [k, v] of Object.entries(m.models ?? {}))
      life.models[k] = (life.models[k] ?? 0) + v;
    const hb = m.hour_buckets ?? [];
    for (let h = 0; h < 24; h++) life.hour_buckets[h] += hb[h] ?? 0;
    if (typeof m.night_hours === "number" && Number.isFinite(m.night_hours))
      life.night_hours = (life.night_hours ?? 0) + m.night_hours;
    for (const p of (m.top_projects ?? [])) {
      if (p?.name)
        life._topProjectsMap[p.name] = Math.max(
          life._topProjectsMap[p.name] ?? 0, p.sessions ?? 0
        );
    }
  }
  // Collapse temp accumulator and remove it from the public object.
  life.top_projects = Object.entries(life._topProjectsMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, sessions]) => ({ name, sessions }));
  delete life._topProjectsMap;
  if (life.night_hours != null) life.night_hours = +life.night_hours.toFixed(1);
  life.duration_hours = +life.duration_hours.toFixed(1);
  life.levels = computeLevels(life);
  return life;
}

// One SVG star per month, written next to the snapshots. Every month gets its
// own silhouette computed only from that month's activity, so laying them out
// in order shows the shape of the work changing — which is the thing a single
// lifetime-average star cannot show. Returns the paths written.
export function writeSnapshotStars(timeline, { audit = null, limit = 36 } = {}) {
  if (!timeline.length) return [];
  if (!HOME) warnUnresolvedHome();
  mkdirSync(STAR_DIR, { recursive: true });
  const written = [];
  for (const m of timeline.slice(-limit)) {
    const levels = m.levels ?? computeLevels(m);
    const svg = renderStarSvg(levels, {
      size: 300,
      labels: false,
      animate: true,
      footer: m.month,
      title: `skill star — ${m.month}`,
    });
    const file = join(STAR_DIR, `${m.month}.svg`);
    writeFileSync(file, auditWrite(audit, file, svg));
    written.push(file);
  }
  return written;
}

// Simple velocity profile: last vs previous month + linear trend over the run.
export function velocity(timeline) {
  if (timeline.length === 0) return null;
  const last = timeline[timeline.length - 1];
  const prev = timeline.length > 1 ? timeline[timeline.length - 2] : null;
  const pct = (a, b) => (b > 0 ? +(((a - b) / b) * 100).toFixed(0) : null);
  const hours = timeline.map((t) => t.duration_hours);
  const n = hours.length;
  let slope = 0;
  if (n > 1) {
    const xm = (n - 1) / 2;
    const ym = hours.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    hours.forEach((y, x) => {
      num += (x - xm) * (y - ym);
      den += (x - xm) ** 2;
    });
    slope = den > 0 ? +(num / den).toFixed(2) : 0;
  }
  return {
    months_tracked: n,
    latest_month: last.month,
    hours_mom_pct: prev ? pct(last.duration_hours, prev.duration_hours) : null,
    sessions_mom_pct: prev ? pct(last.sessions, prev.sessions) : null,
    tokens_mom_pct: prev
      ? pct(
          last.input_tokens + last.output_tokens,
          prev.input_tokens + prev.output_tokens
        )
      : null,
    hours_trend_per_month: slope,
  };
}
