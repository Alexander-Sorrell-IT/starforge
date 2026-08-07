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
import { qrToTerminal } from "./qr.mjs";

const R = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const I = "\x1b[3m";
const CY = "\x1b[38;5;51m";
const WH = "\x1b[97m";
const DIMC = "\x1b[38;5;38m";

const W = 60; // inner width of every card

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const vis = (s) => strip(s).length;

function pad(s, width) {
  const n = width - vis(s);
  return s + " ".repeat(Math.max(0, n));
}

/** A rounded box, sized to W, that tolerates ANSI inside its lines. */
export function box(lines, { color = CY } = {}) {
  const out = [];
  out.push(`${color}╭${"─".repeat(W + 2)}╮${R}`);
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
      l = acc + R;
    }
    out.push(`${color}│${R} ${pad(l, W)} ${color}│${R}`);
  }
  out.push(`${color}╰${"─".repeat(W + 2)}╯${R}`);
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
// Retail-cost estimate.
//
// These are ASSUMPTIONS, not a price lookup — this tool makes no network calls,
// so it cannot know today's rates. They are printed on the card next to the
// number so the figure is auditable instead of authoritative, and overridable
// with --rates=in,out,cache. Sanity-check them before quoting the dollar figure
// anywhere that matters.
export const DEFAULT_RATES = { in: 15, out: 75, cache: 1.5, note: "assumed $/Mtok, not fetched" };

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
    }))
    .filter((p) => p.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5);
}

export function estimateCost(agg, rates = DEFAULT_RATES) {
  const inTok = agg.total_input_tokens ?? 0;
  const outTok = agg.total_output_tokens ?? 0;
  const cacheTok = (agg.total_cache_read_tokens ?? 0) + (agg.total_cache_write_tokens ?? 0);
  return (inTok / 1e6) * rates.in + (outTok / 1e6) * rates.out + (cacheTok / 1e6) * rates.cache;
}

// ---------------------------------------------------------------------------
// Cards. Each returns an array of lines, or null when it has nothing to say —
// a card with no data is skipped rather than printed empty.

export function cardStar(levels, agg) {
  const total = levels.reduce((a, b) => a + b, 0);
  const rating = total >= 22 ? "S+" : total >= 20 ? "S" : total >= 17 ? "A" : total >= 13 ? "B" : "C";
  const art = miniStar(levels, 23, 11);
  const lines = [head("THE SHAPE OF YOUR WORK"), ""];
  const labels = AXES.map((ax, i) => `${pad(ax, 17)} ${bar(levels[i], MAX_LEVEL, 10)} ${WH}${levels[i]}${R}`);
  for (let i = 0; i < Math.max(art.length, labels.length); i++) {
    const left = art[i] ? `  ${CY}${art[i]}${R}` : "  " + " ".repeat(21);
    const right = labels[i] ? "  " + labels[i] : "";
    lines.push(left + right);
  }
  lines.push("");
  lines.push(`  ${big(`${total.toFixed(1)}/25`)} skill points   ${D}rating${R} ${WH}${rating}${R}`);
  lines.push(D + "  arm length is that axis alone — the outline is the data" + R);
  return lines;
}

export function cardManaged(agg, timeline) {
  if (!agg.total_sessions) return null;
  const hours = Math.round(agg.total_duration_hours);
  const perDay = agg.active_days > 0 ? agg.total_duration_hours / agg.active_days : 0;
  const verdict =
    perDay >= 8 ? "that is a full working day, every day you showed up." :
    perDay >= 4 ? "half a working day on top of the day you already had." :
    perDay >= 1.5 ? "a real habit, not a dabble." :
    "steady, in short bursts.";
  const rank = ownRank(agg.total_duration_hours / Math.max(1, (timeline ?? []).length), (timeline ?? []).map((m) => m.duration_hours));
  return [
    head("YOU MANAGED"),
    "",
    `  ${big(fmt(hours))} ${WH}active hours${R}`,
    `  ${WH}${fmt(agg.total_sessions)}${R} sessions across ${WH}${agg.active_days}${R} active days`,
    rank ? `  ${rank}` : "",
    "",
    quip("  " + verdict),
    D + `  active time only: gaps over 15 min are not counted` + R,
  ].filter(keep);
}

export function cardHistory(timeline) {
  if (!timeline || timeline.length < 2) return null;
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
    head("YOUR CODING HISTORY"),
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

export function cardTokens(agg, providers, rates) {
  const work = (agg.total_input_tokens ?? 0) + (agg.total_output_tokens ?? 0);
  const cache = (agg.total_cache_read_tokens ?? 0) + (agg.total_cache_write_tokens ?? 0);
  if (work + cache === 0) return null;
  const cachePct = ((cache / (work + cache)) * 100).toFixed(1);
  const cost = estimateCost(agg, rates);
  const lines = [
    head("YOU BURNED THIS MANY TOKENS"),
    "",
    `  ${big(human(work + cache))} ${WH}tokens${R}`,
    `  ${WH}${human(work)}${R} actually generated · ${WH}${cachePct}%${R} served from cache`,
    "",
    `  ${D}~$${Math.round(cost).toLocaleString("en-US")} at ${rates.in}/${rates.out}/${rates.cache} per Mtok (in/out/cached)${R}`,
    `  ${D}${rates.note ?? "assumed rates"} — this tool makes no network calls,${R}`,
    `  ${D}so it cannot look up today's prices. Check before quoting it.${R}`,
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

export function cardShapeOverTime(timeline) {
  const months = (timeline ?? []).filter((m) => m.levels).slice(-5);
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
    head("HOW YOU DRIVE THE MACHINE"),
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

export function cardStack(agg, profile) {
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
  if (models.length) lines.push(`  ${WH}models${R}  ${models.map(([m]) => m).join(", ")}`);
  if (langs.length) lines.push(`  ${WH}langs${R}   ${langs.map(([l, n]) => `${l}(${n})`).join(" ")}`);
  const rel = profile?.tool_relationship;
  if (rel?.kind === "switch" && rel.from_tool && rel.to_tool) {
    lines.push("");
    lines.push(quip(`  you moved from ${rel.from_tool} to ${rel.to_tool} in ${rel.switch_month}.`));
  }
  return lines;
}

export function cardProjects(agg) {
  const projects = (agg.projects ?? []).slice(0, 5);
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
    head("WHAT LEFT THIS MACHINE"),
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
    `  ${CY}starforge-cli prove${R}${D}   → the command, without running it${R}`,
    `  ${CY}sh bin/starforge-proof.sh${R}${D}  → runs the scan under a${R}`,
    `  ${D}  deny-network sandbox and fires a real TCP probe both${R}`,
    `  ${D}  sides of the wall. outside it connects; inside the${R}`,
    `  ${D}  kernel refuses with EPERM before a packet leaves.${R}`,
    confinement ? `\n  ${D}available here: ${confinement}${R}` : "",
  ].filter(keep);
}

export function cardShare(levels, url) {
  const total = levels.reduce((a, b) => a + b, 0);
  const shape = AXES.map((_, i) => "▁▂▃▄▅▆▇█"[Math.min(7, Math.round((levels[i] / MAX_LEVEL) * 7))]).join("");
  const lines = [
    head("SHARE IT"),
    "",
    `  ${WH}my skill star · ${total.toFixed(1)}/25 · ${shape}${R}`,
    `  ${D}${AXES.map((a, i) => `${a.split(" ")[0].slice(0, 4).toLowerCase()} ${levels[i]}`).join(" · ")}${R}`,
    "",
    `  ${CY}${url}${R}`,
    "",
  ];
  for (const row of qrToTerminal(url, { color: true }).split("\n")) lines.push("  " + row);
  lines.push("");
  lines.push(D + "  card and page are files on your disk. nothing was posted." + R);
  return lines;
}

/**
 * Build every card for this run. Cards with no data return null and are
 * dropped, so a thin history produces a short story rather than empty boxes.
 */
export function buildCards(input) {
  const { levels, agg, profile, timeline, providers, rates, confinement, url } = input;
  const specs = [
    [cardStar(levels, agg), CY],
    [cardManaged(agg, timeline), "\x1b[38;5;220m"],
    [cardHistory(timeline), CY],
    [cardTokens(agg, providers, rates ?? DEFAULT_RATES), "\x1b[38;5;213m"],
    [cardShapeOverTime(timeline), CY],
    [cardRhythm(profile), "\x1b[38;5;213m"],
    [cardHowYouDrive(profile), "\x1b[38;5;220m"],
    [cardAgents(profile), CY],
    [cardStack(agg, profile), "\x1b[38;5;120m"],
    [cardProjects(agg), "\x1b[38;5;120m"],
    [cardProof(confinement), "\x1b[38;5;220m"],
    [cardShare(levels, url ?? "https://github.com/Alexander-Sorrell-IT/starforge"), CY],
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
      ["THE SHAPE OF YOUR WORK", () => cardStar(input.levels, input.agg)],
      ["YOU MANAGED", () => cardManaged(input.agg, input.timeline)],
      ["YOUR CODING HISTORY", () => cardHistory(input.timeline)],
      ["YOU BURNED THIS MANY TOKENS", () => cardTokens(input.agg, input.providers, input.rates ?? DEFAULT_RATES)],
      ["THE SHAPE OVER TIME", () => cardShapeOverTime(input.timeline)],
      ["WHEN YOU CODE", () => cardRhythm(input.profile)],
      ["HOW YOU DRIVE THE MACHINE", () => cardHowYouDrive(input.profile)],
      ["HOW MANY AGENTS YOU JUGGLE", () => cardAgents(input.profile)],
      ["YOUR TOOLS & MODELS", () => cardStack(input.agg, input.profile)],
      ["YOUR TOP PROJECTS", () => cardProjects(input.agg)],
      ["WHAT LEFT THIS MACHINE", () => cardProof(input.confinement)],
      ["SHARE IT", () => cardShare(input.levels, input.url ?? "https://github.com/Alexander-Sorrell-IT/starforge")],
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
