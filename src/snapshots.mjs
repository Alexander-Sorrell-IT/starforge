// Rolling snapshot architecture. Each run writes/updates one snapshot per
// calendar month into ~/.starforge/snapshots/YYYY-MM.json (already redacted +
// masked — snapshots are safe to sync between machines). Velocity = the
// month-over-month trend across every snapshot present, from any machine.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export const SNAP_DIR = join(homedir(), ".starforge", "snapshots");

export function writeSnapshots(monthlyBuckets, meta = {}) {
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
    writeFileSync(file, JSON.stringify(snap, null, 2));
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
        machines: Object.keys(snap.machines ?? {}),
      };
      for (const m of Object.values(snap.machines ?? {})) {
        merged.sessions += m.sessions ?? 0;
        merged.duration_hours += m.duration_hours ?? 0;
        merged.input_tokens += m.input_tokens ?? 0;
        merged.output_tokens += m.output_tokens ?? 0;
        merged.cache_tokens += m.cache_tokens ?? 0;
      }
      merged.duration_hours = +merged.duration_hours.toFixed(1);
      months.push(merged);
    } catch {}
  }
  return months;
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
