// Porter-Grade HUD card: self-contained SVG, no deps. Dark holographic look —
// pentagram web, glow, per-axis levels, skill-overview + attributes panels.
import { AXES } from "./star.mjs";

const W = 1280, H = 720;
const CX = 640, CY = 380, R = 230;

function tip(i, radius) {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
  return [CX + radius * Math.cos(a), CY + radius * Math.sin(a)];
}

function fmt(n) {
  return n.toLocaleString("en-US");
}

export function renderCard(levels, agg, vel, opts = {}) {
  const name = opts.name ?? "SKILL SCREEN";
  const tips = levels.map((lv, i) => tip(i, (Math.max(lv, 0.5) / 5) * R));
  const maxTips = levels.map((_, i) => tip(i, R));
  const inner = levels.map((_, i) => {
    const a = -Math.PI / 2 + ((i + 0.5) * 2 * Math.PI) / 5;
    const r =
      R * 0.38 *
      ((Math.max(levels[i], 0.5) + Math.max(levels[(i + 1) % 5], 0.5)) / 10);
    return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
  });
  const pt = ([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`;

  // star hull path: tip0 inner0 tip1 inner1 ...
  const hull = [];
  for (let i = 0; i < 5; i++) hull.push(pt(tips[i]), pt(inner[i]));

  // pentagram web: every tip to every other tip + spokes
  let web = "";
  for (let i = 0; i < 5; i++) {
    for (let j = i + 1; j < 5; j++)
      web += `<line x1="${tips[i][0]}" y1="${tips[i][1]}" x2="${tips[j][0]}" y2="${tips[j][1]}"/>`;
    web += `<line x1="${CX}" y1="${CY}" x2="${tips[i][0]}" y2="${tips[i][1]}"/>`;
  }

  // node dots along each spoke
  let nodes = "";
  for (let i = 0; i < 5; i++) {
    for (let k = 1; k <= 3; k++) {
      const [x, y] = tip(i, ((Math.max(levels[i], 0.5) / 5) * R * k) / 3);
      nodes += `<circle cx="${x}" cy="${y}" r="3" fill="#bfefff"/>`;
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
  <circle cx="${CX}" cy="${CY}" r="${R * 0.62}" stroke-dasharray="1 5" opacity="0.6"/>
  <circle cx="${CX}" cy="${CY}" r="${R * 1.22}" stroke-dasharray="14 40" stroke-width="3" opacity="0.5"/>
</g>

<!-- max-extent ghost star -->
<polygon points="${levels.map((_, i) => pt(maxTips[i])).join(" ")}" fill="none" stroke="#123c58" stroke-dasharray="3 6"/>

<!-- web -->
<g stroke="#2fa8dd" stroke-width="1" opacity="0.55" filter="url(#glow)">${web}</g>

<!-- hull -->
<polygon points="${hull.join(" ")}" fill="#39c2ff18" stroke="#7fe0ff" stroke-width="2.5" filter="url(#bigglow)"/>

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
