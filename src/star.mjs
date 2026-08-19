// The skill star in the terminal — drawn as a raster image, not as ASCII art.
//
// Each character cell carries TWO pixels: the upper half-block glyph "▀" is
// painted in the foreground colour and the cell's background colour shows
// through the lower half. That doubles vertical resolution and, because a
// terminal cell is about twice as tall as it is wide, makes the pixels roughly
// square — so the star is not stretched and does not need the fudge factor the
// old character-plot version used. The shape is supersampled and shaded, so
// arms read as solid luminous spikes instead of rows of asterisks.
//
// The geometry lives in starsvg.mjs and is shared with the SVG renderers: the
// silhouette that animates here during the scan is the one that lands on disk.
import {
  AXES,
  ARMS,
  MAX_LEVEL,
  armAngle,
  armRadius,
  starPoints,
  clampLevel,
} from "./starsvg.mjs";

export { AXES };

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

// Canvas. Pixels are (W) x (ROWS*2); one cell = two vertically stacked pixels.
// Base dimensions — used when no terminal width is available or terminal is narrow.
const W_BASE = 78;
const ROWS_BASE = 26;
const R_BASE = 16.5;

// Responsive canvas: wider star on wide terminals.
// Breakpoints chosen so the star fills the screen without exceeding ~2/3 of
// the width (labels need breathing room on both sides).
// ROWS scales proportionally — the star is always taller than it is wide
// because each cell is ~2px tall and 1px wide.
// opts.columns can be injected by callers / tests without touching process.stdout.
function canvasFor(columns) {
  const cols = typeof columns === "number" && columns > 0 ? columns : W_BASE;
  if (cols >= 140) return { W: 120, ROWS: 40, R: 25.5 };
  if (cols >= 100) return { W: 96,  ROWS: 32, R: 20.5 };
  return { W: W_BASE, ROWS: ROWS_BASE, R: R_BASE };
}

const UPPER = "▀"; // ▀

// 256-colour ramp, dark navy -> luminous cyan-white. Apple Terminal does not
// do 24-bit colour, so this stays inside the xterm-256 cube.
const cube = (r, g, b) => 16 + 36 * r + 6 * g + b;
const RAMP = [
  cube(0, 0, 1), cube(0, 1, 2), cube(0, 2, 3), cube(0, 3, 4),
  cube(1, 4, 5), cube(2, 4, 5), cube(3, 5, 5), cube(5, 5, 5),
];
// Density ramp for the no-colour fallback (piped output, NO_COLOR, dumb TERM).
const SHADE = [" ", " ", "░", "░", "▒", "▒", "▓", "█"];

function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + t * vx), dy = py - (ay + t * vy);
  return Math.hypot(dx, dy);
}

function inPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function minEdgeDist(px, py, pts) {
  let d = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const e = segDist(px, py, pts[j][0], pts[j][1], pts[i][0], pts[i][1]);
    if (e < d) d = e;
  }
  return d;
}

// Intensity field, 0..1, sampled at one pixel centre. Supersampled by the
// caller for anti-aliasing. CX/CY/R passed in so the function works for any
// canvas size — removing the dependency on the old module-level constants.
function intensityAt(x, y, hull, ghost, CX, CY, R) {
  const edge = minEdgeDist(x, y, hull);
  if (edge < 0.85) return 1; // the luminous outline of the silhouette
  if (inPoly(x, y, hull)) {
    // Brightest at the core, falling off outward — the same radial gradient the
    // SVG fill uses, so the two renderers read as the same object.
    const d = Math.min(1, Math.hypot(x - CX, y - CY) / R);
    return 0.72 - 0.26 * d;
  }
  if (minEdgeDist(x, y, ghost) < 0.7) return 0.2; // dashed max-extent reference
  const rr = Math.hypot(x - CX, y - CY);
  for (let k = 1; k <= MAX_LEVEL; k++) {
    if (Math.abs(rr - armRadius(k, R)) < 0.35 && ((x + y) & 3) === 0) return 0.14;
  }
  return 0;
}

function shadePixel(x, y, hull, ghost, CX, CY, R) {
  // 2x2 supersample.
  let acc = 0;
  for (let sy = 0; sy < 2; sy++)
    for (let sx = 0; sx < 2; sx++)
      acc += intensityAt(x + (sx + 0.5) / 2 - 0.5, y + (sy + 0.5) / 2 - 0.5, hull, ghost, CX, CY, R);
  return acc / 4;
}

function colorFor(v) {
  if (v <= 0.02) return null;
  const i = Math.min(RAMP.length - 1, Math.max(0, Math.round(v * (RAMP.length - 1))));
  return RAMP[i];
}

function useColor(stream) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  if (!stream?.isTTY) return false;
  const term = process.env.TERM ?? "";
  return term !== "dumb";
}

/**
 * Render one frame. Returns a string of ROWS lines.
 * levels   — 5 numbers 0..5 in AXES order.
 * opts.columns — terminal width; used to pick the canvas size. Defaults to
 *   process.stdout.columns when rendering to a live TTY. Pass a number in
 *   tests or when you want a specific size. Omit for the default 78-col canvas.
 */
export function renderStar(levels, opts = {}) {
  // Canvas dimensions — resolved once per frame from the terminal width.
  // opts.columns lets callers and tests inject a specific width without
  // touching process.stdout, keeping this function pure and side-effect-free.
  const termCols = opts.columns ?? process.stdout.columns;
  const { W, ROWS, R } = canvasFor(termCols);
  const PH = ROWS * 2;
  const CX = W / 2;
  const CY = PH / 2;

  const lv = Array.from({ length: ARMS }, (_, i) => clampLevel(levels?.[i] ?? 0));
  // opts.progress: per-arm growth factor 0→1, used by the arm-tip animation.
  // Defaults to 1 for every arm (fully grown). When an arm is growing, its
  // effective level is lv[i] * progress[i], which shrinks its hull polygon
  // without touching any other state — arms already done stay full.
  const prog = opts.progress;
  const effLv = prog
    ? Array.from({ length: ARMS }, (_, i) => clampLevel(lv[i] * (prog[i] ?? 1)))
    : lv;
  const color = opts.color ?? true;
  const hull = starPoints(effLv, R, CX, CY);
  const ghost = starPoints(new Array(ARMS).fill(MAX_LEVEL), R, CX, CY);

  // Shade the pixel field.
  const px = Array.from({ length: PH }, (_, y) =>
    Array.from({ length: W }, (_, x) => shadePixel(x, y, hull, ghost, CX, CY, R))
  );

  // Text overlay, in CELL space — a label owns its whole cell, so it is applied
  // after rasterising rather than being blended into it.
  const text = Array.from({ length: ROWS }, () => new Array(W).fill(null));
  const put = (row, col, str, cls) => {
    for (let i = 0; i < str.length; i++) {
      const c = col + i;
      if (row >= 0 && row < ROWS && c >= 0 && c < W) text[row][c] = [str[i], cls];
    }
  };

  for (let i = 0; i < ARMS; i++) {
    const a = armAngle(i);
    const lr = R + 3.5;
    const tx = CX + lr * Math.cos(a);
    const ty = CY + lr * Math.sin(a);
    const row = Math.round(ty / 2);
    const n = lv[i] % 1 ? lv[i].toFixed(1) : lv[i].toFixed(0);
    const label = `${AXES[i]} LV.${n}`;
    if (i === 0) put(row - 1, Math.round(tx - label.length / 2), label, "ax");
    else if (i === 1 || i === 2) put(row, Math.min(Math.round(tx) + 2, W - label.length), label, "ax");
    else put(row, Math.max(0, Math.round(tx) - label.length - 2), label, "ax");
  }

  const total = lv.reduce((a, b) => a + b, 0);
  const foot = `SKILL POINTS ${total.toFixed(1)}/${ARMS * MAX_LEVEL}  ${opts.status ?? ""}`.trimEnd();
  put(ROWS - 1, Math.max(0, Math.floor((W - foot.length) / 2)), foot, "foot");

  // Compose cells.
  const out = [];
  for (let row = 0; row < ROWS; row++) {
    let line = "";
    let openStyle = false;
    for (let col = 0; col < W; col++) {
      const t = text[row][col];
      if (t) {
        const [ch, cls] = t;
        if (color) {
          const style = cls === "foot" ? `${DIM}\x1b[38;5;${RAMP[4]}m` : `${BOLD}\x1b[38;5;${RAMP[6]}m`;
          line += `${RESET}${style}${ch}${RESET}`;
        } else {
          line += ch;
        }
        openStyle = false;
        continue;
      }
      const top = px[row * 2][col];
      const bot = px[row * 2 + 1][col];
      if (color) {
        const ct = colorFor(top);
        const cb = colorFor(bot);
        if (ct == null && cb == null) {
          if (openStyle) { line += RESET; openStyle = false; }
          line += " ";
        } else {
          line += `\x1b[38;5;${ct ?? 16}m\x1b[48;5;${cb ?? 16}m${UPPER}`;
          openStyle = true;
        }
      } else {
        // One glyph must stand in for two pixels: use the brighter of the pair.
        const v = Math.max(top, bot);
        line += SHADE[Math.min(SHADE.length - 1, Math.round(v * (SHADE.length - 1)))];
      }
    }
    if (openStyle) line += RESET;
    out.push(line.replace(/\s+$/, ""));
  }
  return out.join("\n");
}

export class LiveStar {
  constructor(stream = process.stdout) {
    this.stream = stream;
    this.lines = 0;
    this.enabled = Boolean(stream?.isTTY);
    this.color = useColor(stream);
  }
  draw(levels, status, opts = {}) {
    if (!this.enabled) return;
    const frame = renderStar(levels, { status, color: this.color, columns: this.stream.columns, ...opts });
    const rows = frame.split("\n");
    if (this.lines > 0) this.stream.write(`\x1b[${this.lines}A`);
    this.stream.write(rows.map((l) => `\x1b[2K${l}`).join("\n") + "\n");
    this.lines = rows.length;
  }
  // Forge-pulse reveal: arms grow one at a time, tip-first, largest last —
  // like watching a shape being forged. Each arm grows from nothing to full
  // length over ~300ms; the next arm starts growing immediately after.
  // 5 arms × 300ms = ~1.5 s total, 60fps feels smooth even on slow terminals.
  //
  // Uses opts.progress so already-finished arms stay full while the current
  // arm grows — no sudden pops.
  //
  // When the terminal is not a TTY (piped, redirected, CI) the reveal is
  // skipped and the final frame is printed once.
  async finish(levels, status) {
    if (!this.enabled) {
      this.stream.write(renderStar(levels, { status, color: this.color, columns: this.stream.columns }) + "\n");
      return;
    }
    const lv = Array.from({ length: ARMS }, (_, i) => clampLevel(levels?.[i] ?? 0));

    // Order arms: smallest first, largest last — the dominant axis lands last
    // and holds the screen longest. On a tie, axis index breaks deterministically.
    const order = lv
      .map((v, i) => ({ v, i }))
      .sort((a, b) => a.v - b.v || b.i - a.i)
      .map((x) => x.i);

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const ARM_MS = 300;   // ms for one arm to grow from 0 → 1
    const FPS    = 60;
    const STEP   = 1000 / FPS;

    // progress[i]: growth factor 0→1 for each arm. Starts at 0 for all.
    const progress = new Array(ARMS).fill(0);
    // Arms that have already finished get progress 1 immediately.
    // We animate one arm at a time in `order`.
    for (let f = 0; f < order.length; f++) {
      const arm = order[f];
      const steps = Math.max(1, Math.round(ARM_MS / STEP));
      for (let s = 1; s <= steps; s++) {
        progress[arm] = s / steps;
        const isLast = f === order.length - 1 && s === steps;
        this.draw(
          lv,
          isLast ? status : "forging…",
          // Pass a COPY — draw() must not mutate it
          { progress: progress.slice() }
        );
        if (!isLast) await wait(STEP);
      }
      // Arm fully grown: lock it at 1 so it never redraws as partial
      progress[arm] = 1;
    }
    // Final draw at true levels with no progress override (clean frame)
    this.draw(lv, status);
  }
}

// ---------------------------------------------------------------------------
// Aggregate -> five levels. Works on a whole-history aggregate or on a single
// month's aggregate, which is what gives every snapshot its own star.

// THIS MONTH against EVERYTHING, side by side.
//
// Two stars answer different questions and neither replaces the other. The
// monthly star is the only one that can fall: it is drawn from one month, so a
// quiet month shows a small silhouette. The lifetime star only ever grows,
// because it accumulates snapshots that outlive the logs.
//
// Rendered as bars rather than two 78-column stars, because two of those side
// by side is 156 columns and nobody's terminal is that wide. The delta column
// is the point of the view: it says whether this month is above or below your
// own long-run shape, which is the one comparison that needs no other user to
// mean something.
//
// Plain text, no escape codes when color is off, so the same function produces
// what goes on screen AND what gets saved to a file.
export function renderCompare(monthly, lifetime, opts = {}) {
  const color = opts.color !== false;
  const b = (s) => (color ? BOLD + s + RESET : s);
  const d = (s) => (color ? DIM + s + RESET : s);
  const mL = monthly?.levels ?? new Array(ARMS).fill(0);
  const lL = lifetime?.levels ?? new Array(ARMS).fill(0);
  const bar = (v) => {
    const n = Math.round((clampLevel(v) / MAX_LEVEL) * 14);
    return "█".repeat(n) + "░".repeat(14 - n);
  };
  const out = [];
  out.push(b(`  this month (${monthly?.month ?? "?"})  vs  lifetime (${lifetime?.months ?? 0} month(s)${lifetime?.from ? `, ${lifetime.from}–${lifetime.to}` : ""})`));
  out.push("");
  out.push(d(`  ${"axis".padEnd(17)}${"month".padStart(6)}  ${"".padEnd(14)}  ${"life".padStart(5)}  ${"".padEnd(14)}   delta`));
  for (let i = 0; i < ARMS; i++) {
    const dv = mL[i] - lL[i];
    const sign = dv > 0.05 ? "+" : dv < -0.05 ? "" : " ";
    out.push(
      `  ${AXES[i].padEnd(17)}${mL[i].toFixed(1).padStart(6)}  ${bar(mL[i])}  ${lL[i].toFixed(1).padStart(5)}  ${bar(lL[i])}  ${sign}${dv.toFixed(1).padStart(5)}`
    );
  }
  const mT = mL.reduce((a, c) => a + c, 0);
  const lT = lL.reduce((a, c) => a + c, 0);
  out.push("");
  out.push(
    b(`  SKILL POINTS      ${mT.toFixed(1).padStart(6)}${"".padEnd(16)}${lT.toFixed(1).padStart(5)}${"".padEnd(16)}  ${mT - lT >= 0 ? "+" : ""}${(mT - lT).toFixed(1)}`) +
      d(`   of ${ARMS * MAX_LEVEL}`)
  );
  out.push("");
  if ((lifetime?.months ?? 0) <= 1) {
    out.push(
      d("  first run: lifetime IS this month, so every delta is zero. Run again")
    );
    out.push(d("  next month and the two shapes start to diverge."));
  } else {
    out.push(
      d("  lifetime only ever grows — it accumulates snapshots that outlive the")
    );
    out.push(d("  logs. A negative delta means a quieter month, not lost work."));
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Full compare report — two stars (plain text) + compare bars, for saving.
//
// `mine`  — { month, life }  — corpus snapshots for this machine
// `fleet` — { month, life }  — fleet aggregates, or null when no --fleet=DIR
//
// Returns a plain-text string (ANSI stripped) suitable for writing to a file.
// The same string is what [S] saves from the menu and --report writes
// automatically. color: false so the file is readable in any editor.
export function buildCompareReport({ mine, fleet, label = null } = {}) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const header = label ? `starreckon compare — ${label}\ngenerated ${stamp}\n` : `starreckon compare\ngenerated ${stamp}\n`;
  const HR = "─".repeat(62);
  const parts = [header];

  if (mine?.month && mine?.life) {
    parts.push(HR);
    parts.push("THIS MACHINE — this month vs lifetime");
    parts.push(HR);
    parts.push(renderStar(mine.month.levels ?? computeLevels(mine.month), { color: false, status: `this month · ${mine.month.month ?? ""}`.trimEnd() }));
    parts.push("");
    parts.push(renderStar(mine.life.levels ?? computeLevels(mine.life), { color: false, status: `lifetime · ${mine.life.months ?? "?"} month(s)` }));
    parts.push("");
    parts.push(renderCompare(mine.month, mine.life, { color: false }));
  } else if (mine?.life) {
    parts.push(HR);
    parts.push("THIS MACHINE — lifetime");
    parts.push(HR);
    parts.push(renderStar(mine.life.levels ?? computeLevels(mine.life), { color: false, status: `lifetime · ${mine.life.months ?? "?"} month(s)` }));
  }

  if (fleet?.month && fleet?.life) {
    parts.push("");
    parts.push(HR);
    parts.push("FLEET — this month vs lifetime");
    parts.push(HR);
    parts.push(renderStar(fleet.month.levels ?? [], { color: false, status: `fleet this month · ${fleet.month.month ?? ""}`.trimEnd() }));
    parts.push("");
    parts.push(renderStar(fleet.life.levels ?? [], { color: false, status: `fleet lifetime · ${fleet.life.months ?? "?"} month(s)` }));
    parts.push("");
    parts.push(renderCompare(fleet.month, fleet.life, { color: false }));
  } else if (fleet?.life) {
    parts.push("");
    parts.push(HR);
    parts.push("FLEET — lifetime");
    parts.push(HR);
    parts.push(renderStar(fleet.life.levels ?? [], { color: false, status: `fleet lifetime · ${fleet.life.months ?? "?"} month(s)` }));
  }

  // Strip any residual ANSI that crept in from renderStar/renderCompare
  return parts.join("\n").replace(/\x1b\[[0-9;]*m/g, "") + "\n";
}

// The five axes as data. Weights are exactly the ones the star has always used;
// `mid` is the value at which a term reads about 2.5 before weighting.
//
// ENGINEERING's language term is written 0.8 rather than the old `0.4 * 2`,
// which is the same number said once.
const AXIS_SPEC = [
  { terms: [{ input: "tokensM", label: "tokens in+out", unit: "M", mid: 5, weight: 1 }] },
  { terms: [
      { input: "projects", label: "projects", unit: "", mid: 4, weight: 0.6 },
      { input: "langs", label: "languages", unit: "", mid: 2, weight: 0.8 },
  ] },
  { terms: [{ input: "toolCalls", label: "tool calls", unit: "", mid: 2000, weight: 1 }] },
  { terms: [
      { input: "models", label: "models used", unit: "", mid: 1, weight: 0.7 },
      { input: "nightHours", label: "night hours", unit: "h", mid: 60, weight: 0.5 },
  ] },
  { terms: [
      { input: "streak", label: "longest streak", unit: "d", mid: 3, weight: 0.5 },
      { input: "activeDays", label: "active days", unit: "d", mid: 8, weight: 0.5 },
  ] },
];

export function computeLevels(agg) {
  // The 5 in lg() is the SCALE, not the ceiling: an axis reads 5.0 at v =
  // 10*mid and ~2.5 at mid, and that meaning is fixed so a level means the
  // same thing it did before MAX_LEVEL moved. The clamp is the ceiling, and it
  // must track MAX_LEVEL — hardcoding 5 here while starsvg said 7 raised the
  // denominator without raising the cap, so every saturated arm still read 5.0
  // and the star scored 24.1/35 instead of 27.6/35. Half a fix is a worse
  // number than no fix, because it looks deliberate.
  // Math.max(0, v) — log1p of anything below -1 is NaN, and a NaN arm poisons
  // the whole star (total, tier, archetype). explainLevels' copy of this helper
  // already clamped; this one did not, so a negative token counter in a
  // malformed transcript produced FIRST PRINCIPLES = NaN.
  const lg = (v, mid) => 5 * (Math.log1p(Math.max(0, v)) / Math.log1p(mid * 10)); // ~2.5 at mid
  const clamp = (v) => Math.min(MAX_LEVEL, Math.max(0, v));
  // Accepts either the whole-history aggregate (total_* / projects[] /
  // tool_call_counts{}) or one month's snapshot bucket, which stores the same
  // quantities pre-reduced (input_tokens / projects_count / tool_calls) so a
  // synced snapshot never has to carry a project name to draw its own star.
  const tokens =
    (agg.total_input_tokens ?? agg.input_tokens ?? 0) +
    (agg.total_output_tokens ?? agg.output_tokens ?? 0);
  const langs = Object.keys(agg.languages ?? {}).length;
  const projects = agg.projects_count ?? (agg.projects ?? []).length;
  const toolCalls =
    agg.tool_calls ??
    Object.values(agg.tool_call_counts ?? {}).reduce((a, b) => a + b, 0);
  const models = Object.keys(agg.models ?? {}).length;
  // Night activity is counted ABSOLUTELY, not as a share of the day. As a ratio
  // it made the axis non-monotonic in the worst way: every daytime event you
  // added SHRANK the arm, so a user watched OUTSIDE THE BOX collapse from 3.5 to
  // 1.5 while starreckon was still discovering their work, and the arm's length
  // was really a function of daytime tool volume — another axis's input. That
  // also broke the promise the whole shape rests on, that an arm answers to its
  // own axis and nothing else. Doing more work must never shorten an arm.
  // Real hours, or nothing. There used to be a fallback here that summed
  // hour_buckets[0..5] "for snapshots written before night_hours existed", and
  // it was not a fallback: no snapshot ever carried the key, so it was the only
  // path every persisted star took. hour_buckets is a per-EVENT tally, so the
  // arm was priced in log LINES against a mid of 60 calibrated in HOURS.
  // Measured on the live corpus: 137.3 real night hours scored as 450,107, a
  // 3,279x inflation that saturated OUTSIDE THE BOX at 7.0 for the lifetime
  // star and for three of eight months.
  //
  // An aggregate with no night_hours is night-hours UNMEASURED — it scores 0
  // here and explainLevels marks the term not-measured so a card says so
  // instead of drawing a short arm. It cannot be recomputed: hour_buckets is
  // the only night-ish thing a pre-key snapshot stored, and events are not
  // hours at any exchange rate. A month whose logs are still on disk regains
  // the key on the next scan.
  const nightHours = agg.night_hours ?? 0;

  // The axes are declared ONCE, as data, and both the score and the explanation
  // are computed from this same list. A card that re-implemented the formula to
  // show its working would be a second copy of the scoring — and the copies in
  // this codebase have never stayed in step (the rating ladder missed a rescale
  // in three files, the /25 denominator in five). Here a card that disagreed
  // with the star would be worse than no card: it would look like an audit.
  const inputs = {
    tokensM: tokens / 1e6,
    projects,
    langs,
    toolCalls,
    models,
    nightHours,
    streak: agg.longest_streak_days ?? 0,
    activeDays: agg.active_days ?? 0,
  };
  const levels = AXIS_SPEC.map((axis) =>
    +clamp(
      axis.terms.reduce((sum, t) => sum + lg(inputs[t.input], t.mid) * t.weight, 0)
    ).toFixed(1)
  );
  return levels;
}

/**
 * What each arm was measured FROM — same spec, same numbers as computeLevels.
 *
 * Returns one entry per axis: its level, and every term with the value that was
 * actually read and what that term contributed. This is the card's data source,
 * so "why is ENGINEERING short" has an answer that cannot drift from the score.
 */
export function explainLevels(agg, opts = {}) {
  const a = agg && typeof agg === "object" ? agg : {};
  // Which inputs the SOURCE could measure at all. Absent from this map means
  // "measured"; the fleet passes a map marking langs/toolCalls/nightHours false.
  // An unmeasured input scores 0 either way — the difference is that a card can
  // say "not measured" instead of drawing a short arm, which is a different
  // claim about the person.
  const avail = opts.available ?? null;
  // Two ways a term is unmeasured: the SOURCE says so, or the aggregate simply
  // does not carry it. night_hours is the second — a snapshot written before
  // the key existed holds no night measurement at all, and printing 0 h there
  // would say "worked no nights", which is a claim about the person that the
  // file does not support.
  const has = (k) => {
    if (avail && avail[k] === false) return false;
    if (k === "nightHours") return a.night_hours != null;
    return true;
  };
  const levels = computeLevels(a);
  const lg = (v, mid) => 5 * (Math.log1p(Math.max(0, v)) / Math.log1p(mid * 10));
  const tokens =
    (a.total_input_tokens ?? a.input_tokens ?? 0) + (a.total_output_tokens ?? a.output_tokens ?? 0);
  const inputs = {
    tokensM: tokens / 1e6,
    projects: a.projects_count ?? (a.projects ?? []).length,
    langs: Object.keys(a.languages ?? {}).length,
    toolCalls:
      a.tool_calls ?? Object.values(a.tool_call_counts ?? {}).reduce((x, y) => x + y, 0),
    models: Object.keys(a.models ?? {}).length,
    nightHours: a.night_hours ?? 0,
    streak: a.longest_streak_days ?? 0,
    activeDays: a.active_days ?? 0,
  };
  return AXIS_SPEC.map((axis, i) => ({
    axis: AXES[i],
    level: levels[i],
    // An axis with NO measurable term is unmeasured; one with some is a FLOOR,
    // because every term is a non-negative addition and the missing ones can
    // only push the arm up.
    measured: axis.terms.some((t) => has(t.input)),
    partial: axis.terms.some((t) => has(t.input)) && axis.terms.some((t) => !has(t.input)),
    // A saturated arm is worth flagging: it means the axis stopped measuring,
    // and more work will not lengthen it.
    capped: levels[i] >= MAX_LEVEL,
    terms: axis.terms.map((t) => ({
      label: t.label,
      measured: has(t.input),
      value: +(Number(inputs[t.input]) || 0).toFixed(1),
      unit: t.unit ?? "",
      contribution: +(lg(inputs[t.input], t.mid) * t.weight).toFixed(2),
      // "half marks at" — the value where this term reads ~2.5 before weighting.
      mid: t.mid,
    })),
  }));
}
