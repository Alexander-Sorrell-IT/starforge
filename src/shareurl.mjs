// shareurl.mjs — encode star results into a fragment URL for GitHub Pages.
//
// The URL carries the results in the hash fragment so nothing is sent to any
// server — the GitHub Pages page reads window.location.hash client-side and
// renders the star from those numbers. No upload, no account, works for every
// user of the published package.
//
// URL shape:
//   https://alexander-sorrell-it.github.io/starreckon/#s=23.1&g=MASTERWORK&
//     a=DEEP_BUILDER&v=4.8,4.6,4.5,4.7,4.4&ss=142&h=318&d=89&k=21&n=Name
//
// Parameters:
//   s   total skill points (1 decimal)
//   g   tier name (MASTERWORK/TEMPERED/FORGED/CAST/RAW)
//   a   archetype name
//   v   axis levels, comma-separated, 1 decimal each (AXES order)
//   ss  total sessions (integer)
//   h   active hours rounded (integer)
//   d   active days (integer)
//   k   longest streak days (integer, omitted if 0)
//   n   display name (optional, from --name)
//
// The fragment is never sent to the server — it stays in the browser.
// Verified by: the URL is built entirely from local scan results; no outbound
// request is made by this module. The GitHub Pages page is a static file.

import { AXES, ARMS, MAX_LEVEL } from "./starsvg.mjs";
import { archetype, rating } from "./archetype.mjs";

export const PAGES_BASE = "https://alexander-sorrell-it.github.io/starreckon/";

/**
 * Build the share URL for a set of scan results.
 * Returns a string URL, or null if the inputs are missing.
 *
 * levels  — array of ARMS numbers (0..MAX_LEVEL)
 * agg     — the finalize() aggregate object
 * name    — optional display name string
 */
export function buildShareUrl(levels, agg, name) {
  if (!levels || !levels.length) return null;
  const lv = levels.map((v) => Math.min(MAX_LEVEL, Math.max(0, +v || 0)));
  const total = +lv.reduce((a, b) => a + b, 0).toFixed(1);
  const tier = rating(total);
  const arch = archetype(lv);

  const params = new URLSearchParams();
  params.set("s", total.toFixed(1));
  params.set("g", tier);
  params.set("a", arch.name.replace(/\s+/g, "_"));
  params.set("v", lv.map((x) => x.toFixed(1)).join(","));
  if (agg) {
    const a = agg;
    params.set("ss", String(a.total_sessions ?? 0));
    params.set("h", String(Math.round(a.total_duration_hours ?? 0)));
    params.set("d", String(a.active_days ?? 0));
    if (a.longest_streak_days) params.set("k", String(a.longest_streak_days));
  }
  if (name && typeof name === "string" && name.trim()) {
    params.set("n", name.trim().slice(0, 32));
  }
  return PAGES_BASE + "#" + params.toString();
}

/**
 * Parse a share URL fragment back into an object.
 * Used by the GitHub Pages index.html (via inline script, not this module).
 * Exported here so it can be unit-tested.
 */
export function parseShareUrl(url) {
  try {
    const hash = url.includes("#") ? url.split("#")[1] : url;
    const p = new URLSearchParams(hash);
    const raw = p.get("v");
    if (!raw) return null;
    const v = raw.split(",").map(Number).filter((n) => !isNaN(n));
    if (!v.length) return null;
    return {
      total:    parseFloat(p.get("s") ?? "0"),
      tier:     p.get("g") ?? "",
      archetype: (p.get("a") ?? "").replace(/_/g, " "),
      levels:   v,
      sessions: parseInt(p.get("ss") ?? "0", 10),
      hours:    parseInt(p.get("h") ?? "0", 10),
      days:     parseInt(p.get("d") ?? "0", 10),
      streak:   parseInt(p.get("k") ?? "0", 10),
      name:     p.get("n") ?? null,
    };
  } catch {
    return null;
  }
}
