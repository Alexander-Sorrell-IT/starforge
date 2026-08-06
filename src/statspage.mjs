// Self-contained dark-HUD stats page. One HTML string, inline CSS, inline SVG
// only — no external resources, no JS, no network. Aesthetic matches card.mjs
// (#010409 bg, cyan #7fe0ff data accent, monospace numerals).
//
// Every stringy value is escaped AND passed through redactSecrets + maskPath
// before it lands in markup. Every section tolerates absent data: a metric
// that wasn't computed renders as a dash — 0% is a claim, absence is not.
import { redactSecrets, maskPath } from "./redact.mjs";

// ---- palette ---------------------------------------------------------------
// Data accent (single-series marks) + a 4-slot categorical set for the token
// split, validated with the dataviz six-checks script against surface #010409
// in stack order (lightness band, chroma, CVD >=8, normal-vision >=15, contrast).
const C = {
  bg: "#010409",
  panel: "#03141f",
  border: "#155273",
  grid: "#0e2a3d",
  ink: "#e8f7ff",       // text-primary
  ink2: "#9fdcf5",      // text-secondary
  muted: "#6fb9d8",     // text-muted
  faint: "#58a7c9",
  accent: "#7fe0ff",    // single-series data color
  accentDim: "#2c6f8f", // de-emphasis / non-peak bars
  track: "#0a2334",     // meter track
  cat: ["#3987e5", "#199e70", "#9085e9", "#c98500"], // cache read / cache write / fresh / output
};

const DASH = "&#8212;";

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// All free text: redact, mask, escape — in that order.
function clean(s) {
  if (s == null) return DASH;
  return esc(maskPath(redactSecrets(String(s))));
}

// Ported human() K/M/B/T formatter (fun_stats.py discipline: compact analogy
// numbers; exact counts live in tooltips/tables).
export function human(n) {
  if (n == null || !isFinite(n)) return null;
  const abs = Math.abs(n);
  const f = (v, suffix) => `${v >= 100 ? Math.round(v) : +v.toFixed(1)}${suffix}`;
  if (abs >= 1e12) return f(n / 1e12, "T");
  if (abs >= 1e9) return f(n / 1e9, "B");
  if (abs >= 1e6) return f(n / 1e6, "M");
  if (abs >= 1e3) return f(n / 1e3, "K");
  return String(Math.round(n));
}

const val = (v, suffix = "") => (v == null || (typeof v === "number" && !isFinite(v)) ? DASH : `${esc(v)}${suffix}`);
const hval = (v, suffix = "") => (human(v) == null ? DASH : `${human(v)}${suffix}`);
const fmt = (n) => (n == null || !isFinite(n) ? DASH : Number(n).toLocaleString("en-US"));

// ---- svg helpers -----------------------------------------------------------

// Bar with 4px rounded data-end, square at the baseline (mark spec).
function topRoundedBar(x, y, w, h, fill, title) {
  const r = Math.min(4, w / 2, h);
  if (h <= 0.5) return "";
  const d = `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
  return `<path d="${d}" fill="${fill}">${title ? `<title>${title}</title>` : ""}</path>`;
}

function rightRoundedBar(x, y, w, h, fill, title) {
  const r = Math.min(4, h / 2, w);
  if (w <= 0.5) return "";
  const d = `M${x},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x},${y + h} Z`;
  return `<path d="${d}" fill="${fill}">${title ? `<title>${title}</title>` : ""}</path>`;
}

// 24-bin hour histogram, peak bar in the accent, others de-emphasized.
function hourHistogramSvg(buckets, peakHour) {
  if (!Array.isArray(buckets) || buckets.length !== 24 || buckets.every((b) => !b))
    return `<div class="empty">${DASH} no hourly data</div>`;
  const W = 560, H = 150, pad = 8, padTop = 16, axisH = 18;
  const plotH = H - axisH - padTop;
  const max = Math.max(...buckets, 1);
  const slot = (W - pad * 2) / 24;
  const barW = Math.min(18, slot - 2); // 2px surface gap between bars
  let bars = "";
  for (let h = 0; h < 24; h++) {
    const bh = (buckets[h] / max) * plotH;
    const x = pad + h * slot + (slot - barW) / 2;
    const fill = h === peakHour ? C.accent : C.accentDim;
    bars += topRoundedBar(x, padTop + (plotH - bh), barW, bh, fill, `${String(h).padStart(2, "0")}:00 &#183; ${fmt(buckets[h])} events`);
  }
  let ticks = "";
  for (const h of [0, 6, 12, 18]) {
    const x = pad + h * slot + slot / 2;
    ticks += `<text x="${x}" y="${H - 4}" text-anchor="middle" class="tick">${String(h).padStart(2, "0")}</text>`;
  }
  const peakLabel =
    peakHour != null
      ? `<text x="${pad + peakHour * slot + slot / 2}" y="${Math.max(11, padTop + (plotH - (buckets[peakHour] / max) * plotH) - 4)}" text-anchor="middle" class="peak">${String(peakHour).padStart(2, "0")}h</text>`
      : "";
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="events by hour of day">
    <line x1="${pad}" y1="${padTop + plotH}" x2="${W - pad}" y2="${padTop + plotH}" stroke="${C.grid}" stroke-width="1"/>
    ${bars}${peakLabel}${ticks}
  </svg>`;
}

// Sparkline: 2px line, >=8px end marker with 2px surface ring.
function sparklineSvg(values, label) {
  if (!Array.isArray(values) || values.length < 2)
    return `<div class="empty">${DASH} not enough months</div>`;
  const W = 260, H = 56, pad = 6;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => [
    pad + (i * (W - pad * 2)) / (values.length - 1),
    H - pad - ((v - min) / span) * (H - pad * 2),
  ]);
  const path = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [ex, ey] = pts[pts.length - 1];
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">
    <path d="${path}" fill="none" stroke="${C.accent}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${ex}" cy="${ey}" r="6" fill="${C.bg}"/>
    <circle cx="${ex}" cy="${ey}" r="4" fill="${C.accent}"/>
  </svg>`;
}

// 90-day activity strip (streak calendar).
function calendarStripSvg(activeDays, endIso) {
  const days = new Set(activeDays ?? []);
  const end = endIso ? Date.parse(endIso) : Date.now();
  const N = 90, W = 560, H = 34;
  const slot = W / N;
  const side = Math.min(10, slot - 2); // 2px surface gap
  let cells = "";
  for (let i = 0; i < N; i++) {
    const d = new Date(end - (N - 1 - i) * 864e5).toISOString().slice(0, 10);
    const on = days.has(d);
    cells += `<rect x="${(i * slot + (slot - side) / 2).toFixed(1)}" y="${(H - side) / 2}" width="${side}" height="${side}" rx="2" fill="${on ? C.accent : C.track}"><title>${d}${on ? " &#183; active" : ""}</title></rect>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="last 90 days activity">${cells}</svg>`;
}

// Four-counter stacked bar, 2px surface gaps, legend carries identity.
function tokenStackSvg(tokens) {
  const parts = [
    ["re-read from cache", tokens?.cache_read, C.cat[0]],
    ["written to cache", tokens?.cache_write, C.cat[1]],
    ["fresh input", tokens?.fresh_input, C.cat[2]],
    ["generated output", tokens?.output, C.cat[3]],
  ];
  const total = parts.reduce((a, [, v]) => a + (v ?? 0), 0);
  if (total <= 0) return { svg: `<div class="empty">${DASH} no token data</div>`, legend: "" };
  const W = 560, H = 26;
  let x = 0, segs = "";
  for (const [label, v, color] of parts) {
    const w = ((v ?? 0) / total) * (W - parts.length * 2);
    if (w > 0.5) {
      segs += `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${H}" rx="2" fill="${color}"><title>${label}: ${fmt(v)} (${((v / total) * 100).toFixed(1)}%)</title></rect>`;
      x += w + 2; // surface gap
    }
  }
  const legend = parts
    .map(
      ([label, v, color]) =>
        `<span class="lg"><span class="sw" style="background:${color}"></span>${label} <b>${hval(v)}</b>${total > 0 && v != null ? ` &#183; ${((v / total) * 100).toFixed(1)}%` : ""}</span>`
    )
    .join("");
  return {
    svg: `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="token split">${segs}</svg>`,
    legend: `<div class="legend">${legend}</div>`,
  };
}

// Monthly bars (single series, accent hue).
function monthlyBarsSvg(rows, key, label) {
  const data = (rows ?? []).slice(-6);
  if (data.length === 0 || data.every((r) => !(r?.[key] > 0)))
    return `<div class="empty">${DASH} no monthly data</div>`;
  const W = 560, H = 130, pad = 8, padTop = 18, axisH = 16;
  const plotH = H - axisH - padTop;
  const max = Math.max(...data.map((r) => r[key] ?? 0), 1);
  const slot = (W - pad * 2) / data.length;
  const barW = Math.min(24, slot - 8);
  let out = "";
  data.forEach((r, i) => {
    const v = r[key] ?? 0;
    const bh = (v / max) * plotH;
    const x = pad + i * slot + (slot - barW) / 2;
    out += topRoundedBar(x, padTop + (plotH - bh), barW, bh, C.accent, `${esc(r.month ?? "")} &#183; ${fmt(v)} ${label}`);
    out += `<text x="${pad + i * slot + slot / 2}" y="${H - 4}" text-anchor="middle" class="tick">${esc((r.month ?? "").slice(2))}</text>`;
    if (v > 0)
      out += `<text x="${pad + i * slot + slot / 2}" y="${Math.max(12, padTop + (plotH - bh) - 4)}" text-anchor="middle" class="cap">${human(v)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label} by month">
    <line x1="${pad}" y1="${padTop + plotH}" x2="${W - pad}" y2="${padTop + plotH}" stroke="${C.grid}" stroke-width="1"/>${out}
  </svg>`;
}

// Horizontal ranked bar list (single series): label · bar · value.
function barList(items) {
  if (!items || items.length === 0) return `<div class="empty">${DASH}</div>`;
  const max = Math.max(...items.map((i) => i.value ?? 0), 1);
  return `<div class="bars">${items
    .map((i) => {
      const w = Math.max(1, ((i.value ?? 0) / max) * 100).toFixed(1);
      return `<div class="bar-row"><span class="bar-label" title="${clean(i.label)}">${clean(i.label)}</span><span class="bar-track"><svg viewBox="0 0 100 12" preserveAspectRatio="none"><title>${clean(i.label)}: ${fmt(i.value)}</title>${rightRoundedBar(0, 1, +w, 10, C.accent)}</svg></span><span class="bar-val">${hval(i.value)}${i.extra ? ` <i>${esc(i.extra)}</i>` : ""}</span></div>`;
    })
    .join("")}</div>`;
}

// Proficiency gauge: accent fill on a lighter track of the same family.
function gauge(label, g, inputs) {
  const pct = g != null ? Math.min(100, Math.max(0, (g / 5) * 100)) : 0;
  return `<div class="gauge">
    <div class="gauge-head"><span>${esc(label)}</span><b>${g != null ? `${g} / 5` : DASH}</b></div>
    <svg viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${esc(label)} gauge"><rect x="0" y="0" width="100" height="8" rx="4" fill="${C.track}"/>${g != null ? `<rect x="0" y="0" width="${pct.toFixed(1)}" height="8" rx="4" fill="${C.accent}"/>` : ""}</svg>
    <div class="cap">${inputs ?? ""}</div>
  </div>`;
}

function tile(label, value, cap) {
  return `<div class="tile"><div class="t-label">${esc(label)}</div><div class="t-value">${value}</div>${cap ? `<div class="cap">${cap}</div>` : ""}</div>`;
}

function panel(title, body, sub) {
  return `<section class="panel"><h2>${esc(title)}${sub ? `<span class="sub"> ${esc(sub)}</span>` : ""}</h2>${body}</section>`;
}

// Generic table for accounts/fleet/providers blobs of unknown shape.
function genericTable(data) {
  if (data == null) return null;
  let rows;
  if (Array.isArray(data)) rows = data.filter((r) => r && typeof r === "object").slice(0, 20);
  else if (typeof data === "object")
    rows = Object.entries(data).slice(0, 20).map(([k, v]) =>
      typeof v === "object" && v != null ? { name: k, ...v } : { name: k, value: v }
    );
  else return null;
  if (rows.length === 0) return null;
  const cols = [];
  for (const r of rows)
    for (const k of Object.keys(r)) {
      if (!cols.includes(k)) cols.push(k);
      if (cols.length >= 8) break;
    }
  const cell = (v) =>
    v == null ? DASH : typeof v === "number" ? fmt(v) : typeof v === "object" ? DASH : clean(v);
  return `<div class="scroll"><table><thead><tr>${cols.map((c) => `<th>${clean(c)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${cols.map((c) => `<td>${cell(r[c])}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

// ---- page ------------------------------------------------------------------

export function renderStatsPage(input = {}) {
  const { profile, agg, accounts, fleet, providers, starSvg, velocity, name } = input;
  const p = profile ?? {};
  const a = agg ?? {};
  const conv = p.conversation ?? {};
  const del = p.delegation ?? {};
  const cad = p.cadence ?? {};
  const rhy = p.rhythm ?? {};
  const tok = p.tokens ?? {};
  const con = p.concurrency ?? {};
  const rec = p.records ?? {};
  const mod = p.models ?? {};

  const title = name ? `${name} · starforge` : "starforge · stats";
  const today = (p.generated_at ?? new Date().toISOString()).slice(0, 10);

  // -- S1 hero ---------------------------------------------------------------
  const heroTiles = [
    tile("sessions", val(cad.total_sessions ?? a.total_sessions)),
    tile("active hours", val(cad.total_duration_hours ?? a.total_duration_hours)),
    tile("active days", val(cad.active_days ?? a.active_days)),
    tile("streak", `${val(cad.current_streak_days)}d <span class="dim">now</span> · ${val(cad.longest_streak_days ?? a.longest_streak_days)}d <span class="dim">best</span>`, "current streak walks back from today (zY9); a gap zeroes it"),
    tile("tokens", hval(tok.total ?? ((a.total_input_tokens ?? 0) + (a.total_output_tokens ?? 0) + (a.total_cache_read_tokens ?? 0) + (a.total_cache_write_tokens ?? 0) || null))),
    tile("velocity", velocity?.hours_trend_per_month != null ? `${velocity.hours_trend_per_month > 0 ? "+" : ""}${esc(velocity.hours_trend_per_month)}h/mo` : DASH, "hours trend per month"),
  ].join("");
  const hero = `<section class="hero">${starSvg ? `<div class="star">${starSvg}</div>` : ""}<div class="tiles hero-tiles">${heroTiles}</div></section>`;

  // -- S2 judgment signals ---------------------------------------------------
  const s2 = panel(
    "JUDGMENT SIGNALS",
    `<div class="tiles six">${[
      tile("correction rate", val(conv.correction_rate_pct, "%"), "correction turns / prompt turns · keyword heuristic (CORRECTION_RE)"),
      tile("question ratio", val(conv.question_ratio), "turns containing '?' / prompt turns"),
      tile("prompt depth", conv.avg_prompt_chars != null ? `${fmt(conv.avg_prompt_chars)} <span class="dim">chars</span>` : DASH, conv.prompt_bucket ? `avg prompt length &#8594; ${esc(conv.prompt_bucket)} (&lt;80 terse · 80&#8211;300 directive · &gt;300 spec-writer)` : "avg prompt length"),
      tile("delegation ratio", val(del.delegation_ratio), "tool calls per human prompt turn"),
      tile("hands-on code", val(del.hands_on_code_pct, "%"), "Edit+Write+NotebookEdit share of code-source tool calls · Cowork excluded"),
      tile("night owl", rhy.night_owl == null ? DASH : rhy.night_owl ? "YES" : "no", rhy.night_share != null ? `${(rhy.night_share * 100).toFixed(0)}% of events 22:00&#8211;04:59 (flag at &#8805;35%)` : "share of events 22:00&#8211;04:59"),
    ].join("")}</div>`,
    "how you drive the machine · counted in-stream, no text stored"
  );

  // -- S3 rhythm -------------------------------------------------------------
  const monthlyRows = a.monthly_buckets ?? tok.monthly ?? [];
  const weekendPct = rhy.weekend_ratio ?? a.weekend_ratio;
  const weekBar =
    weekendPct != null
      ? `<div class="weekbar"><svg viewBox="0 0 100 12" preserveAspectRatio="none"><rect x="0" y="1" width="${((1 - weekendPct) * 100).toFixed(1)}" height="10" rx="2" fill="${C.cat[0]}"><title>weekday ${((1 - weekendPct) * 100).toFixed(0)}%</title></rect><rect x="${((1 - weekendPct) * 100 + 0.4).toFixed(1)}" y="1" width="${(weekendPct * 100 - 0.4).toFixed(1)}" height="10" rx="2" fill="${C.cat[2]}"><title>weekend ${(weekendPct * 100).toFixed(0)}%</title></rect></svg><div class="legend"><span class="lg"><span class="sw" style="background:${C.cat[0]}"></span>weekday ${((1 - weekendPct) * 100).toFixed(0)}%</span><span class="lg"><span class="sw" style="background:${C.cat[2]}"></span>weekend ${(weekendPct * 100).toFixed(0)}%</span></div></div>`
      : `<div class="empty">${DASH}</div>`;
  const s3 = panel(
    "RHYTHM",
    `<div class="grid2">
      <div><div class="chart-title">events by hour ${rhy.peak_hour != null ? `· peak ${String(rhy.peak_hour).padStart(2, "0")}:00` : ""}</div>${hourHistogramSvg(rhy.hour_buckets ?? a.hour_buckets, rhy.peak_hour)}</div>
      <div>
        <div class="chart-title">weekday / weekend</div>${weekBar}
        <div class="chart-title" style="margin-top:14px">sessions per month</div>${sparklineSvg((monthlyRows ?? []).map((m) => m.sessions ?? 0), "sessions per month")}
      </div>
    </div>
    <div class="chart-title" style="margin-top:14px">last 90 days</div>
    ${calendarStripSvg(rhy.active_days, today)}
    <div class="tiles" style="margin-top:14px">${[
      tile("busiest day", rhy.busiest_day ? `${esc(rhy.busiest_day.date)}` : DASH, rhy.busiest_day ? `${hval(rhy.busiest_day.tokens)} tokens` : null),
      tile("longest day", rhy.longest_day ? `${esc(rhy.longest_day.date)}` : DASH, rhy.longest_day ? `${val(rhy.longest_day.session_hours)} session-hours (not wall-clock)` : null),
    ].join("")}</div>
    <div class="cap">${esc(rhy.day_attribution_note ?? "sessions past midnight count entirely toward their start date")}</div>`,
    "all sources"
  );

  // -- S4 token economics ----------------------------------------------------
  const stack = tokenStackSvg(tok);
  const s4 = panel(
    "TOKEN ECONOMICS",
    `<div class="chart-title">four-counter split &#183; most of it is the same text, read again</div>
    ${stack.svg}${stack.legend}
    <div class="tiles" style="margin-top:14px">${[
      tile("new content", hval(tok.new_content), "fresh input + cache write + output"),
      tile("work vs cache", tok.work_tokens != null ? `${hval(tok.work_tokens)} <span class="dim">/</span> ${hval(tok.cache_tokens)}` : DASH, "in+out vs cache read+write"),
      tile("retail cost", tok.retail_cost_usd != null ? `$${fmt(tok.retail_cost_usd)}` : DASH, esc(tok.cost_note ?? "retail estimate")),
    ].join("")}</div>
    <div class="chart-title" style="margin-top:14px">tokens by month (last 6)</div>
    ${monthlyBarsSvg(
      (tok.monthly?.length ? tok.monthly : (a.monthly_buckets ?? []).map((m) => ({ month: m.month, tokens: (m.input_tokens ?? 0) + (m.output_tokens ?? 0) + (m.cache_tokens ?? 0) }))),
      "tokens",
      "tokens"
    )}
    ${tok.codex_note ? `<div class="cap">${esc(tok.codex_note)}</div>` : ""}`,
    "retail estimate — not what you paid"
  );

  // -- S5 tools & models -----------------------------------------------------
  const toolMix =
    del.tool_mix?.map((t) => ({ label: t.name, value: t.count, extra: t.share_pct != null ? `${t.share_pct}%` : null })) ??
    Object.entries(a.tool_call_counts ?? {}).slice(0, 8).map(([k, v]) => ({ label: k, value: v }));
  const provRows = mod.provider_sessions
    ? Object.entries(mod.provider_sessions).filter(([, n]) => n > 0).map(([k, v]) => ({ label: k, value: v, extra: "sessions" }))
    : [];
  const modelRows = Object.entries(mod.model_sessions ?? a.models ?? {}).slice(0, 6).map(([k, v]) => ({ label: k, value: v }));
  const rel = p.tool_relationship;
  const relLine =
    rel?.kind === "loyalist"
      ? `loyalist &#8212; ${clean(rel.tool)} across ${val(rel.months_count)} month(s), ${val(rel.sessions_count)} sessions`
      : rel?.kind === "switch"
      ? `switched ${clean(rel.from_tool)} &#8594; ${clean(rel.to_tool)} in ${clean(rel.switch_month)}`
      : rel?.kind === "polyglot"
      ? `polyglot &#8212; ${(rel.tools ?? []).map((t) => `${clean(t.tool)} ${(t.share * 100).toFixed(0)}%`).join(" · ")}`
      : DASH;
  const s5 = panel(
    "TOOLS & MODELS",
    `<div class="grid2">
      <div><div class="chart-title">tool mix (top 8)</div>${barList(toolMix)}
        <div class="tiles" style="margin-top:12px">${[
          tile("orchestration", val(del.orchestration_pct, "%"), "Task share"),
          tile("operator", val(del.operator_pct, "%"), "Bash/shell share"),
        ].join("")}</div></div>
      <div><div class="chart-title">providers (dominant model per session)</div>${barList(provRows)}
        <div class="chart-title" style="margin-top:12px">models</div>${barList(modelRows)}
        ${mod.top_model ? `<div class="cap">top model ${clean(mod.top_model)} &#183; ${val(mod.top_model_share_pct, "%")} of modeled sessions</div>` : ""}</div>
    </div>
    <div class="verdict">tool relationship: ${relLine}</div>
    <div class="tiles" style="margin-top:12px">${[
      tile("peak agents", val(con.open_peak), "max simultaneous sessions"),
      tile("avg open", val(con.open_avg), "time-weighted over active wall-clock"),
      tile("juggle", val(con.juggle_pct, "%"), "active minutes with &#8805;2 sessions"),
      tile("longest session", val(con.longest_session_hours, "h"), "by active duration"),
    ].join("")}</div>`
  );

  // -- S6 craft --------------------------------------------------------------
  const langRows = Object.entries(p.languages ?? a.languages ?? {})
    .sort((x, y) => y[1] - x[1])
    .slice(0, 10)
    .map(([k, v]) => ({ label: k, value: v, extra: "files" }));
  const projRows = (p.projects ?? a.projects ?? []).slice(0, 10).map((pr) => ({ label: pr.name, value: pr.sessions, extra: "sessions" }));
  const prof = p.proficiency;
  const gInputs = (o) =>
    o ? Object.entries(o).map(([k, v]) => `${esc(k.replaceAll("_", " "))}: ${v == null ? "&#8212;" : esc(typeof v === "number" && v >= 1000 ? human(v) : v)}`).join(" · ") : "";
  const s6 = panel(
    "CRAFT",
    `<div class="grid2">
      <div><div class="chart-title">languages (from masked file paths)</div>${barList(langRows)}</div>
      <div><div class="chart-title">top projects</div>${barList(projRows)}</div>
    </div>
    <div class="chart-title" style="margin-top:14px">proficiency (local gauges &#8212; no cohort, no fake score)</div>
    <div class="grid3">
      ${gauge("intensity", prof?.intensity?.gauge, gInputs(prof?.intensity?.inputs))}
      ${gauge("consistency", prof?.consistency?.gauge, gInputs(prof?.consistency?.inputs))}
      ${gauge("craft", prof?.craft?.gauge, gInputs(prof?.craft?.inputs))}
    </div>
    <div class="cap">Cowork sessions are knowledge work: counted in rhythm/cadence, excluded here.</div>`,
    "code sources only"
  );

  // -- S7 records ------------------------------------------------------------
  const recRow = (label, r, valueHtml) =>
    `<tr><th>${esc(label)}</th><td>${r ? valueHtml : DASH}</td><td>${r?.date ? esc(r.date) : DASH}</td><td>${r?.project ? clean(r.project) : DASH}</td><td>${r?.id ? clean(r.id) : DASH}</td></tr>`;
  const fl = rec.first_last_seen ?? {};
  const s7 = panel(
    "RECORDS",
    `<div class="scroll"><table>
      <thead><tr><th>record</th><th>value</th><th>date</th><th>project</th><th>session</th></tr></thead>
      <tbody>
        ${recRow("longest session (duration)", rec.longest_session, `${val(rec.longest_session?.hours)}h`)}
        ${recRow("most tokens in a session", rec.most_tokens_session, hval(rec.most_tokens_session?.tokens))}
        ${recRow("most turns in a session", rec.most_turns_session, val(rec.most_turns_session?.turns))}
        ${recRow("biggest day (tokens)", rec.biggest_day, hval(rec.biggest_day?.tokens))}
      </tbody>
    </table></div>
    ${Object.keys(fl).length ? `<div class="chart-title" style="margin-top:12px">first / last seen per source</div><div class="scroll"><table><thead><tr><th>source</th><th>first seen</th><th>last seen</th><th>files</th></tr></thead><tbody>${Object.values(fl)
      .map((s) => `<tr><td>${clean(s.label)}</td><td>${val(s.first_seen)}</td><td>${val(s.last_seen)}</td><td>${val(s.files)}</td></tr>`)
      .join("")}</tbody></table></div>` : ""}`
  );

  // -- optional archive universes (never mixed with the session universe) ----
  const extra = [
    ["ACCOUNTS", accounts, "universe: per-account archive totals"],
    ["FLEET", fleet, "universe: per-machine archive totals"],
    ["PROVIDERS", providers, "universe: per-provider archive totals"],
  ]
    .map(([t, d, sub]) => {
      const tbl = genericTable(d);
      return tbl ? panel(t, tbl, sub) : "";
    })
    .join("");

  const sourcesLine = (p.sources ?? []).map((s) => clean(s)).join(" · ") || DASH;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { color-scheme: dark; }
  body {
    background: ${C.bg}; color: ${C.ink};
    font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    font-size: 14px; line-height: 1.5; padding: 28px 16px 40px;
  }
  .wrap { max-width: 1100px; margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
  header h1 { font-size: 24px; letter-spacing: 6px; color: ${C.ink}; }
  header .sub { font-size: 12px; letter-spacing: 3px; color: ${C.muted}; margin-top: 4px; }
  .panel { background: ${C.panel}; border: 1px solid ${C.border}; padding: 18px; }
  .panel h2 { font-size: 13px; letter-spacing: 3px; color: ${C.ink2}; margin-bottom: 14px; border-bottom: 1px solid ${C.grid}; padding-bottom: 8px; }
  .panel h2 .sub { font-size: 11px; letter-spacing: 1px; color: ${C.faint}; text-transform: lowercase; }
  .hero { display: flex; gap: 18px; flex-wrap: wrap; align-items: stretch; }
  .hero .star { flex: 1 1 420px; min-width: 300px; background: ${C.panel}; border: 1px solid ${C.border}; padding: 6px; }
  .hero .star svg { width: 100%; height: auto; display: block; }
  .hero-tiles { flex: 1 1 320px; align-content: start; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .tiles.six { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
  .tile { background: ${C.bg}; border: 1px solid ${C.grid}; padding: 12px; }
  .t-label { font-size: 11px; letter-spacing: 2px; color: ${C.muted}; text-transform: uppercase; }
  .t-value { font-size: 24px; color: ${C.ink}; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .t-value .dim, .dim { font-size: 13px; color: ${C.muted}; }
  .cap { font-size: 11px; color: ${C.faint}; margin-top: 6px; }
  .chart-title { font-size: 12px; letter-spacing: 1px; color: ${C.ink2}; margin-bottom: 8px; }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px; }
  .grid3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
  svg { display: block; max-width: 100%; }
  .tick { font-size: 10px; fill: ${C.muted}; font-family: inherit; }
  .cap svg, .peak { font-size: 10px; }
  .peak { fill: ${C.ink2}; font-family: inherit; }
  text.cap { fill: ${C.ink2}; font-size: 10px; font-family: inherit; margin: 0; }
  .legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; font-size: 11px; color: ${C.ink2}; }
  .lg { display: inline-flex; align-items: center; gap: 5px; }
  .lg b { color: ${C.ink}; }
  .sw { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
  .bars { display: flex; flex-direction: column; gap: 6px; }
  .bar-row { display: grid; grid-template-columns: 120px 1fr 84px; gap: 8px; align-items: center; }
  .bar-label { font-size: 12px; color: ${C.ink2}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track svg { width: 100%; height: 12px; }
  .bar-val { font-size: 12px; color: ${C.ink}; text-align: right; font-variant-numeric: tabular-nums; }
  .bar-val i { color: ${C.faint}; font-style: normal; font-size: 10px; }
  .weekbar svg { width: 100%; height: 12px; }
  .verdict { margin-top: 14px; padding: 10px 12px; border-left: 2px solid ${C.accent}; background: ${C.bg}; font-size: 13px; color: ${C.ink}; }
  .gauge { background: ${C.bg}; border: 1px solid ${C.grid}; padding: 12px; }
  .gauge-head { display: flex; justify-content: space-between; font-size: 12px; letter-spacing: 1px; color: ${C.ink2}; margin-bottom: 8px; }
  .gauge-head b { color: ${C.ink}; }
  .gauge svg { width: 100%; height: 8px; }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid ${C.grid}; white-space: nowrap; }
  th { color: ${C.muted}; font-weight: normal; letter-spacing: 1px; font-size: 11px; }
  td { color: ${C.ink}; font-variant-numeric: tabular-nums; }
  .empty { color: ${C.faint}; font-size: 12px; padding: 8px 0; }
  footer { border-top: 1px solid ${C.grid}; padding-top: 14px; font-size: 11px; letter-spacing: 1px; color: ${C.faint}; display: flex; flex-direction: column; gap: 4px; }
  footer .priv { color: ${C.ink2}; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${clean(name ?? "STARFORGE")}</h1>
    <div class="sub">LOCAL STATS &#183; ${esc(today)} &#183; sources: ${sourcesLine}</div>
  </header>
  ${hero}
  ${s2}
  ${s3}
  ${s4}
  ${s5}
  ${s6}
  ${s7}
  ${extra}
  <footer>
    <div class="priv">computed locally &#183; nothing uploaded</div>
    <div>computed locally from your session logs; no text left this machine; nothing was uploaded. prompt text was counted in-stream and never stored.</div>
    <div>numbers are floors, not lifetime totals &#8212; this is what survives on disk (cleanup may have deleted older logs). secrets redacted &#183; paths masked.</div>
    <div>generated ${esc(p.generated_at ?? new Date().toISOString())} &#183; ${val(p.files_scanned)} files scanned</div>
  </footer>
</div>
</body>
</html>`;
}
