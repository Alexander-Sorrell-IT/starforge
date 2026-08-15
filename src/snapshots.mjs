// Rolling snapshot architecture. Each run writes/updates one snapshot per
// calendar month into ~/.starreckon/snapshots/YYYY-MM.json (already redacted +
// masked — snapshots are safe to sync between machines). Velocity = the
// month-over-month trend across every snapshot present, from any machine.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { auditWrite } from "./audit.mjs";
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
    snap.machines[host] = mergeMonth(
      snap.machines[host],
      { ...bucket, updated_at: new Date().toISOString(), ...meta },
      held
    );
    // The case the merge exists for is also the one case it cannot decide: a
    // month that came back smaller is log rotation, but a scanner fix that
    // corrects an over-count looks identical from here. ledger.mjs can tell
    // them apart because its rows carry a scanner_version; a snapshot record
    // does not. So the stored value wins and the run SAYS it won — otherwise
    // the file silently disagrees with the scan printed above it.
    if (held.length)
      console.warn(
        `starreckon: ${bucket.month} — this scan is smaller than the stored snapshot ` +
        `(${held.join(", ")}); kept the stored value. Logs age off after ~30 days; ` +
        `the snapshot is a floor and does not shrink.`
      );
    writeFileSync(file, auditWrite(audit, file, JSON.stringify(snap, null, 2)));
  }
}

// ledger.mjs:118 takes the field-wise max of two observations of one session so
// that "a partial write cannot shrink a session". This is the same rule one
// level up: a partial SCAN cannot shrink a month. Numbers take the max — per
// numeric field, per language/model key, per hour bucket — and anything else
// (month, updated_at, meta) takes the incoming value, because a re-run is the
// newer statement about those. Top-level numeric fields the stored month won
// are pushed onto `held` so the caller can report them.
function mergeMonth(stored, incoming, held) {
  if (!stored || typeof stored !== "object") return { ...incoming };
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
      out[k] = Array.from({ length: n }, (_, i) => Math.max(numOr0(v[i]), numOr0(s?.[i])));
    } else if (v && typeof v === "object" && s && typeof s === "object" && !Array.isArray(s)) {
      const keys = new Set([...Object.keys(s), ...Object.keys(v)]);
      // fromEntries, not assignment: these keys come from file extensions and
      // model names, and `out[k]["__proto__"] = 3` is a no-op that would drop
      // the count silently — the same footgun scan.mjs guards EXT_TO_LANG from.
      out[k] = Object.fromEntries(
        [...keys].map((kk) => [kk, Math.max(numOr0(s[kk]), numOr0(v[kk]))])
      );
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
  }
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
