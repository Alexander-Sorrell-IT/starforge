// The wrapped: a paced story, one card at a time, computed entirely on this
// machine.
//
// The format is deliberately the one people already recognise from hosted
// wrapped tools — boxed cards, big numbers, bars, a quip picked by threshold.
// What is NOT borrowed is where the numbers come from. A hosted wrapped uploads
// your logs and fills its cards from a server: the percentiles ("top 17% of
// users") and the prose narration are things your machine cannot know alone.
// So this file does not pretend to have them. It benchmarks you against YOUR
// OWN history instead — which is the comparison you can actually verify, and
// the only honest one for a tool that never sees anyone else's data.
//
// Three cards here have no counterpart in a hosted wrapped, and they are the
// reason this tool exists: the skill star, the month-by-month silhouette, and
// the card that accounts for what left the machine.

import { AXES, ARMS, MAX_LEVEL, starPoints, clampLevel } from "./starsvg.mjs";
import { rating, archetype, signature } from "./archetype.mjs";
import { emblem } from "./emblem.mjs";
import { explainLevels, computeLevels } from "./star.mjs";
import { FLEET_MEASURES, FLEET_MEASURES_MONTH } from "./fleetstar.mjs";
import { qrToTerminal } from "./qr.mjs";
import { readContact, contactLines } from "./contact.mjs";
import { buildShareUrl, PAGES_BASE } from "./shareurl.mjs";

const R = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const I = "\x1b[3m";
const CY = "\x1b[38;5;51m";
const WH = "\x1b[97m";
const DIMC = "\x1b[38;5;38m";

const W = 60; // inner width of every card

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// NO_COLOR is a standard, and every OTHER renderer here honours it — the star,
// the emblem headings, the receipt. The cards did not: they build their colour
// into the strings themselves, so `--no-pace > wrapped.txt` produced a file of
// escape codes and every capture had to be piped through sed. Read at call time
// rather than at import, so a test can set it per case.
const plain = () => Boolean(process.env.NO_COLOR);
const vis = (s) => strip(s).length;

function pad(s, width) {
  const n = width - vis(s);
  return s + " ".repeat(Math.max(0, n));
}

/** A rounded box, sized to W, that tolerates ANSI inside its lines. */
export function box(lines, { color = CY } = {}) {
  const out = [];
  // Strip INSIDE the box, not at the call sites: cards are built by a dozen
  // functions and printed from three places, and a rule enforced at the edge is
  // a rule that holds for whatever gets added next.
  if (plain()) {
    color = "";
    lines = lines.map((l) => strip(String(l)));
  }
  out.push(plain() ? `╭${"─".repeat(W + 2)}╮` : `${color}╭${"─".repeat(W + 2)}╮${R}`);
  for (const line of lines) {
    // A line longer than the box would break the frame, so clip on VISIBLE
    // width while carrying the escape sequences through. The first version bailed
    // out of the loop at the first "\x1b", which meant any over-long line that
    // began with a colour code was clipped to nothing — it silently deleted a
    // whole line of copy from a card rather than trimming it.
    let l = line;
    if (vis(l) > W) {
      let acc = "", count = 0, i = 0;
      while (i < l.length && count < W) {
        if (l[i] === "\x1b") {
          const end = l.indexOf("m", i);
          if (end === -1) break;
          acc += l.slice(i, end + 1);
          i = end + 1;
          continue;
        }
        acc += l[i];
        count++;
        i++;
      }
      // No reset when there was no colour: this runs AFTER the plain() strip
      // above, so appending R here put an escape back into every clipped line.
      l = acc + (plain() ? "" : R);
    }
    out.push(plain() ? `│ ${pad(l, W)} │` : `${color}│${R} ${pad(l, W)} ${color}│${R}`);
  }
  out.push(plain() ? `╰${"─".repeat(W + 2)}╯` : `${color}╰${"─".repeat(W + 2)}╯${R}`);
  return out.join("\n");
}

export function bar(value, max, width = 20, filled = "█", empty = "░") {
  const n = max > 0 ? Math.round((Math.max(0, value) / max) * width) : 0;
  return CY + filled.repeat(Math.min(width, n)) + D + empty.repeat(Math.max(0, width - n)) + R;
}

const fmt = (n) => (Number(n) || 0).toLocaleString("en-US");

function human(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}

export function wrapWords(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > width) { lines.push(line); line = w; }
    else line = line ? line + " " + w : w;
  }
  if (line) lines.push(line);
  return lines;
}

// Drops conditional lines (null/false) but KEEPS "" — an empty string is a
// deliberate spacer, and filter(Boolean) silently ate every one of them.
const keep = (l) => l !== null && l !== undefined && l !== false;

// Every card normalises its OWN inputs rather than trusting whoever called it.
// A fuzz over hostile arguments crashed 598 of 2028 combinations — because each
// card assumed the exact shape the CLI happened to pass, and the CLI is not the
// only caller (tests, the safe builder, and anything future). A card that
// throws is a card that can cost someone a completed scan, so the rule here is
// that a card either draws something or returns null. It never raises.
const lv5 = (levels) =>
  Array.from({ length: ARMS }, (_, i) => clampLevel(Array.isArray(levels) ? levels[i] : undefined));
const obj = (o) => (o && typeof o === "object" && !Array.isArray(o) ? o : {});
const arr = (a) => (Array.isArray(a) ? a : []);
const num = (n, fallback = 0) => (Number.isFinite(Number(n)) ? Number(n) : fallback);

const big = (s) => `${B}${WH}${s}${R}`;
const head = (s) => `${D}${s}${R}`;
const quip = (s) => `${WH}${s}${R}`;

/**
 * Where a value sits inside YOUR OWN history — never against other users.
 * A hosted wrapped says "top 17% of users" because it has everyone's data on a
 * server. This tool has exactly one person's data and says so: the comparison
 * is against your own months, which is checkable from the snapshots on disk.
 */
export function ownRank(value, series) {
  const xs = (series ?? []).filter((n) => Number.isFinite(n));
  if (xs.length < 3 || !Number.isFinite(value)) return null;
  const below = xs.filter((n) => n < value).length;
  const pct = Math.round((below / xs.length) * 100);
  const best = value >= Math.max(...xs);
  if (best) return `${D}(your best of ${xs.length} months)${R}`;
  return `${D}(above ${pct}% of your ${xs.length} months)${R}`;
}

// A compact silhouette: the SAME geometry as the big star and the SVG, sampled
// at card size. Half-blocks give two rows of pixels per text line.
export function miniStar(levels, w = 17, h = 9) {
  const lv = Array.from({ length: ARMS }, (_, i) => clampLevel(levels?.[i] ?? 0));
  const PW = w, PH = h * 2;
  // A five-pointed star is not centred in its own circle. The top tip reaches
  // -rad, but the lowest points are the two bottom arms at sin(54°) ≈ 0.809·rad,
  // so the shape is 1.809·rad tall and 2·cos(18°) ≈ 1.902·rad wide. Treating it
  // as a circle (cy = PH/2) left the bottom rows of every card permanently
  // blank and shrank the star to fit space it never used. Fit the real box.
  const HEIGHT_RATIO = 1 + Math.sin((54 * Math.PI) / 180);
  const WIDTH_RATIO = 2 * Math.cos((18 * Math.PI) / 180);
  const rad = Math.min((PH - 1) / HEIGHT_RATIO, (PW - 1) / WIDTH_RATIO);
  const cx = PW / 2;
  const cy = rad + (PH - rad * HEIGHT_RATIO) / 2;
  const hull = starPoints(lv, rad, cx, cy);
  const inside = (x, y) => {
    let on = false;
    for (let i = 0, j = hull.length - 1; i < hull.length; j = i++) {
      const [xi, yi] = hull[i], [xj, yj] = hull[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) on = !on;
    }
    return on;
  };
  const rows = [];
  for (let r = 0; r < PH; r += 2) {
    let line = "";
    for (let c = 0; c < PW; c++) {
      const t = inside(c + 0.5, r + 0.5), b = inside(c + 0.5, r + 1.5);
      line += t && b ? "█" : t ? "▀" : b ? "▄" : " ";
    }
    rows.push(line);
  }
  return rows;
}

function sparkline(buckets) {
  const glyphs = "▁▂▃▄▅▆▇█";
  const max = Math.max(...buckets, 1);
  return buckets.map((v) => glyphs[Math.min(7, Math.floor((v / max) * 7.999))]).join("");
}

// ---------------------------------------------------------------------------
// There is no cost estimate here, and that is deliberate.
//
// This tool reports USAGE. It used to print a retail dollar figure from assumed
// per-Mtok rates, labelled as an assumption — and an assumption with a dollar
// sign on it still gets quoted as a price. The same model bills differently
// depending on the route it was reached through, so a single rate table cannot
// be right for one person let alone a fleet, and a tool that makes no network
// calls cannot look up what changed. Tokens are a fact; the price of them is
// someone else's number.

/**
 * Accept whatever the caller has and return [{name, tokens}], biggest first.
 *
 * Deliberately tolerant of shape: an object keyed by provider name (what
 * scanAllProviders returns), an array of rows, or null. The crash this replaces
 * was a card assuming one shape and taking down the whole run at the very end —
 * after the scan, after the snapshots, after everything expensive had already
 * been done. A presentation layer must not be able to do that.
 */
export function normaliseProviders(providers) {
  if (!providers) return [];
  const rows = Array.isArray(providers)
    ? providers.map((p) => [p.name ?? p.provider ?? "?", p])
    : Object.entries(providers);
  return rows
    .map(([name, p]) => ({
      name: String(name),
      tokens:
        (p?.input ?? 0) + (p?.output ?? 0) + (p?.cacheRead ?? 0) + (p?.cacheWrite ?? 0) ||
        (p?.total_tokens ?? 0),
      sessions: p?.sessions ?? 0,
      // Carried so a caller can tell "this tool has no tokens" from "this
      // tool's store could not be read". The wrapped cards rank by tokens and
      // a floor is still a rank, but the flag has to survive the mapping or
      // the distinction dies here, one step before it is shown.
      unreadable: p?.state === "unreadable",
    }))
    .filter((p) => p.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);
}

/**
 * Providers that are installed and could NOT be read.
 *
 * `normaliseProviders` ranks by tokens and drops everything at zero, which is
 * right for a leaderboard and wrong as the only view: a store that refused to
 * open contributes 0 and is dropped by the same test that drops a tool nobody
 * uses. Anything that presents a total built from these providers has to be
 * able to say the total is a floor.
 */
export function unreadableProviders(providers) {
  if (!providers) return [];
  const rows = Array.isArray(providers)
    ? providers.map((p) => [p.name ?? p.provider ?? "?", p])
    : Object.entries(providers);
  return rows
    .filter(([, p]) => p?.state === "unreadable")
    .map(([name, p]) => ({ name: String(name), why: p.unreadable ?? [] }));
}


// ---------------------------------------------------------------------------
// Cards. Each returns an array of lines, or null when it has nothing to say —
// a card with no data is skipped rather than printed empty.

export function cardStar(rawLevels, agg) {
  const levels = lv5(rawLevels);
  const total = levels.reduce((a, b) => a + b, 0);
  const grade = rating(total);
  const art = miniStar(levels, 23, 11);
  const lines = [head("FORGED"), ""];
  const labels = AXES.map((ax, i) => `${pad(ax, 17)} ${bar(levels[i], MAX_LEVEL, 10)} ${WH}${levels[i]}${R}`);
  for (let i = 0; i < Math.max(art.length, labels.length); i++) {
    const left = art[i] ? `  ${CY}${art[i]}${R}` : "  " + " ".repeat(21);
    const right = labels[i] ? "  " + labels[i] : "";
    lines.push(left + right);
  }
  lines.push("");
  lines.push(`  ${big(`${total.toFixed(1)}/${ARMS * MAX_LEVEL}`)} skill points   ${D}rating${R} ${WH}${grade}${R}`);
  // The archetype names the SHAPE, and it is the one thing on this card that is
  // about you rather than about a count. Deliberately not a ranking: the tool
  // has never seen anyone else's data, so it has nothing to rank you against.
  const arc = archetype(levels);
  lines.push("");
  lines.push(`  ${WH}── ${arc.name.toUpperCase()} ──${R}`);
  // wrapWords, not a raw push: box() CLIPS at its own width rather than
  // wrapping, and the first version lost the last three words of the blurb.
  for (const l of wrapWords(arc.blurb, W - 4)) lines.push(`  ${D}${l}${R}`);
  for (const l of wrapWords(signature(agg), W - 4)) lines.push(`  ${D}${l}${R}`);
  lines.push("");
  lines.push(D + "  arm length is that axis alone — the outline is the data" + R);
  lines.push(D + "  no percentile: nothing here has seen another user's data" + R);
  return lines;
}

export function cardManaged(rawAgg, rawTimeline) {
  const agg = obj(rawAgg), timeline = arr(rawTimeline);
  if (!num(agg.total_sessions)) return null;
  const hours = Math.round(agg.total_duration_hours);
  const perDay = agg.active_days > 0 ? agg.total_duration_hours / agg.active_days : 0;
  const verdict =
    perDay >= 8 ? "that is a full working day, every day you showed up." :
    perDay >= 4 ? "half a working day on top of the day you already had." :
    perDay >= 1.5 ? "a real habit, not a dabble." :
    "steady, in short bursts.";
  const rank = ownRank(agg.total_duration_hours / Math.max(1, (timeline ?? []).length), (timeline ?? []).map((m) => m.duration_hours));
  return [
    head("YOU SHOWED UP"),
    "",
    `  ${big(fmt(hours))} ${WH}active hours${R}`,
    `  ${WH}${fmt(agg.total_sessions)}${R} sessions across ${WH}${agg.active_days}${R} active days`,
    rank ? `  ${rank}` : "",
    "",
    quip("  " + verdict),
    D + `  active time only: gaps over 15 min are not counted` + R,
  ].filter(keep);
}

export function cardHistory(rawTimeline) {
  const timeline = arr(rawTimeline).filter((m) => m && typeof m === "object" && typeof m.month === "string");
  if (timeline.length < 2) return null;
  const months = timeline.slice(-12);
  const max = Math.max(...months.map((m) => m.duration_hours), 1);
  const rows = months.map((m) => {
    const [y, mo] = m.month.split("-");
    const label = `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(mo) - 1]} ${y.slice(2)}`;
    return `  ${D}${pad(label, 7)}${R} ${bar(m.duration_hours, max, 22)} ${D}${Math.round(m.duration_hours)}h${R}`;
  });
  const best = [...months].sort((a, b) => b.duration_hours - a.duration_hours)[0];
  const last = months[months.length - 1], prev = months[months.length - 2];
  const trend =
    prev && prev.duration_hours > 0
      ? `${last.month.slice(5)}: ${last.duration_hours >= prev.duration_hours ? "+" : ""}${Math.round(((last.duration_hours - prev.duration_hours) / prev.duration_hours) * 100)}% vs previous month`
      : null;
  return [
    head("THE RECORD"),
    "",
    `  ${big(`${Math.round(timeline.reduce((a, m) => a + m.duration_hours, 0))} hours`)} ${WH}from local logs${R}`,
    trend ? `  ${D}${trend}${R}` : "",
    "",
    ...rows,
    "",
    `  ${D}best month: ${best.month} · ~${Math.round(best.duration_hours)}h${R}`,
    D + "  a floor, not a lifetime total — logs age out of disk" + R,
  ].filter(keep);
}

export function cardTokens(rawAgg, providers) {
  const agg = obj(rawAgg);
  const work = (agg.total_input_tokens ?? 0) + (agg.total_output_tokens ?? 0);
  const cache = (agg.total_cache_read_tokens ?? 0) + (agg.total_cache_write_tokens ?? 0);
  if (work + cache === 0) return null;
  const cachePct = ((cache / (work + cache)) * 100).toFixed(1);
  const lines = [
    head("THE WEIGHT OF IT"),
    "",
    `  ${big(human(work + cache))} ${WH}tokens${R}`,
    `  ${WH}${human(work)}${R} actually generated · ${WH}${cachePct}%${R} served from cache`,
    "",
    // wrapWords, not hand-counted lines — box() clips instead of wrapping, and
    // hand-counting has now lost the end of a line on three separate cards.
    ...wrapWords(
      "usage, not cost. this tool does not price your work: the same model " +
        "bills differently through different routes, and a rate it cannot " +
        "fetch would be a guess wearing a dollar sign.",
      W - 4
    ).map((l) => `  ${D}${l}${R}`),
  ];
  // scanAllProviders() returns an OBJECT keyed by provider name, with rows of
  // {sessions, input, output, cacheRead, cacheWrite} — not an array, and not a
  // total_tokens field. Assuming an array crashed every run that did NOT pass
  // --no-providers, which is the default path and the one real users take.
  const provs = normaliseProviders(providers);
  if (provs.length) {
    const max = Math.max(...provs.map((p) => p.tokens));
    lines.push("");
    for (const p of provs)
      lines.push(`  ${D}${pad(p.name, 12)}${R} ${bar(p.tokens, max, 16)} ${D}${human(p.tokens)}${R}`);
  }
  return lines;
}

export function cardShapeOverTime(rawTimeline) {
  const months = arr(rawTimeline).filter((m) => m && Array.isArray(m.levels) && typeof m.month === "string").slice(-5);
  if (months.length < 2) return null;
  const arts = months.map((m) => miniStar(m.levels, 13, 7));
  const lines = [head("THE SHAPE OVER TIME"), ""];
  for (let r = 0; r < arts[0].length; r++)
    lines.push("  " + arts.map((a) => CY + a[r] + R).join(" "));
  lines.push("  " + months.map((m) => `${D}${pad(m.month.slice(2), 13)}${R}`).join(" "));
  lines.push("  " + months.map((m) => `${WH}${pad(m.levels.reduce((a, b) => a + b, 0).toFixed(1), 13)}${R}`).join(" "));
  lines.push("");
  lines.push(D + "  each drawn from that month alone. a thin month is a small" + R);
  lines.push(D + "  tight shape, not a gap. no hosted wrapped shows you this —" + R);
  lines.push(D + "  a lifetime average is exactly what hides it." + R);
  return lines;
}

export function cardRhythm(profile) {
  const rhy = profile?.rhythm;
  if (!rhy?.hour_buckets) return null;
  const weekend = Math.round((rhy.weekend_ratio ?? 0) * 100);
  const weekday = 100 - weekend;
  const peak = rhy.peak_hour;
  const owl = rhy.night_owl;
  const subhead = owl
    ? "while the 9-5 sleeps, you ship."
    : peak != null && peak >= 18 ? "you do your best work after the day job ends."
    : peak != null && peak < 9 ? "up before standup."
    : "you keep your own hours.";
  return [
    head("WHEN YOU CODE"),
    "",
    `  ${CY}${sparkline(rhy.hour_buckets)}${R}`,
    `  ${D}00    06    12    18  23${R}`,
    "",
    peak != null ? `  ${WH}peak at ${String(peak).padStart(2, "0")}:00${R}${D} · ${Math.round((rhy.night_share ?? 0) * 100)}% of events 00:00–05:59${R}` : "",
    "",
    `  ${WH}weekdays${R}  ${bar(weekday, 100, 20)} ${D}${weekday}%${R}`,
    `  ${WH}weekends${R}  ${bar(weekend, 100, 20)} ${D}${weekend}%${R}`,
    "",
    quip("  " + subhead),
  ].filter(keep);
}

export function cardHowYouDrive(profile) {
  const c = profile?.conversation, d = profile?.delegation;
  if (!c?.prompt_turns) return null;
  const lines = [
    head("YOUR HAND ON IT"),
    "",
    `  ${big(fmt(c.prompt_turns))} ${WH}prompts${R}${D} · ~${c.avg_prompt_chars} chars each${R}`,
    "",
    `  ${pad("correction rate", 18)} ${bar(c.correction_rate_pct ?? 0, 40, 14)} ${WH}${c.correction_rate_pct ?? "–"}%${R}`,
    `  ${pad("questions asked", 18)} ${bar((c.question_ratio ?? 0) * 100, 40, 14)} ${WH}${c.question_ratio ?? "–"}${R}`,
    `  ${pad("hands-on code", 18)} ${bar(d?.hands_on_code_pct ?? 0, 100, 14)} ${WH}${d?.hands_on_code_pct ?? "–"}%${R}`,
    "",
    c.prompt_bucket ? `  ${WH}${c.prompt_bucket}${R}${D} · ${d?.delegation_ratio ?? "–"} tool calls per prompt${R}` : "",
    "",
    D + "  counted in-stream — no prompt text was stored, ever." + R,
  ].filter(keep);
  return lines;
}

export function cardAgents(profile) {
  const con = profile?.concurrency;
  if (!con || con.open_peak == null) return null;
  return [
    head("HOW MANY AGENTS YOU JUGGLE"),
    "",
    `  ${big(String(con.open_avg ?? "–"))} ${WH}open at once, on average${R}`,
    "",
    `  ${pad("peak", 16)} ${WH}${con.open_peak}${R}${D} at once${R}`,
    `  ${pad("2+ active", 16)} ${WH}${con.juggle_pct ?? "–"}%${R}${D} of your coding time${R}`,
    `  ${pad("longest session", 16)} ${WH}${con.longest_session_hours ?? "–"}h${R}`,
    "",
    quip(
      "  " +
        (con.open_peak >= 10
          ? "you fan out wide when it matters and still land it."
          : "you run one thread deep rather than many shallow.")
    ),
  ];
}

export function cardStack(rawAgg, profile) {
  const agg = obj(rawAgg);
  const tools = (profile?.delegation?.tool_mix ?? []).slice(0, 5);
  const models = Object.entries(agg.models ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const langs = Object.entries(agg.languages ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (!tools.length && !models.length) return null;
  const lines = [head("YOUR TOOLS & MODELS"), ""];
  if (tools.length) {
    const max = Math.max(...tools.map((t) => t.count));
    for (const t of tools)
      lines.push(`  ${D}${pad(t.name, 12)}${R} ${bar(t.count, max, 18)} ${D}${fmt(t.count)}${R}`);
    lines.push("");
  }
  // Wrapped, with the label kept on the first line and continuations indented
  // under it. Model ids are long and dated — three of them exceed the 60-column
  // box on their own, and box() clips instead of wrapping, so the third model
  // simply vanished from the card.
  const labelled = (label, pad, text) => {
    const rows = wrapWords(text, W - 4 - pad.length - 2);
    if (!rows.length) return;
    lines.push(`  ${WH}${label}${R}${pad}${rows[0]}`);
    for (const r of rows.slice(1)) lines.push(`  ${" ".repeat(label.length)}${pad}${r}`);
  };
  if (models.length) labelled("models", "  ", models.map(([m]) => m).join(", "));
  if (langs.length) labelled("langs", "   ", langs.map(([l, n]) => `${l}(${n})`).join(" "));
  const rel = profile?.tool_relationship;
  if (rel?.kind === "switch" && rel.from_tool && rel.to_tool) {
    lines.push("");
    lines.push(quip(`  you moved from ${rel.from_tool} to ${rel.to_tool} in ${rel.switch_month}.`));
  }
  return lines;
}

export function cardProjects(rawAgg) {
  const projects = arr(obj(rawAgg).projects).filter((p) => p && typeof p.name === "string").slice(0, 5);
  if (!projects.length) return null;
  const max = Math.max(...projects.map((p) => p.sessions));
  return [
    head("YOUR TOP PROJECTS"),
    "",
    ...projects.map(
      (p, i) =>
        `  ${i === 0 ? big("▸ " + p.name) : WH + "▸ " + p.name + R}` +
        `\n    ${bar(p.sessions, max, 18)} ${D}${p.sessions} session${p.sessions === 1 ? "" : "s"}${R}`
    ).join("\n").split("\n"),
    "",
    D + "  last two path segments only · --no-projects writes hashes" + R,
  ].flat();
}

export function cardProof(confinement) {
  return [
    head("ZERO"),
    "",
    `  ${big("nothing")} ${WH}— and you do not have to take that on faith${R}`,
    "",
    `  ${D}every number in this wrapped was computed in this process,${R}`,
    `  ${D}from files already on your disk. no account, no upload,${R}`,
    `  ${D}no server-side scoring. that is why there is no${R}`,
    `  ${D}"top 17% of users" anywhere in it: this tool has never${R}`,
    `  ${D}seen anyone else's data, so it compares you to your own${R}`,
    `  ${D}history instead — which you can check from the snapshots.${R}`,
    "",
    `  ${WH}no process can prove that about itself. so let the kernel:${R}`,
    `  ${CY}starreckon prove${R}${D}   → the command, without running it${R}`,
    `  ${CY}sh bin/starreckon-proof.sh${R}${D}  → runs the scan under a${R}`,
    `  ${D}  deny-network sandbox and fires a real TCP probe both${R}`,
    `  ${D}  sides of the wall. outside it connects; inside the${R}`,
    `  ${D}  kernel refuses with EPERM before a packet leaves.${R}`,
    confinement ? `\n  ${D}available here: ${confinement}${R}` : "",
  ].filter(keep);
}

/**
 * The share payload the QR actually carries.
 *
 * A QR pointing at the repo is useless as a share: it tells a phone where the
 * SOURCE lives, not what your run said. A hosted wrapped solves this by
 * uploading your results and encoding a URL to them — which is exactly the
 * thing this tool refuses to do. So the QR carries the RESULTS THEMSELVES as
 * text. Scan it and your phone shows the same numbers the terminal showed;
 * nothing was published to make that work, and nothing needs to stay up.
 *
 * Capacity is the constraint: 271 bytes at version 10, EC level M. This stays
 * well inside it and is truncated defensively rather than throwing.
 */
export function sharePayload(rawLevels, agg, url, contact) {
  const levels = lv5(rawLevels);
  const a = obj(agg);
  const total = levels.reduce((x, y) => x + y, 0);
  const grade = rating(total);
  const work = num(a.total_input_tokens) + num(a.total_output_tokens);
  const cache = num(a.total_cache_read_tokens) + num(a.total_cache_write_tokens);
  const cachePct = work + cache > 0 ? Math.round((cache / (work + cache)) * 100) : 0;
  const axes = AXES.map((ax, i) => `${ax.split(" ")[0].slice(0, 4).toLowerCase()} ${levels[i]}`).join(" ");
  const baseLines = [
    `starreckon skill star ${total.toFixed(1)}/${ARMS * MAX_LEVEL} (${grade}) — ${archetype(levels).name}`,
    axes,
    `${fmt(num(a.total_sessions))} sessions, ${Math.round(num(a.total_duration_hours))}h active, ${num(a.active_days)} days`,
    `${human(work + cache)} tokens, ${cachePct}% cached`,
    num(a.longest_streak_days) ? `longest streak ${num(a.longest_streak_days)}d` : null,
    "this code carries the numbers themselves, not a link to them.",
    url,
  ].filter(keep);
  const base = baseLines.join("\n");
  // Append contact fields in priority order, fitting as many as the cap allows.
  // A field is never truncated mid-value — it either fits whole or is skipped.
  const budget = 260 - new TextEncoder().encode(base + "\n").length;
  const cLines = contactLines(contact ?? {}, budget);
  let text = cLines.length ? base + "\n" + cLines.join("\n") : base;
  if (text.length > 260) text = text.slice(0, 257) + "...";
  return text;
}

export function cardShare(rawLevels, agg, url, contact) {
  const levels = lv5(rawLevels);
  const total = levels.reduce((a, b) => a + b, 0);
  const shape = AXES.map((_, i) => "▁▂▃▄▅▆▇█"[Math.min(7, Math.round((levels[i] / MAX_LEVEL) * 7))]).join("");
  const ct = contact ?? {};
  const hasContact = Object.keys(ct).length > 0;
  const contactSummary = hasContact
    ? Object.entries(ct).map(([k, v]) => `${k}: ${v}`).join("  ·  ")
    : null;
  const lines = [
    head("SEND IT"),
    "",
    `  ${WH}my skill star · ${total.toFixed(1)}/${ARMS * MAX_LEVEL} (${rating(total)}) · ${shape}${R}`,
    `  ${WH}${archetype(levels).name}${R}`,
    `  ${D}${AXES.map((a, i) => `${a.split(" ")[0].slice(0, 4).toLowerCase()} ${levels[i]}`).join(" · ")}${R}`,
    "",
    `  ${CY}npx starreckon${R}`,
    url ? `  ${D}${url}${R}` : "",
    "",
    `  ${D}the QR points to your results page — opens in any browser${R}`,
    `  ${D}the numbers are in the URL, not on a server. press [X] to copy${R}`,
    hasContact ? `  ${D}contact fields in QR: ${contactSummary}${R}` : `  ${D}add contact info: press [R] in the menu${R}`,
  ].filter(keep);
  return lines;
}

/**
 * The QR block, rendered OUTSIDE the card frame.
 *
 * A version-10 symbol with its quiet zone is 61 columns; the cards are 60 wide.
 * Inside the box the right-hand quiet zone was being clipped — and a QR with a
 * chewed quiet zone is exactly the kind of thing that looks perfect and then
 * will not scan. Rather than shrink the payload or the margin, the code gets
 * the width it needs by living below the frame.
 */
export function shareQrLines(rawLevels, agg, url, contact) {
  // Prefer encoding the GitHub Pages URL (short, clickable, renders the star
  // in a browser) over the raw-text payload. Fall back to raw text if the
  // URL can't be built (e.g. levels missing).
  const shareUrl = buildShareUrl(lv5(rawLevels), agg, null);
  const payload = shareUrl ?? sharePayload(lv5(rawLevels), agg, url ?? PAGES_BASE, contact);
  try {
    return qrToTerminal(payload, { color: !plain() }).split("\n").map((r) => "  " + r);
  } catch (e) {
    return [`  ${D}(could not encode the QR: ${String(e?.message ?? e).slice(0, 60)})${R}`];
  }
}


/**
 * cardFloor — THE FLOOR
 * Only shown when accounts floor data is available. Shows the gap between
 * what's on disk and what the stats-cache counters know about — the tokens
 * that survived deletion.
 */
export function cardFloor(floorData) {
  const d = floorData && typeof floorData === "object" ? floorData : null;
  if (!d) return null;
  const onDisk = num(d.onDisk);
  const floor  = num(d.floor);
  if (floor <= 0 || onDisk <= 0) return null;
  const delta = floor - onDisk;
  if (delta <= 0) return null;
  const deltaPct = Math.round((delta / floor) * 100);
  return [
    head("THE FLOOR"),
    "",
    `  ${big(human(floor))} ${WH}tokens — the floor${R}`,
    `  ${D}${human(onDisk)} on disk right now${R}`,
    "",
    `  ${WH}${human(delta)}${R}${D} exist only as frozen counters.${R}`,
    `  ${D}The transcripts are already gone. That is ${deltaPct}% of the total.${R}`,
    "",
    ...wrapWords(
      "Every tool that reads transcripts shows you the on-disk number. " +
      "This one reads the stats-cache counters that Claude Code keeps even " +
      "after it deletes the logs — and finds the rest.",
      W - 4
    ).map((l) => `  ${D}${l}${R}`),
    "",
    `  ${D}floor = counter total + transcript days after the counter's last date${R}`,
    `  ${D}it is a floor, not a ceiling — the other machines have not been scanned${R}`,
  ].filter(keep);
}

/**
 * cardMomentum — THE STREAK
 * Streak and daily activity. The most emotionally resonant number.
 */
export function cardMomentum(rawAgg, rawTimeline) {
  const agg = obj(rawAgg);
  const timeline = arr(rawTimeline);
  const longest = num(agg.longest_streak_days);
  const current = num(agg.current_streak_days);
  if (!longest) return null;

  // Build a sparkline from the last 30 days of daily session counts if we have
  // a timeline; fall back to monthly buckets.
  const buckets = timeline.length >= 2
    ? timeline.slice(-12).map((m) => num(m.duration_hours))
    : (agg.monthly_buckets ?? []).slice(-12).map((b) => num(b?.duration_hours ?? b));
  const spark = buckets.length
    ? "▁▂▃▄▅▆▇█"
        .split("")
        .map((g, i, a) => g)  // reference so closure works
    && (() => {
      const max = Math.max(...buckets, 1);
      return buckets.map((v) => "▁▂▃▄▅▆▇█"[Math.min(7, Math.floor((v / max) * 7.999))]).join("");
    })()
    : null;

  const quipText =
    current >= longest     ? "you are in your longest streak right now. keep going." :
    current >= longest * 0.8 ? "close to your record. one more day beats it." :
    current === 0           ? "the streak is broken. start a new one today." :
    longest >= 30           ? `${longest} days straight at your peak. the record stands.` :
    "consistency is the whole game. the streak shows it.";

  return [
    head("THE STREAK"),
    "",
    `  ${big(String(longest))}${WH} days — longest streak${R}`,
    current > 0 ? `  ${WH}${current}${R}${D} days active and counting${R}` : `  ${D}current streak: none yet — scan tomorrow${R}`,
    "",
    spark ? `  ${CY}${spark}${R}` : "",
    spark ? `  ${D}${timeline.length >= 2 ? "monthly hours" : "recent activity"}${R}` : "",
    "",
    quip("  " + quipText),
    `  ${D}a streak is consecutive active days — any session counts${R}`,
  ].filter(keep);
}

/**
 * cardWhatYouBuilt — THE WORK
 * A synthesis card. One paragraph about the actual work, not a table.
 * Only shown when there is enough data to say something real.
 */
export function cardWhatYouBuilt(rawAgg, rawLevels, rawTimeline) {
  const agg = obj(rawAgg);
  const levels = lv5(rawLevels);
  const timeline = arr(rawTimeline);
  const days = num(agg.active_days);
  const sessions = num(agg.total_sessions);
  if (!days || !sessions) return null;

  const topLang = Object.entries(agg.languages ?? {}).sort((a, b) => b[1] - a[1])[0]?.[0];
  const topProj = arr(agg.projects)[0]?.name;
  const hours = Math.round(num(agg.total_duration_hours));
  const arc = archetype(levels);
  const months = timeline.length;

  // Build a single paragraph about the work itself.
  const langPart = topLang ? `mostly in ${topLang}` : "across multiple languages";
  const projPart = topProj ? `, mostly on ${topProj}` : "";
  const timePart = months > 1 ? `over ${months} months` : `over ${days} active days`;
  const arcPart  = arc.name !== "Unforged" && arc.name !== "The Generalist"
    ? `The dominant signal: ${arc.name.replace("The ", "").toUpperCase()} — ${arc.blurb}.`
    : "";

  const para = `You spent most of your time ${langPart}${projPart}, ${timePart}. ${arcPart}`.trim();

  return [
    head("THE WORK"),
    "",
    ...wrapWords(para, W - 4).map((l) => `  ${WH}${l}${R}`),
    "",
    `  ${D}${fmt(sessions)} sessions · ${hours}h active · ${days} days${R}`,
    months > 1
      ? `  ${D}${months} months of history — the shape keeps being added to${R}`
      : `  ${D}first month on record — come back next month to see it move${R}`,
  ].filter(keep);
}

/**
 * Build every card for this run. Cards with no data return null and are
 * dropped, so a thin history produces a short story rather than empty boxes.
 */
export function buildCards(input) {
  const { levels, agg, profile, timeline, providers, confinement, url } = input;
  const contact = input.contact ?? null;
  const GOLD = "\x1b[38;5;220m";
  const specs = [
    [cardWhatYouBuilt(agg, levels, timeline), "\x1b[38;5;213m"],
    [cardStar(levels, agg), CY],
    [cardScoring(agg), "\x1b[38;5;120m"],
    [cardSources(input.corpusMonth ?? null, agg, input.fleetAgg ?? null), GOLD],
    [cardFloor(input.floorData ?? null), "\x1b[38;5;87m"],
    [cardManaged(agg, timeline), GOLD],
    [cardMomentum(agg, timeline), CY],
    [cardHistory(timeline), CY],
    [cardTokens(agg, providers), "\x1b[38;5;213m"],
    [cardShapeOverTime(timeline), CY],
    [cardRhythm(profile), "\x1b[38;5;213m"],
    [cardHowYouDrive(profile), GOLD],
    [cardAgents(profile), CY],
    [cardStack(agg, profile), "\x1b[38;5;120m"],
    [cardProjects(agg), "\x1b[38;5;120m"],
    [cardProof(confinement), GOLD],
    [cardRank(levels, agg, timeline), "\x1b[38;5;213m"],
    [cardShare(levels, agg, url ?? "https://github.com/Alexander-Sorrell-IT/starreckon", contact), CY],
  ];
  return specs.filter(([lines]) => Array.isArray(lines) && lines.length).map(([lines, color]) => ({ lines, color }));
}

/**
 * Build the cards, but never let one take down the run.
 *
 * A single card threw on the default path — `providers` was an object where the
 * code expected an array — and killed the whole invocation at the very end,
 * after the scan, the snapshots and the stars had all completed. The user lost
 * a two-minute run to a formatting bug in the last thing that draws. Drawing is
 * the least important thing this program does and it must fail like it: a card
 * that throws is replaced by a short note naming itself, and the rest print.
 */
export function buildCardsSafe(input) {
  try {
    return buildCards(input);
  } catch (e) {
    // A failure inside buildCards() itself: fall back to per-card isolation so
    // one bad card cannot cost the user the other eleven.
    const out = [];
    const each = [
      ["THE WORK", () => cardWhatYouBuilt(input.agg, input.levels, input.timeline)],
      ["FORGED", () => cardStar(input.levels, input.agg)],
      ["HOW IT WAS SCORED", () => cardScoring(input.agg)],
      ["4 STARS", () => cardSources(input.corpusMonth ?? null, input.agg, input.fleetAgg ?? null)],
      ["THE FLOOR", () => cardFloor(input.floorData ?? null)],
      ["YOU SHOWED UP", () => cardManaged(input.agg, input.timeline)],
      ["THE STREAK", () => cardMomentum(input.agg, input.timeline)],
      ["THE RECORD", () => cardHistory(input.timeline)],
      ["THE WEIGHT OF IT", () => cardTokens(input.agg, input.providers)],
      ["THE SHAPE OVER TIME", () => cardShapeOverTime(input.timeline)],
      ["WHEN YOU CODE", () => cardRhythm(input.profile)],
      ["YOUR HAND ON IT", () => cardHowYouDrive(input.profile)],
      ["HOW MANY AGENTS YOU JUGGLE", () => cardAgents(input.profile)],
      ["YOUR TOOLS & MODELS", () => cardStack(input.agg, input.profile)],
      ["YOUR TOP PROJECTS", () => cardProjects(input.agg)],
      ["ZERO", () => cardProof(input.confinement)],
      ["YOUR FORGE RANK", () => cardRank(input.levels, input.agg, input.timeline)],
      ["SEND IT", () => cardShare(input.levels, input.agg, input.url ?? "https://github.com/Alexander-Sorrell-IT/starreckon", input.contact ?? null)],
    ];
    for (const [name, fn] of each) {
      try {
        const lines = fn();
        if (Array.isArray(lines) && lines.length) out.push({ lines, color: CY });
      } catch (err) {
        out.push({
          lines: [head(name), "", `  ${D}this card could not be drawn: ${String(err?.message ?? err).slice(0, 90)}${R}`,
            `  ${D}the scan itself completed — this is a rendering fault only.${R}`],
          color: "\x1b[38;5;220m",
        });
      }
    }
    void e;
    return out;
  }
}

/** Render every card as one string (no pacing) — used when stdout is not a TTY. */
export function renderAll(cards) {
  return cards.map(({ lines, color }) => box(lines, { color })).join("\n");
}

/**
 * The rank card: emblem, tier, score, archetype.
 *
 * This is the one card modelled directly on the hosted wrapped's finale — big
 * art, a tier under it, then who you are. The deliberate omission is the line
 * that card puts between them, "top 1% of 3,756 users". That number needs a
 * server holding 3,756 other people's logs. This tool has one person's data and
 * says so, so the slot holds YOUR OWN history instead, which is checkable from
 * the snapshots on disk.
 */
export function cardRank(rawLevels, agg, timeline) {
  const levels = lv5(rawLevels);
  const total = levels.reduce((a, b) => a + b, 0);
  const tier = rating(total);
  const arc = archetype(levels);
  const centre = (s) => " ".repeat(Math.max(0, Math.floor((W - vis(s)) / 2))) + s;

  const lines = [head("YOUR FORGE RANK"), ""];
  for (const row of emblem(tier)) lines.push(`${CY}${centre(row)}${R}`);
  lines.push("");
  lines.push(centre(`${WH}${B}──  ${tier}  ──${R}`));
  lines.push(centre(`${WH}${total.toFixed(1)} / ${ARMS * MAX_LEVEL}${R}`));

  // Where this sits in YOUR history — the honest occupant of the percentile slot.
  const months = arr(timeline);
  const totals = months
    .map((m) => (Array.isArray(m?.levels) ? m.levels.reduce((a, b) => a + num(b), 0) : null))
    .filter((n) => Number.isFinite(n));
  const own = ownRank(total, totals);
  lines.push(centre(own ?? `${D}your first months — not enough history to place it yet${R}`));

  lines.push("");
  lines.push(centre(`${WH}${arc.name}${R}`));
  for (const l of wrapWords(arc.blurb, W - 6)) lines.push(centre(`${D}${l}${R}`));
  lines.push("");

  // The two arms that chose the archetype, so the name is auditable rather than
  // decorative — you can see WHY it picked this one.
  for (const i of arr(arc.top))
    lines.push(`  ${pad(AXES[i], 17)} ${bar(levels[i], MAX_LEVEL, 10)} ${WH}${levels[i]}${R}`);
  lines.push("");
  // wrapWords — cardStar wraps this same sentence and cardRank did not, so
  // box() clipped its tail. Third card in this file to lose its last words.
  for (const l of wrapWords(signature(agg), W - 4)) lines.push(`  ${D}${l}${R}`);
  for (const l of wrapWords(`tier is your average arm out of ${MAX_LEVEL} — not a percentile`, W - 4))
    lines.push(`  ${D}${l}${R}`);
  return lines;
}

/**
 * How each arm got its length — the categories, and what was measured for each.
 *
 * Read from explainLevels(), which is computed from the SAME axis spec as the
 * score. A card that re-derived the formula to "show its working" would be a
 * second copy of the scoring, and every copy in this codebase has eventually
 * disagreed with its original. Here disagreement would be worse than silence:
 * it would look like an audit.
 */
export function cardScoring(agg) {
  let rows;
  try {
    rows = explainLevels(obj(agg));
  } catch {
    return null;
  }
  const lines = [head("HOW IT WAS SCORED"), ""];
  for (const r of rows) {
    const cap = r.capped ? `  ${D}maxed${R}` : "";
    lines.push(`  ${WH}${pad(r.axis, 18)}${R}${bar(r.level, MAX_LEVEL, 8)} ${WH}${r.level}${R}${cap}`);
    for (const t of r.terms) {
      const val = `${human(t.value)}${t.unit}`;
      lines.push(`    ${D}${pad(t.label, 15)} ${pad(val, 8)} +${t.contribution.toFixed(2)}${R}`);
    }
  }
  lines.push("");
  // wrapWords, not hand-counted lines: the first version ran one column over
  // and box() clipped "doing" to "doin".
  for (const l of wrapWords(
    "each arm answers to its own inputs and nothing else — doing more of one " +
      `thing can never shorten a different arm. "maxed" means the axis stopped ` +
      `measuring at ${MAX_LEVEL}.`,
    W - 4
  ))
    lines.push(`  ${D}${l}${R}`);
  return lines;
}

/**
 * The 4-star view: corpus vs fleet × this month vs lifetime.
 *
 * Two rows, two columns — four mini-stars drawn side by side in a 2×2 grid.
 * Each star is drawn from its own source only; nothing is blended or averaged.
 *
 *   CORPUS this month  |  CORPUS lifetime
 *   FLEET  this month  |  FLEET  lifetime
 *
 * Fleet arms that cannot be measured (languages, tool calls, night hours) are
 * drawn at zero inside the star and labelled as unmeasured underneath. A zero
 * arm and an unmeasured arm are different facts: this card shows both.
 *
 * Falls back to a 2-star layout (corpus only) when no fleet data is available.
 */
export function cardSources(corpusMonth, corpusLife, fleet) {
  // Need at least a corpus lifetime to draw anything meaningful.
  if (!corpusLife && !corpusMonth && !fleet?.lifetime) return null;

  // Helper: compute levels from an agg, respecting which inputs are available.
  const levelsOf = (agg, available = null) => {
    if (!agg) return new Array(ARMS).fill(0);
    const lv = computeLevels(agg);
    // Zero out unmeasured axes so the shape is honest.
    if (available) {
      const inputs = ["tokensM", "projects", "toolCalls", "models", "streak"];
      // Map axis index → whether its primary input is measured.
      // FIRST PRINCIPLES(0)=tokensM, ENGINEERING(1)=projects,
      // CODING(2)=toolCalls, OUTSIDE(3)=models, TENACITY(4)=streak
      const measured = [
        available.tokensM !== false,
        available.projects !== false,
        available.toolCalls !== false,
        available.models !== false,
        available.streak !== false,
      ];
      return lv.map((v, i) => measured[i] ? v : 0);
    }
    return lv;
  };

  const total = (lv) => lv.reduce((a, b) => a + b, 0);
  const fmt1 = (n) => n.toFixed(1);

  const fleetMonth = arr(fleet?.months ?? []).length
    ? arr(fleet.months)[arr(fleet.months).length - 1]
    : null;
  const fleetLife = fleet?.lifetime ?? null;
  const hasFleet = Boolean(fleetLife);

  // Compute all four level arrays.
  const cMonthLv = levelsOf(corpusMonth);
  const cLifeLv  = levelsOf(corpusLife);
  const fMonthLv = levelsOf(fleetMonth, fleet?.available ?? FLEET_MEASURES);
  const fLifeLv  = levelsOf(fleetLife,  fleet?.available ?? FLEET_MEASURES);

  // Star size: two stars side by side must fit inside W=60 with a gap.
  // 13 cols × 7 rows fits two with a 4-col gap and 5-col margins.
  const SW = 13, SH = 7;

  // Render one mini-star row by row, applying a colour or plain block char.
  const drawStar = (lv) => miniStar(lv, SW, SH);

  // Build the 4-star grid: top row = corpus, bottom row = fleet.
  // Each row: [left star rows, right star rows] zipped together.
  const renderRow = (leftLv, rightLv, leftLabel, rightLabel, leftScore, rightScore, note) => {
    const left  = drawStar(leftLv);
    const right = drawStar(rightLv);
    const GAP = "   ";
    const rowLines = [];
    // Label row above the stars
    rowLines.push(
      `  ${D}${pad(leftLabel, SW)}${GAP}${rightLabel}${R}`
    );
    // Star rows side by side
    for (let r = 0; r < SH; r++) {
      rowLines.push(`  ${CY}${left[r]}${R}${GAP}${CY}${right[r]}${R}`);
    }
    // Score row below the stars
    rowLines.push(
      `  ${WH}${fmt1(leftScore).padEnd(SW)}${R}${GAP}${WH}${fmt1(rightScore)}${R}` +
      (note ? `  ${D}${note}${R}` : "")
    );
    return rowLines;
  };

  const lines = [head("4 STARS"), ""];

  // Top row: corpus
  lines.push(...renderRow(
    cMonthLv, cLifeLv,
    "corpus · month", "corpus · lifetime",
    total(cMonthLv), total(cLifeLv)
  ));

  if (hasFleet) {
    lines.push("");
    // Bottom row: fleet
    lines.push(...renderRow(
      fMonthLv, fLifeLv,
      "fleet · month", "fleet · lifetime",
      total(fMonthLv), total(fLifeLv),
      "floor"
    ));
  }

  lines.push("");

  // Which axes are unmeasured in fleet — tell the reader why some fleet arms
  // are drawn at zero, so "short arm" is not mistaken for "weak axis".
  if (hasFleet) {
    const missing = ["CODING", "OUTSIDE THE BOX"].filter(Boolean);
    for (const l of wrapWords(
      `fleet floor: language, tool-call and night-hour data not recorded ` +
      `in token-usage — those arms are drawn at zero, not measured as zero. ` +
      `every other arm is a lower bound.`,
      W - 4
    )) lines.push(`  ${D}${l}${R}`);
  } else {
    lines.push(`  ${D}run with --fleet=DIR to add the fleet stars${R}`);
  }

  // Denominator — same for all four stars.
  lines.push(`  ${D}/35 per star  ·  ${ARMS} axes  ·  max ${MAX_LEVEL} per axis${R}`);
  return lines.filter(keep);
}
