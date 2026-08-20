// @ts-nocheck
// Turning a token-usage fleet into something the star can read.
//
// The corpus on this machine is what SURVIVED: Claude Code deletes transcripts
// after cleanupPeriodDays, so a scan can never see the work whose logs are gone.
// token-usage keeps per-machine counters that outlive them — 46,488,455,959 on
// disk against a floor of 118,688,898,254 — and until now starreckon printed that
// as a rollup and scored the star from the corpus alone.
//
// The trap is blending. The fleet knows projects, models and days; it does NOT
// know languages, tool calls or night hours. A star with three arms fleet-wide
// and two corpus-wide is a mixed-source number, and every mixed-source number in
// this codebase has eventually been wrong in a way nobody could see.
//
// So nothing is blended. The fleet gets its OWN aggregate, carrying only fields
// it genuinely measured, and the axes it cannot measure are marked rather than
// zeroed — because an unmeasured axis drawn as 0 looks like weakness, which is a
// different claim entirely.
//
// What makes this safe: every term in the scoring is a non-negative addition, so
// an axis missing a term is a LOWER BOUND, never an estimate. A fleet star is a
// floor star — the same word token-usage already uses for its own totals.
import { machineFolders, findGenerated, readJson } from "./fleet.mjs";

// Which scoring inputs a fleet totals.json can actually supply.
export const FLEET_MEASURES = Object.freeze({
  tokensM: true,
  projects: true,
  models: true,
  activeDays: true,
  streak: true,
  // Absent from token-usage entirely — not zero, ABSENT.
  langs: false,
  toolCalls: false,
  nightHours: false,
});

// A single fleet MONTH can measure even less. by_project and by_model are not
// broken down by day, so a month knows its tokens and its days and nothing else
// — and those axes must be marked unmeasured rather than reported as 0, which
// would say "no projects that month" when the truth is "not recorded per month".
export const FLEET_MEASURES_MONTH = Object.freeze({
  ...FLEET_MEASURES,
  projects: false,
  models: false,
});

const monthOf = (day) => String(day).slice(0, 7);

/**
 * Fold a readFleet() view into star-readable aggregates.
 *
 * Returns { lifetime, months: [...] }, each an agg the star already understands,
 * carrying ONLY measured fields. `available` names the inputs that are real, so
 * a card can say "not measured" instead of drawing a zero.
 */
export function fleetAggregates(tokenUsageDir) {
  // The RAW totals.json, not readFleet()'s view: that one reshapes `accounts`
  // into a count and drops by_day/by_project/by_model, which is everything the
  // star needs. Discovery is shared with readFleet rather than reimplemented,
  // so the two can never disagree about which folders are machines.
  let machines = [];
  try {
    machines = machineFolders(tokenUsageDir)
      .map((dir) => readJson(findGenerated(dir, "totals.json")))
      .filter((m) => m && Array.isArray(m.accounts));
  } catch {
    return { lifetime: null, months: [], available: FLEET_MEASURES };
  }
  if (!machines.length) return { lifetime: null, months: [], available: FLEET_MEASURES };

  // Projects and models are counted as DISTINCT across the fleet, not summed:
  // the same project worked on from two machines is one project.
  const projects = new Set();
  const models = new Set();
  const days = new Set();
  const perMonth = new Map(); // "2026-07" -> { in, out, days:Set }
  let inTok = 0;
  let outTok = 0;

  for (const m of machines) {
    for (const a of Array.isArray(m?.accounts) ? m.accounts : []) {
      for (const p of Object.keys(a?.by_project ?? {})) projects.add(p);
      for (const mo of Object.keys(a?.by_model ?? {})) models.add(mo);
      const t = a?.totals ?? {};
      inTok += Number(t.input_tokens) || 0;
      outTok += Number(t.output_tokens) || 0;
      for (const [day, v] of Object.entries(a?.by_day ?? {})) {
        days.add(day);
        const key = monthOf(day);
        const bucket = perMonth.get(key) ?? { in: 0, out: 0, days: new Set() };
        bucket.in += Number(v?.input_tokens) || 0;
        bucket.out += Number(v?.output_tokens) || 0;
        bucket.days.add(day);
        perMonth.set(key, bucket);
      }
    }
  }

  const asAgg = (over) => ({
    total_input_tokens: over.in,
    total_output_tokens: over.out,
    projects_count: over.projects,
    models: Object.fromEntries([...over.models].map((k) => [k, 1])),
    active_days: over.days.size,
    longest_streak_days: longestStreak(over.days),
    // Deliberately NOT set: languages, tool_call_counts, night_hours,
    // hour_buckets. Absent, so computeLevels reads 0 and the card can say why.
  });

  const lifetime = asAgg({ in: inTok, out: outTok, projects: projects.size, models, days });
  lifetime.months = perMonth.size;

  const months = [...perMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, b]) => {
      const agg = asAgg({
        in: b.in,
        out: b.out,
        // A month cannot claim the whole fleet's project and model variety, and
        // by_project/by_model are not broken down by day, so these are the only
        // honest values: unknown for a single month.
        projects: 0,
        models: new Set(),
        days: b.days,
      });
      agg.month = month;
      return agg;
    });

  return { lifetime, months, available: FLEET_MEASURES };
}

/** Longest run of consecutive calendar days in a set of "YYYY-MM-DD". */
export function longestStreak(daySet) {
  const days = [...(daySet ?? [])].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!days.length) return 0;
  const dayNum = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    // UTC on purpose: this is calendar arithmetic on date STRINGS that already
    // carry no timezone, and Date.parse of a bare date is UTC anyway. Using the
    // local constructor here is what broke the streak walk in profile.mjs.
    return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
  };
  let best = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    run = dayNum(days[i]) - dayNum(days[i - 1]) === 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}
