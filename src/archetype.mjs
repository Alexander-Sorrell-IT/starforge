// Who the star says you are — a tier, and an archetype read off its SHAPE.
//
// This exists for two reasons.
//
// The first is drift. The rating formula was written out three times (card.mjs,
// and twice in wrapped.mjs) with the literal thresholds copied each time, and it
// was calibrated for the old 25-point star. When MAX_LEVEL went 5 -> 7 the
// denominator became 35 and not one of the three copies moved, so "S+" started
// at 22/35 — 63% — and almost every run came back S+. A rating everyone gets is
// not a rating. One module, imported everywhere, thresholds derived from the
// constant rather than typed as numbers.
//
// The second is the archetype. The obvious model to copy grades you against
// other people ("top 1% of 3,756 users"), and starforge structurally cannot do
// that: no account, no upload, no server that has ever seen anyone else's data.
// The wrapped literally makes a point of it. So the archetype is read off YOUR
// OWN shape instead — which two arms are longest — and it is a description, not
// a ranking. It says what kind of work this is, not where it places.
import { ARMS, MAX_LEVEL, AXES } from "./starsvg.mjs";

const MAX_TOTAL = ARMS * MAX_LEVEL;

// Tiers are stated as "the average arm, out of MAX_LEVEL", so they track the
// constant instead of being re-typed whenever the star is rescaled.
const TIERS = [
  { min: 6.0, name: "S+" },
  { min: 5.0, name: "S" },
  { min: 4.0, name: "A" },
  { min: 2.5, name: "B" },
  { min: 0, name: "C" },
];

export function rating(total) {
  const avgArm = (Number(total) || 0) / ARMS;
  return TIERS.find((t) => avgArm >= t.min).name;
}

// The archetype is keyed by the two longest arms, unordered. Ten pairs for five
// axes, plus the case where nothing stands out.
//
// Names describe the WORK, not the worker's worth: there is no bad shape here,
// and a short arm is an axis you spent less time on, not a deficiency. That is
// also why none of these are ranked against each other.
const AX = { FIRST: 0, ENGINEERING: 1, CODING: 2, OUTSIDE: 3, TENACITY: 4 };

const PAIRS = [
  { pair: [AX.FIRST, AX.ENGINEERING], name: "The Systems Architect", blurb: "you reason from the ground up, then build the structure to hold it" },
  { pair: [AX.FIRST, AX.CODING], name: "The Deep Builder", blurb: "long problems, taken apart properly, then written down in code" },
  { pair: [AX.FIRST, AX.OUTSIDE], name: "The Theorist", blurb: "you go to first principles and come back with the unusual answer" },
  { pair: [AX.FIRST, AX.TENACITY], name: "The Excavator", blurb: "you dig at hard problems and you do not put them down" },
  { pair: [AX.ENGINEERING, AX.CODING], name: "The Shipper", blurb: "breadth of systems, volume of code — things get finished" },
  { pair: [AX.ENGINEERING, AX.OUTSIDE], name: "The Integrator", blurb: "many systems, odd hours, and the seams between them are yours" },
  { pair: [AX.ENGINEERING, AX.TENACITY], name: "The Foundry", blurb: "wide surface area held together by showing up every day" },
  { pair: [AX.CODING, AX.OUTSIDE], name: "The Prototyper", blurb: "you build fast, at strange hours, and find out by making it" },
  { pair: [AX.CODING, AX.TENACITY], name: "The Machinist", blurb: "steady output, day after day — the compounding kind" },
  { pair: [AX.OUTSIDE, AX.TENACITY], name: "The Night Shift", blurb: "the hours nobody schedules, kept up longer than anyone expects" },
];

const BALANCED = {
  name: "The Generalist",
  blurb: "no arm dominates — you work across all five rather than down one",
};

// "Balanced" must be a real measurement, not a fallback for ties. If the
// longest and shortest arms are close, no pair is meaningfully dominant and
// naming one would be reading noise.
const BALANCE_BAND = 1.5;

export function archetype(levels) {
  const lv = Array.from({ length: ARMS }, (_, i) => Number(levels?.[i]) || 0);
  const total = lv.reduce((a, b) => a + b, 0);
  if (total <= 0) return { ...BALANCED, name: "Unforged", blurb: "nothing scanned yet — run it against a machine you actually work on", top: [] };

  const spread = Math.max(...lv) - Math.min(...lv);
  const order = lv
    .map((v, i) => ({ v, i }))
    // Ties break by axis order, never by array luck: two runs of the same data
    // must name the same archetype.
    .sort((a, b) => b.v - a.v || a.i - b.i);
  const top = [order[0].i, order[1].i];

  if (spread < BALANCE_BAND) return { ...BALANCED, top };

  const key = [...top].sort((a, b) => a - b).join(",");
  const hit = PAIRS.find((p) => [...p.pair].sort((a, b) => a - b).join(",") === key);
  return { ...(hit ?? BALANCED), top };
}

// One line of plain fact under the archetype, chosen from what the run actually
// measured. No superlatives that the data does not support, and nothing random:
// the same corpus must produce the same line every time.
export function signature(rawAgg) {
  // A default parameter only fires on `undefined`, and the callers pass whatever
  // they were handed — `signature(null)` blew up every card that used it. Cards
  // must never throw: a crash here costs someone a completed scan.
  const agg = rawAgg && typeof rawAgg === "object" && !Array.isArray(rawAgg) ? rawAgg : {};
  const nights = Math.round(Number(agg.night_hours) || 0);
  const streak = Number(agg.longest_streak_days) || 0;
  const days = Number(agg.active_days) || 0;
  const hours = Math.round(Number(agg.total_duration_hours ?? agg.duration_hours) || 0);
  if (streak >= 30) return `${streak} days without a gap — that is the whole story`;
  if (nights >= 100) return `${nights} hours after midnight, which is a choice you kept making`;
  if (days >= 60) return `${days} active days — showing up is most of it`;
  if (hours >= 200) return `${hours} hours of active time, gaps over 15 minutes not counted`;
  if (days > 0) return `${days} active day${days === 1 ? "" : "s"} on record so far`;
  return "not enough history yet — come back after a few sessions";
}

export { MAX_TOTAL, AXES };
