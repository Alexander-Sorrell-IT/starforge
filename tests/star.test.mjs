// The star is the thing people look at, and until now nothing tested it.
//
// These are shape tests, not pixel tests. The claim the star makes is "the
// silhouette IS the data": arm length is set by its own axis and by nothing
// else, so a lopsided profile has to LOOK different from a balanced one with
// the same total. That is a property, and it is checkable.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AXES,
  ARMS,
  MAX_LEVEL,
  VALLEY_RATIO,
  armRadius,
  armTips,
  starPoints,
  renderStarSvg,
  clampLevel,
} from "../src/starsvg.mjs";
import { renderStar, computeLevels } from "../src/star.mjs";

const R = 100;
const dist = ([x, y]) => Math.hypot(x, y);

test("an arm's length is a function of its own axis and nothing else", () => {
  // The defect this pins: the valleys used to be placed at the AVERAGE of the
  // two neighbouring levels, so raising one axis visibly moved its neighbours'
  // geometry and a 5/1 pair drew almost the same outline as a 3/3 pair. The
  // silhouette stopped being the data. Arm i must not move when axis j does.
  const base = [3, 3, 3, 3, 3];
  const baseTips = armTips(base, R, 0, 0);
  for (let j = 0; j < ARMS; j++) {
    const bumped = base.slice();
    bumped[j] = 5;
    const tips = armTips(bumped, R, 0, 0);
    for (let i = 0; i < ARMS; i++) {
      if (i === j) {
        assert.ok(
          dist(tips[i]) > dist(baseTips[i]) + 1,
          `raising ${AXES[j]} must lengthen its own arm`
        );
      } else {
        assert.equal(
          dist(tips[i]).toFixed(6),
          dist(baseTips[i]).toFixed(6),
          `raising ${AXES[j]} moved the ${AXES[i]} arm`
        );
      }
    }
  }
});

test("same total, different distribution => a different silhouette", () => {
  // Both sum to 15. A star that draws these the same is not showing the shape
  // of the person, it is showing one number twice.
  const balanced = [3, 3, 3, 3, 3];
  const lopsided = [5, 1, 5, 1, 3];
  assert.equal(
    balanced.reduce((a, b) => a + b, 0),
    lopsided.reduce((a, b) => a + b, 0)
  );
  const a = starPoints(balanced, R, 0, 0);
  const b = starPoints(lopsided, R, 0, 0);
  const spread = (pts) => {
    const rs = pts.filter((_, i) => i % 2 === 0).map(dist);
    return Math.max(...rs) - Math.min(...rs);
  };
  assert.equal(spread(a).toFixed(6), "0.000000", "a balanced profile draws a regular star");
  assert.ok(spread(b) > R * 0.4, "a lopsided profile must draw a visibly irregular star");
});

test("level 0 sits on the valley ring, level 5 reaches full extent, and it is monotonic", () => {
  assert.equal(armRadius(0, R), R * VALLEY_RATIO);
  assert.equal(armRadius(MAX_LEVEL, R), R);
  let prev = -Infinity;
  for (let lv = 0; lv <= MAX_LEVEL; lv += 0.25) {
    const r = armRadius(lv, R);
    assert.ok(r > prev, `arm length must never shrink as the level rises (at ${lv})`);
    prev = r;
  }
  // Out-of-range input must not draw a spike off the canvas or invert the star.
  assert.equal(armRadius(99, R), R);
  assert.equal(armRadius(-4, R), R * VALLEY_RATIO);
  assert.equal(clampLevel(NaN), 0);
  assert.equal(clampLevel(undefined), 0);
});

test("the hull never self-intersects, at any level combination", () => {
  // With a fixed valley radius every vertex is at a distinct angle and every
  // radius is >= the valley ring, so the polygon stays simple. Check the
  // degenerate corners explicitly rather than trusting the argument.
  for (const lv of [[0, 0, 0, 0, 0], [5, 0, 5, 0, 5], [0, 5, 0, 5, 0], [5, 5, 5, 5, 5]]) {
    const pts = starPoints(lv, R, 0, 0);
    assert.equal(pts.length, ARMS * 2);
    for (const p of pts) {
      const d = dist(p);
      assert.ok(
        d >= R * VALLEY_RATIO - 1e-9 && d <= R + 1e-9,
        `vertex at radius ${d} escaped [valley, R] for ${lv}`
      );
    }
  }
});

test("every inlined star gets its own gradient and filter ids", () => {
  // The stats page inlines a dozen of these into ONE document. Duplicate ids
  // would make every star silently adopt the first star's defs, so the month
  // chips would all render with the hero's gradient.
  const a = renderStarSvg([1, 2, 3, 4, 5], { size: 120 });
  const b = renderStarSvg([5, 4, 3, 2, 1], { size: 120 });
  const ids = (s) => [...s.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const ia = ids(a), ib = ids(b);
  assert.ok(ia.length >= 3, "expected gradient + filter ids");
  assert.equal(new Set(ia).size, ia.length, "ids must be unique within one svg");
  for (const id of ia)
    assert.ok(!ib.includes(id), `id ${id} was reused by a second star on the same page`);
});

test("a star svg references nothing remote", () => {
  const svg = renderStarSvg([4, 4, 4, 4, 4], { size: 200, footer: "2026-08" });
  assert.match(svg, /^<svg /);
  assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org)/, "no remote references");
  assert.doesNotMatch(svg, /<script/i);
  assert.doesNotMatch(svg, /xlink:href|<image/i);
});

test("svg text is escaped, so a footer or title cannot inject markup", () => {
  const svg = renderStarSvg([1, 1, 1, 1, 1], { size: 120, footer: "<script>x</script>&" });
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
});

test("computeLevels reads a month snapshot bucket, not just the lifetime aggregate", () => {
  // Every snapshot draws its own star, so the month bucket's pre-reduced field
  // names have to be understood directly — and a month must NOT need a project
  // NAME to compute its ENGINEERING arm, only a count.
  const bucket = {
    month: "2026-08",
    input_tokens: 4_000_000,
    output_tokens: 1_000_000,
    tool_calls: 3000,
    projects_count: 6,
    languages: { javascript: 10, python: 4 },
    models: { "claude-opus-5": 3 },
    hour_buckets: new Array(24).fill(2),
    active_days: 12,
    longest_streak_days: 5,
  };
  const levels = computeLevels(bucket);
  assert.equal(levels.length, ARMS);
  for (const l of levels) assert.ok(l >= 0 && l <= MAX_LEVEL, `level ${l} out of range`);
  assert.ok(levels.some((l) => l > 0), "a real month must not render as an empty star");
  assert.ok(!JSON.stringify(bucket).includes("/"), "a month bucket carries no paths");

  // An empty month is a legal, drawable shape — not a crash and not a gap.
  const empty = computeLevels({ month: "2026-01" });
  assert.deepEqual(empty, [0, 0, 0, 0, 0]);
});

test("the terminal frame is a fixed-size raster and honours colour being off", () => {
  const plain = renderStar([5, 1, 4, 2, 3], { color: false, status: "scan complete" });
  const rows = plain.split("\n");
  assert.ok(rows.length > 10, "expected a multi-row frame");
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(plain, /\x1b\[/, "no ANSI when colour is disabled");
  assert.match(plain, /SKILL POINTS 15\.0\/25/);
  for (const ax of AXES) assert.match(plain, new RegExp(ax.replace(/ /g, " ")));

  const colored = renderStar([5, 1, 4, 2, 3], { color: true });
  assert.match(colored, /\x1b\[38;5;\d+m/, "expected 256-colour output");
  assert.equal(
    colored.split("\n").length,
    rows.length,
    "colour must not change the frame's row count"
  );
});

test("the svg's drawn hull is the shared geometry, not its own copy of it", () => {
  // The terminal frame, the card and the month chips are supposed to be one
  // shape rendered three ways. The way that breaks is a renderer quietly
  // keeping its own tip/valley maths, so what you watched during the scan is
  // not what landed on disk. Read the polygon back out of the SVG and check it
  // against starPoints directly.
  const levels = [4.6, 1.2, 5, 2.7, 3.9];
  const size = 400;
  const svg = renderStarSvg(levels, { size, labels: false, ghost: false });
  const polys = [...svg.matchAll(/<polygon points="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(polys.length, 1, "expected exactly one hull polygon with ghost off");
  const drawn = polys[0]
    .trim()
    .split(/\s+/)
    .map((p) => p.split(",").map(Number));

  const cx = size / 2, cy = size / 2, R = size * 0.42;
  const expected = starPoints(levels, R, cx, cy);
  assert.equal(drawn.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    // The renderer rounds to 1dp for file size; that is the only allowed drift.
    assert.ok(
      Math.abs(drawn[i][0] - expected[i][0]) < 0.06 &&
        Math.abs(drawn[i][1] - expected[i][1]) < 0.06,
      `vertex ${i} drawn at ${drawn[i]} but geometry says ${expected[i]}`
    );
  }

  // And each arm's tip really is at its own level's radius. The tolerance is
  // wider than the per-coordinate one because x and y are each rounded to 1dp
  // and both errors land in the same radius.
  for (let i = 0; i < ARMS; i++) {
    const d = Math.hypot(drawn[i * 2][0] - cx, drawn[i * 2][1] - cy);
    assert.ok(
      Math.abs(d - armRadius(levels[i], R)) < 0.15,
      `arm ${AXES[i]} is ${d} from centre, geometry says ${armRadius(levels[i], R)}`
    );
  }
});

test("changing one axis changes the rendered terminal frame", () => {
  // Guards the whole pipeline, not just the maths: if the raster ignored the
  // levels (or clamped them all to the same radius) every property test above
  // could still pass while the picture stayed identical.
  const a = renderStar([5, 1, 1, 1, 1], { color: false });
  const b = renderStar([1, 1, 1, 1, 1], { color: false });
  assert.notEqual(a, b, "raising an axis must change the drawn frame");
  const ink = (s) => (s.match(/[^\s]/g) ?? []).length;
  assert.ok(ink(a) > ink(b), "a longer arm must add drawn area");
});
