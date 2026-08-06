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
const W = 78;
const ROWS = 26;
const PH = ROWS * 2;
const CX = W / 2;
const CY = PH / 2;
const R = 16.5;

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
// caller for anti-aliasing.
function intensityAt(x, y, hull, ghost) {
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

function shadePixel(x, y, hull, ghost) {
  // 2x2 supersample.
  let acc = 0;
  for (let sy = 0; sy < 2; sy++)
    for (let sx = 0; sx < 2; sx++)
      acc += intensityAt(x + (sx + 0.5) / 2 - 0.5, y + (sy + 0.5) / 2 - 0.5, hull, ghost);
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
 * levels — 5 numbers 0..5 in AXES order.
 */
export function renderStar(levels, opts = {}) {
  const lv = Array.from({ length: ARMS }, (_, i) => clampLevel(levels?.[i] ?? 0));
  const color = opts.color ?? true;
  const hull = starPoints(lv, R, CX, CY);
  const ghost = starPoints(new Array(ARMS).fill(MAX_LEVEL), R, CX, CY);

  // Shade the pixel field.
  const px = Array.from({ length: PH }, (_, y) =>
    Array.from({ length: W }, (_, x) => shadePixel(x, y, hull, ghost))
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
  draw(levels, status) {
    if (!this.enabled) return;
    const frame = renderStar(levels, { status, color: this.color });
    const rows = frame.split("\n");
    if (this.lines > 0) this.stream.write(`\x1b[${this.lines}A`);
    this.stream.write(rows.map((l) => `\x1b[2K${l}`).join("\n") + "\n");
    this.lines = rows.length;
  }
  finish(levels, status) {
    if (this.enabled) this.draw(levels, status);
    else this.stream.write(renderStar(levels, { status, color: this.color }) + "\n");
  }
}

// ---------------------------------------------------------------------------
// Aggregate -> five levels. Works on a whole-history aggregate or on a single
// month's aggregate, which is what gives every snapshot its own star.

export function computeLevels(agg) {
  const lg = (v, mid) => 5 * (Math.log1p(v) / Math.log1p(mid * 10)); // ~2.5 at mid
  const clamp = (v) => Math.min(5, Math.max(0, v));
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
  const buckets = agg.hour_buckets ?? [];
  const nightHours = buckets.slice(0, 6).reduce((a, b) => a + b, 0);
  const nightRatio = buckets.length ? nightHours / Math.max(1, buckets.reduce((a, b) => a + b, 0)) : 0;
  return [
    clamp(lg(tokens / 1e6, 5)),                                  // FIRST PRINCIPLES
    clamp(lg(projects, 4) * 0.6 + lg(langs, 2) * 0.4 * 2),       // ENGINEERING
    clamp(lg(toolCalls, 2000)),                                  // CODING
    clamp(lg(models, 1) * 0.7 + nightRatio * 5 * 0.5),           // OUTSIDE THE BOX
    clamp(
      lg(agg.longest_streak_days ?? 0, 3) * 0.5 +
        lg(agg.active_days ?? 0, 8) * 0.5
    ),                                                           // TENACITY
  ].map((v) => +v.toFixed(1));
}
