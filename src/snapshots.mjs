// Rolling snapshot architecture. Each run writes/updates one snapshot per
// calendar month into ~/.starreckon/snapshots/YYYY-MM.json (already redacted +
// masked — snapshots are safe to sync between machines). Velocity = the
// month-over-month trend across every snapshot present, from any machine.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { auditWrite } from "./audit.mjs";
import { computeLevels } from "./star.mjs";
import { renderStarSvg } from "./starsvg.mjs";

export const SNAP_DIR = join(homedir(), ".starreckon", "snapshots");
export const STAR_DIR = join(homedir(), ".starreckon", "stars");

// Pass { audit } so these writes land in the run log — snapshots are written on
// every default run, and an audit log that skipped them would report no writes
// at all for the most common invocation. auditWrite(null, …) is a pass-through,
// so callers that have no audit object keep working unchanged.
export function writeSnapshots(monthlyBuckets, meta = {}, { audit = null } = {}) {
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
    snap.machines[host] = { ...bucket, updated_at: new Date().toISOString(), ...meta };
    writeFileSync(file, auditWrite(audit, file, JSON.stringify(snap, null, 2)));
  }
}

// Load every snapshot (including ones imported from other machines) and merge
// per-month across machines.
export function loadTimeline() {
  if (!existsSync(SNAP_DIR)) return [];
  const months = [];
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
      merged.duration_hours = +merged.duration_hours.toFixed(1);
      merged.levels = computeLevels(merged);
      months.push(merged);
    } catch {}
  }
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
  }
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
