// The skill star, as geometry and as SVG. One definition of the shape, used by
// the terminal renderer (star.mjs), the HUD card (card.mjs), the stats page and
// the per-snapshot chips — so the silhouette you see scrolling past during a
// scan is the same silhouette that lands in the SVG.
//
// The shape is the point. Each arm's length is set by that axis alone, and the
// valleys between arms sit at a FIXED radius, so a maxed axis reads as a long
// spike and a weak one as a stub you can see from across the room. An earlier
// version placed each valley at the average of its two neighbouring levels: the
// arm TIPS were fine, but the notch between a 5 and a 1 landed at exactly the
// radius of the notch between two 3s, so the outline stopped separating those
// two profiles at the point it should have separated them hardest.
//
// Consequence of the fixed valley: level 0 does not collapse to the centre, it
// lands ON the valley ring — the star floors at a regular pentagon and every
// arm grows outward from there. That keeps the hull convex-ish and non
// self-intersecting at any level combination, and it makes "no arm" a shape
// you can recognise rather than a degenerate spike.

// The comments are the ACTUAL inputs computeLevels() uses (src/star.mjs) —
// they drifted once already, describing "long sessions" and "files touched"
// that no formula ever read.
export const AXES = [
  "FIRST PRINCIPLES", // tokens in+out
  "ENGINEERING",      // distinct projects + distinct languages
  "CODING",           // tool calls
  "OUTSIDE THE BOX",  // distinct models + night-hour events (00:00-05:59)
  "TENACITY",         // longest streak + active days
];

export const ARMS = AXES.length;

// Ceiling. Raised 5 -> 7 because 5 was below the top of observed practice, so
// the scale stopped measuring exactly where it mattered.
//
// computeLevels' lg() is monotonic and unbounded; only Math.min(MAX_LEVEL, ..)
// discards information. Measured on a real 20,217-transcript corpus, the raw
// axis values were 7.0 / 5.8 / 5.4 / 5.4 / 4.6 — four of five past the old
// ceiling. A user doing TEN TIMES that work scored identically: 25.0/25 both
// times. The star could not tell them apart.
//
// At 7 the same profiles separate: a heavy user 67%, that corpus 86%, ten
// times it 95%. Nothing else changes — lg() is untouched, so a level keeps its
// old meaning and every arm below 5 renders exactly as before; the rings,
// ghost hull and the /35 footer all derive from this constant.
//
// It is deliberately NOT set far above the observed maximum. A ceiling twice
// anything ever measured makes every real user look like a beginner, which is
// a different way of not measuring.
export const MAX_LEVEL = 7;

// Where the valleys sit, as a fraction of full arm length. Also the radius of
// the level-0 pentagon.
export const VALLEY_RATIO = 0.3;

const TAU = Math.PI * 2;

export function clampLevel(lv) {
  const n = Number(lv);
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_LEVEL, Math.max(0, n));
}

// Angle of arm i's tip. Arm 0 points straight up, then clockwise.
export function armAngle(i) {
  return -Math.PI / 2 + (i * TAU) / ARMS;
}

// Angle of the valley between arm i and arm i+1.
export function valleyAngle(i) {
  return -Math.PI / 2 + ((i + 0.5) * TAU) / ARMS;
}

// The whole shape rule, in one line: level 0 sits on the valley ring, level 5
// reaches R, and everything between is linear in the level. Nothing about arm
// i depends on any other arm.
export function armRadius(level, R) {
  return R * VALLEY_RATIO + (clampLevel(level) / MAX_LEVEL) * R * (1 - VALLEY_RATIO);
}

// Hull vertices, tip/valley alternating, starting at arm 0's tip.
// `squash` compresses y for terminal cells, which are taller than they are wide.
export function starPoints(levels, R, cx = 0, cy = 0, { squash = 1 } = {}) {
  const pts = [];
  const vR = R * VALLEY_RATIO;
  for (let i = 0; i < ARMS; i++) {
    const a = armAngle(i);
    const r = armRadius(levels[i] ?? 0, R);
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a) * squash]);
    const va = valleyAngle(i);
    pts.push([cx + vR * Math.cos(va), cy + vR * Math.sin(va) * squash]);
  }
  return pts;
}

export function armTips(levels, R, cx = 0, cy = 0, { squash = 1 } = {}) {
  return levels.map((lv, i) => {
    const a = armAngle(i);
    const r = armRadius(lv, R);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a) * squash];
  });
}

const f = (n) => (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, "");
const poly = (pts) => pts.map(([x, y]) => `${f(x)},${f(y)}`).join(" ");

function fmtLevel(lv) {
  const n = clampLevel(lv);
  return n % 1 ? n.toFixed(1) : n.toFixed(0);
}

// Every <defs> id is suffixed, because the stats page inlines a dozen of these
// into one document and duplicate ids would make every star adopt the first
// star's gradients and filters.
let uid = 0;
function nextNs() {
  uid += 1;
  return `s${uid}`;
}

/**
 * Render the star as a standalone, self-contained SVG.
 *
 * levels — 5 numbers, 0..5, in AXES order.
 * opts.size      — square viewport edge in px (default 520)
 * opts.labels    — draw axis names + LV numbers (default true)
 * opts.rings     — draw the 1..5 reference rings (default true)
 * opts.ghost     — draw the dashed all-5s outline behind the hull (default true)
 * opts.footer    — small caption under the star (e.g. a month)
 * opts.title     — <title> for accessibility / tooltip
 * opts.bare      — no background rect (for embedding on an existing panel)
 */
export function renderStarSvg(levels, opts = {}) {
  const lv = Array.from({ length: ARMS }, (_, i) => clampLevel(levels?.[i] ?? 0));
  const size = opts.size ?? 520;
  const labels = opts.labels ?? true;
  const rings = opts.rings ?? true;
  const ghost = opts.ghost ?? true;
  const bare = opts.bare ?? false;
  const ns = nextNs();

  const cx = size / 2;
  // With labels the top/bottom text needs room, so the star sits slightly high
  // and smaller; without labels it uses the whole box.
  const cy = size * 0.5;
  // Labelled mode has to leave room for the longest axis name on BOTH sides —
  // "OUTSIDE THE BOX" is 15 characters and hangs left off an end-anchored point.
  // At the old radius it ran off the canvas and rendered clipped.
  const R = size * (labels ? 0.24 : 0.42);

  const hull = starPoints(lv, R, cx, cy);
  const tips = armTips(lv, R, cx, cy);
  const maxHull = starPoints(new Array(ARMS).fill(MAX_LEVEL), R, cx, cy);

  // Animation: the arms GROW out of the level-0 pentagon to their real length,
  // overshoot slightly, then settle. It is the same silhouette either way — the
  // motion just makes the lopsidedness legible, because you watch one arm keep
  // going after its neighbours have stopped. SMIL rather than CSS because the
  // thing that has to move is a polygon's `points`, which CSS cannot animate,
  // and SMIL keeps the file self-contained with no script (a <script> would be
  // both a CSP problem and a thing a reader has to audit).
  const animate = opts.animate ?? false;
  const dur = opts.duration ?? 1.6;
  const zero = new Array(ARMS).fill(0);
  // Overshoot each arm 6% past its final radius, clamped so nothing escapes R.
  const over = lv.map((v) => Math.min(MAX_LEVEL, v + (MAX_LEVEL - v) * 0.06 + 0.12));
  const framePts = (levels) => poly(starPoints(levels, R, cx, cy));
  const hullAnim = animate
    ? `<animate attributeName="points" dur="${dur}s" fill="freeze" calcMode="spline"
        keyTimes="0;0.72;1" keySplines="0.16 0.8 0.3 1;0.4 0 0.2 1"
        values="${framePts(zero)};${framePts(over)};${framePts(lv)}"/>`
    : "";
  // Each tip rides its own arm out, staggered so they do not all arrive at once.
  const tipAnim = (i) => {
    if (!animate) return "";
    const at = (levels) => armTips(levels, R, cx, cy)[i];
    const step = (levels) => { const p = new Array(ARMS).fill(0); p[i] = levels[i]; return at(p); };
    const [x0, y0] = step(zero), [x1, y1] = step(over), [x2, y2] = step(lv);
    const begin = (i * 0.06).toFixed(2);
    return `<animate attributeName="cx" dur="${dur}s" begin="${begin}s" fill="freeze" calcMode="spline"
        keyTimes="0;0.72;1" keySplines="0.16 0.8 0.3 1;0.4 0 0.2 1" values="${f(x0)};${f(x1)};${f(x2)}"/>
      <animate attributeName="cy" dur="${dur}s" begin="${begin}s" fill="freeze" calcMode="spline"
        keyTimes="0;0.72;1" keySplines="0.16 0.8 0.3 1;0.4 0 0.2 1" values="${f(y0)};${f(y1)};${f(y2)}"/>`;
  };

  // Reference rings at each whole level, so the arms are countable and not
  // just vibes.
  let ringSvg = "";
  if (rings) {
    for (let k = 1; k <= MAX_LEVEL; k++) {
      const r = armRadius(k, R);
      ringSvg += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" ` +
        `stroke-dasharray="${k === MAX_LEVEL ? "none" : "1 6"}" opacity="${k === MAX_LEVEL ? 0.5 : 0.28}"/>`;
    }
    ringSvg += `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(R * VALLEY_RATIO)}" opacity="0.35"/>`;
  }

  // Spokes out to full extent, so a short arm visibly falls short of somewhere.
  let spokes = "";
  for (let i = 0; i < ARMS; i++) {
    const a = armAngle(i);
    spokes += `<line x1="${f(cx)}" y1="${f(cy)}" x2="${f(cx + R * Math.cos(a))}" y2="${f(cy + R * Math.sin(a))}"/>`;
  }

  const tipDots = tips
    .map(([x, y], i) =>
      `<circle cx="${f(animate ? cx : x)}" cy="${f(animate ? cy : y)}" r="${f(size * 0.011)}" fill="#eaffff" filter="url(#${ns}g)">${tipAnim(i)}</circle>`
    )
    .join("");

  let labelSvg = "";
  if (labels) {
    const fs = size * 0.026;
    for (let i = 0; i < ARMS; i++) {
      const a = armAngle(i);
      const lr = R + size * 0.045;
      const x = cx + lr * Math.cos(a);
      let y = cy + lr * Math.sin(a);
      const anchor = i === 0 ? "middle" : i === 1 || i === 2 ? "start" : "end";
      if (i === 0) y -= fs * 0.5;
      if (i === 3 || i === 2) y += fs * 0.8;
      labelSvg +=
        `<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" class="ax" font-size="${f(fs)}">${AXES[i]}</text>` +
        `<text x="${f(x)}" y="${f(y + fs * 1.15)}" text-anchor="${anchor}" class="lvn" font-size="${f(fs * 0.92)}">LV. ${fmtLevel(lv[i])}</text>`;
    }
  }

  const total = lv.reduce((a, b) => a + b, 0);
  const footer = opts.footer
    ? `<text x="${f(cx)}" y="${f(size - size * 0.03)}" text-anchor="middle" class="cap" font-size="${f(size * 0.034)}">${escapeText(opts.footer)}</text>`
    : "";

  const title = opts.title
    ? `<title>${escapeText(opts.title)}</title>`
    : `<title>skill star — ${AXES.map((ax, i) => `${ax} ${fmtLevel(lv[i])}`).join(", ")} (${total.toFixed(1)}/${ARMS * MAX_LEVEL})</title>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img">${title}
<defs>
  <radialGradient id="${ns}fill" cx="50%" cy="50%" r="60%">
    <stop offset="0%" stop-color="#7fe0ff" stop-opacity="0.42"/>
    <stop offset="100%" stop-color="#2aa8e0" stop-opacity="0.13"/>
  </radialGradient>
  <filter id="${ns}g" x="-60%" y="-60%" width="220%" height="220%">
    <feGaussianBlur stdDeviation="${f(size * 0.008)}" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="${ns}G" x="-80%" y="-80%" width="260%" height="260%">
    <feGaussianBlur stdDeviation="${f(size * 0.018)}" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <style>
    .ax { font-family: 'SF Mono','JetBrains Mono',Menlo,monospace; fill: #dff5ff; letter-spacing: 1.5px; }
    .lvn { font-family: 'SF Mono','JetBrains Mono',Menlo,monospace; fill: #7fd4f7; letter-spacing: 1.5px; }
    .cap { font-family: 'SF Mono','JetBrains Mono',Menlo,monospace; fill: #6fb9d8; letter-spacing: 2px; }
  </style>
</defs>
${bare ? "" : `<rect width="${size}" height="${size}" fill="#03101a"/>`}
<g stroke="#1d5f83" fill="none">${ringSvg}</g>
<g stroke="#164e6f" fill="none" opacity="0.7">${spokes}</g>
${ghost ? `<polygon points="${poly(maxHull)}" fill="none" stroke="#1b587d" stroke-width="1" stroke-dasharray="4 7"/>` : ""}
<polygon points="${animate ? framePts(zero) : poly(hull)}" fill="url(#${ns}fill)" stroke="#8be6ff" stroke-width="${f(size * 0.005)}" stroke-linejoin="round" filter="url(#${ns}G)">${hullAnim}</polygon>
${tipDots}
<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(size * 0.007)}" fill="#bfefff"/>
${labelSvg}
${footer}
</svg>`;
}

// Exported so card.mjs and statspage.mjs use THIS one. card.mjs interpolated the
// --name flag into the SVG raw: an ampersand made the file invalid XML, and
// because statspage.mjs inlines the SVG into the HTML page, a name containing
// </text><script>...</script> executed when the page was opened.
export function escapeText(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
}
