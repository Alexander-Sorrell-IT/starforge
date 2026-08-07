// Porter-Grade HUD card: self-contained SVG, no deps. Dark holographic look —
// pentagram web, glow, per-axis levels, skill-overview + attributes panels.
import {
  AXES,
  ARMS,
  MAX_LEVEL,
  VALLEY_RATIO,
  armAngle,
  armRadius,
  armTips,
  starPoints,
  clampLevel,
} from "./starsvg.mjs";

const W = 1280, H = 720;
const CX = 640, CY = 380, R = 230;

function tip(i, radius) {
  const a = armAngle(i);
  return [CX + radius * Math.cos(a), CY + radius * Math.sin(a)];
}

function fmt(n) {
  return n.toLocaleString("en-US");
}

export function renderCard(rawLevels, agg, vel, opts = {}) {
  const name = opts.name ?? "SKILL SCREEN";
  // Same clamping starsvg.mjs does, and for the same reason: computeLevels can
  // hand back NaN from a corrupt snapshot (loadTimeline swallows parse errors),
  // and this renderer used to take that at face value — printing "LV. NaN" and
  // "NaN/25" on the card while the SVG renderer drew the identical arm as 0.
  // Two renderers disagreeing about one input is worse than either being wrong.
  // Infinity was worse still: `k <= Math.floor(Infinity)` looped emitting node
  // dots until V8 hit its maximum string length and threw.
  const levels = Array.from({ length: ARMS }, (_, i) => clampLevel(rawLevels?.[i]));
  // Geometry comes from starsvg.mjs so this card, the terminal frame and the
  // per-month chips are all literally the same shape. Arm length is that axis
  // and nothing else; the valleys are fixed, so a lopsided profile stays
  // lopsided instead of being averaged back toward a circle.
  const tips = armTips(levels, R, CX, CY);
  const maxTips = levels.map((_, i) => tip(i, R));
  const pt = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;
  const hull = starPoints(levels, R, CX, CY).map(pt);
  const maxHull = starPoints(new Array(ARMS).fill(MAX_LEVEL), R, CX, CY).map(pt);

  // Reference rings at every whole level, so an arm's length is countable.
  let ringSvg = "";
  for (let k = 1; k <= MAX_LEVEL; k++)
    ringSvg += `<circle cx="${CX}" cy="${CY}" r="${armRadius(k, R).toFixed(1)}" stroke-dasharray="${k === MAX_LEVEL ? "none" : "1 7"}" opacity="${k === MAX_LEVEL ? 0.45 : 0.22}"/>`;
  ringSvg += `<circle cx="${CX}" cy="${CY}" r="${(R * VALLEY_RATIO).toFixed(1)}" opacity="0.3"/>`;

  // Pentagram web + spokes drawn at FULL extent, not at the current levels:
  // this is the frame the silhouette is read against, so it has to stay still.
  // Wiring it to the live tips instead made the backdrop move with the data and
  // left nothing fixed to judge the shape against.
  let web = "";
  for (let i = 0; i < ARMS; i++) {
    for (let j = i + 1; j < ARMS; j++)
      web += `<line x1="${maxTips[i][0].toFixed(1)}" y1="${maxTips[i][1].toFixed(1)}" x2="${maxTips[j][0].toFixed(1)}" y2="${maxTips[j][1].toFixed(1)}"/>`;
    web += `<line x1="${CX}" y1="${CY}" x2="${maxTips[i][0].toFixed(1)}" y2="${maxTips[i][1].toFixed(1)}"/>`;
  }

  // Node dots stepping out along each arm, one per whole level it has reached —
  // the arm's length is also readable as a count.
  let nodes = "";
  for (let i = 0; i < ARMS; i++) {
    for (let k = 1; k <= Math.floor(levels[i]); k++) {
      const [x, y] = tip(i, armRadius(k, R));
      nodes += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#bfefff"/>`;
    }
  }

  // labels
  const labelAt = (i) => {
    let [x, y] = tip(i, R + 46);
    if (i === 1 || i === 4) y -= 70; // clear the side panels
    const anchor = i === 0 ? "middle" : i < 3 ? "start" : "end";
    const lv = levels[i] % 1 ? levels[i].toFixed(1) : levels[i].toFixed(0);
    return `<text x="${x}" y="${y}" text-anchor="${anchor}" class="axis">${AXES[i]}</text>
      <text x="${x}" y="${y + 24}" text-anchor="${anchor}" class="lv">LV. ${lv}</text>`;
  };

  const total = levels.reduce((a, b) => a + b, 0);
  const tokens = agg.total_input_tokens + agg.total_output_tokens;
  const cache = agg.total_cache_read_tokens + agg.total_cache_write_tokens;
  const cachePct = tokens + cache > 0 ? ((cache / (tokens + cache)) * 100).toFixed(1) : "0";
  const rating = total >= 22 ? "S+" : total >= 20 ? "S" : total >= 17 ? "A" : total >= 13 ? "B" : "C";

  const row = (y, k, v) =>
    `<text x="24" y="${y}" class="k">${k}</text><text x="286" y="${y}" text-anchor="end" class="v">${v}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
  <radialGradient id="bg" cx="50%" cy="52%" r="75%">
    <stop offset="0%" stop-color="#04121e"/><stop offset="100%" stop-color="#010409"/>
  </radialGradient>
  <radialGradient id="hull" gradientUnits="userSpaceOnUse" cx="${CX}" cy="${CY}" r="${R}">
    <stop offset="0%" stop-color="#7fe0ff" stop-opacity="0.42"/>
    <stop offset="100%" stop-color="#2aa8e0" stop-opacity="0.13"/>
  </radialGradient>
  <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
    <feGaussianBlur stdDeviation="6" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="bigglow" x="-80%" y="-80%" width="260%" height="260%">
    <feGaussianBlur stdDeviation="14" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <style>
    text { font-family: 'SF Mono','JetBrains Mono',Menlo,monospace; fill: #cfeeff; }
    .title { font-size: 34px; letter-spacing: 6px; fill: #e8f7ff; }
    .sub { font-size: 13px; letter-spacing: 3px; fill: #6fb9d8; }
    .axis { font-size: 17px; letter-spacing: 2px; fill: #dff5ff; }
    .lv { font-size: 15px; letter-spacing: 2px; fill: #7fd4f7; }
    .panelt { font-size: 13px; letter-spacing: 3px; fill: #9fdcf5; }
    .k { font-size: 13px; letter-spacing: 1px; fill: #6fb9d8; }
    .v { font-size: 13px; fill: #e8f7ff; }
    .foot { font-size: 12px; letter-spacing: 2px; fill: #58a7c9; }
  </style>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>

<!-- ambient rings -->
<g stroke="#0e3a55" fill="none" opacity="0.8">
  <circle cx="${CX}" cy="${CY}" r="${R + 24}" stroke-dasharray="2 7"/>
  <circle cx="${CX}" cy="${CY}" r="${R * 1.22}" stroke-dasharray="14 40" stroke-width="3" opacity="0.5"/>
</g>

<!-- level rings: one per whole level -->
<g stroke="#1d5f83" fill="none">${ringSvg}</g>

<!-- max-extent ghost star: the same silhouette with every arm at 5, so the
     gap between the hull and this outline is the part not yet earned -->
<polygon points="${maxHull.join(" ")}" fill="none" stroke="#1b587d" stroke-dasharray="4 7"/>

<!-- web -->
<g stroke="#2fa8dd" stroke-width="1" opacity="0.55" filter="url(#glow)">${web}</g>

<!-- hull -->
<polygon points="${hull.join(" ")}" fill="url(#hull)" stroke="#8be6ff" stroke-width="2.5" stroke-linejoin="round" filter="url(#bigglow)"/>

<!-- nodes + tips -->
${nodes}
${tips.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="5.5" fill="#eaffff" filter="url(#glow)"/>`).join("")}
<circle cx="${CX}" cy="${CY}" r="4" fill="#eaffff" filter="url(#glow)"/>

<!-- labels -->
${levels.map((_, i) => labelAt(i)).join("")}

<!-- header -->
<text x="64" y="78" class="title">${name}</text>
<line x1="64" y1="94" x2="560" y2="94" stroke="#1c5c82"/>
<text x="64" y="118" class="sub">CUSTOM SKILL MATRIX &#8226; RATING: ${rating}</text>

<!-- skill overview panel -->
<g transform="translate(64,300)">
  <rect x="0" y="0" width="300" height="128" fill="#03141f" stroke="#155273" opacity="0.92"/>
  <text x="24" y="28" class="panelt">SKILL OVERVIEW</text>
  ${row(56, "TOTAL SKILL POINTS", `${total.toFixed(1)}/25`)}
  ${row(80, "SESSIONS", fmt(agg.total_sessions))}
  ${row(104, "ACTIVE HOURS", agg.total_duration_hours)}
</g>

<!-- attributes panel -->
<g transform="translate(916,300)">
  <rect x="0" y="0" width="300" height="176" fill="#03141f" stroke="#155273" opacity="0.92"/>
  <text x="24" y="28" class="panelt">ATTRIBUTES</text>
  ${row(56, "TOKENS (IN+OUT)", fmt(tokens))}
  ${row(80, "CACHE SHARE", `${cachePct}%`)}
  ${row(104, "LONGEST STREAK", `${agg.longest_streak_days}d`)}
  ${row(128, "ACTIVE DAYS", agg.active_days)}
  ${row(152, "VELOCITY", vel?.hours_trend_per_month != null ? `${vel.hours_trend_per_month > 0 ? "+" : ""}${vel.hours_trend_per_month}h/mo` : "n/a")}
</g>

<!-- footer -->
<line x1="64" y1="664" x2="${W - 64}" y2="664" stroke="#12405c"/>
<text x="64" y="690" class="foot">STARFORGE &#8226; LOCAL-ONLY SCAN &#8226; SECRETS REDACTED &#8226; PATHS MASKED</text>
<text x="${W - 64}" y="690" text-anchor="end" class="foot">${new Date().toISOString().slice(0, 10)}</text>
</svg>`;
}
