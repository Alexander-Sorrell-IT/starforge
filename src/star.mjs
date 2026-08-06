// Porter-Grade style skill star, rendered live in the terminal.
// Five axes, each 0..5. Redraws in place as the scan feeds it data.

const CYAN = "\x1b[36m";
const BCYAN = "\x1b[96m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export const AXES = [
  "FIRST PRINCIPLES", // depth: tokens + long sessions
  "ENGINEERING",      // breadth: projects + languages
  "CODING",           // volume: tool calls + files touched
  "OUTSIDE THE BOX",  // range: models + sources + odd hours
  "TENACITY",         // consistency: streaks + active days
];

const W = 61;
const H = 27;
const CX = Math.floor(W / 2);
const CY = Math.floor(H / 2);
const R = 12;
const ASPECT = 0.55; // terminal cells are tall; squash y

// Tip angles: point 0 straight up, then clockwise every 72°.
function tip(i, radius) {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
  return [CX + radius * Math.cos(a), CY + radius * Math.sin(a) * ASPECT * 2];
}

function plotLine(grid, x0, y0, x1, y1, ch) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0) / ASPECT, 1) * 2;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round((y0 + (y1 - y0) * t) * ASPECT);
    if (x >= 0 && x < W && y >= 0 && y < H && grid[y][x] === " ")
      grid[y][x] = ch;
  }
}

function put(grid, y, x, str) {
  for (let i = 0; i < str.length; i++) {
    const xx = x + i;
    if (xx >= 0 && xx < W && y >= 0 && y < H) grid[y][xx] = str[i];
  }
}

// levels: array of 5 floats 0..5
export function renderStar(levels, opts = {}) {
  const grid = Array.from({ length: H }, () => new Array(W).fill(" "));
  const tips = levels.map((lv, i) => tip(i, (Math.max(lv, 0.4) / 5) * R));
  const inner = levels.map((_, i) =>
    tip(i + 0.5, R * 0.38 * (Math.max(levels[i], 0.4) + Math.max(levels[(i + 1) % 5], 0.4)) / 10)
  );

  // Pentagram web: every tip to every other tip (faint), then the star hull.
  for (let i = 0; i < 5; i++)
    for (let j = i + 1; j < 5; j++)
      plotLine(grid, tips[i][0], tips[i][1] / ASPECT, tips[j][0], tips[j][1] / ASPECT, "·");
  // Hull: tip -> inner -> next tip (the classic star outline).
  for (let i = 0; i < 5; i++) {
    plotLine(grid, tips[i][0], tips[i][1] / ASPECT, inner[i][0], inner[i][1] / ASPECT, "*");
    plotLine(grid, inner[i][0], inner[i][1] / ASPECT, tips[(i + 1) % 5][0], tips[(i + 1) % 5][1] / ASPECT, "*");
  }
  // Spokes center -> tip.
  for (let i = 0; i < 5; i++)
    plotLine(grid, CX, CY, tips[i][0], tips[i][1] / ASPECT, "·");

  // Tips + labels.
  const labelPos = [
    [0, "center"], // top
    [1, "right"],
    [2, "right"],
    [3, "left"],
    [4, "left"],
  ];
  for (const [i, side] of labelPos) {
    const [fx, fy] = tip(i, R + 1.2);
    const x = Math.round(fx);
    const y = Math.round(fy * ASPECT);
    put(grid, Math.round(tips[i][1] * ASPECT / 1), Math.round(tips[i][0]), "✦");
    const label = `${AXES[i]} LV.${levels[i].toFixed(levels[i] % 1 ? 1 : 0)}`;
    if (side === "center") put(grid, Math.max(0, y - 1), x - Math.floor(label.length / 2), label);
    else if (side === "right") put(grid, y, Math.min(x + 1, W - label.length), label);
    else put(grid, y, Math.max(0, x - label.length - 1), label);
  }

  const total = levels.reduce((a, b) => a + b, 0);
  const footer = `SKILL POINTS ${total.toFixed(1)}/25  ${opts.status ?? ""}`;
  put(grid, H - 1, Math.floor((W - footer.length) / 2), footer);

  return grid
    .map((row) =>
      row
        .join("")
        .replace(/·/g, `${DIM}${CYAN}·${RESET}`)
        .replace(/\*/g, `${CYAN}*${RESET}`)
        .replace(/✦/g, `${BOLD}${BCYAN}✦${RESET}`)
    )
    .join("\n");
}

export class LiveStar {
  constructor(stream = process.stdout) {
    this.stream = stream;
    this.lines = 0;
    this.enabled = stream.isTTY;
  }
  draw(levels, status) {
    if (!this.enabled) return;
    const frame = renderStar(levels, { status });
    if (this.lines > 0) this.stream.write(`\x1b[${this.lines}A`);
    this.stream.write(frame.split("\n").map((l) => `\x1b[2K${l}`).join("\n") + "\n");
    this.lines = frame.split("\n").length;
  }
  finish(levels, status) {
    if (this.enabled) this.draw(levels, status);
    else this.stream.write(renderStar(levels, { status }) + "\n");
  }
}

// Map scan aggregates to the five axis levels (0..5 each).
export function computeLevels(agg) {
  const lg = (v, mid) => 5 * (Math.log1p(v) / Math.log1p(mid * 10)); // ~2.5 at mid
  const clamp = (v) => Math.min(5, Math.max(0, v));
  const tokens = (agg.total_input_tokens ?? 0) + (agg.total_output_tokens ?? 0);
  const langs = Object.keys(agg.languages ?? {}).length;
  const projects = (agg.projects ?? []).length;
  const toolCalls = Object.values(agg.tool_call_counts ?? {}).reduce((a, b) => a + b, 0);
  const models = Object.keys(agg.models ?? {}).length;
  const nightHours = (agg.hour_buckets ?? []).slice(0, 6).reduce((a, b) => a + b, 0);
  const nightRatio = agg.hour_buckets ? nightHours / Math.max(1, agg.hour_buckets.reduce((a, b) => a + b, 0)) : 0;
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
