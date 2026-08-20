// @ts-nocheck
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
  // Arm i must not move when axis j does. NOTE: the old, defective geometry
  // ALSO satisfied this — its bug was in the valleys, not the tips — so this
  // test alone does not pin the fix. The next test does. Both are kept: this
  // one states the property the README leads with, and it is the one that
  // fails if someone ever makes a tip depend on a neighbour.
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

test("the valleys are FIXED — this is the property the arm test does not cover", () => {
  // An adversarial pass caught the test above being weaker than the sentence it
  // was credited with: the OLD, defective geometry also passed it. The old bug
  // was never that arm tips moved — they always tracked their own level. It was
  // that the VALLEY vertex between two arms was placed at the average of that
  // pair, so the notch between a 5 and a 1 sat exactly where the notch between
  // two 3s sat, and the shape stopped distinguishing them. Reintroducing that
  // defect passed all eleven star tests. This one fails on it.
  const vR = R * VALLEY_RATIO;
  const profiles = [
    [5, 1, 5, 1, 5], [3, 3, 3, 3, 3], [0, 0, 0, 0, 0],
    [5, 5, 5, 5, 5], [4.6, 1.2, 5, 2.7, 3.9],
  ];
  for (const lv of profiles) {
    const pts = starPoints(lv, R, 0, 0);
    for (let i = 1; i < pts.length; i += 2) {
      assert.ok(
        Math.abs(dist(pts[i]) - vR) < 1e-9,
        `valley ${(i - 1) / 2} sits at ${dist(pts[i])} for ${lv}; every valley must sit at ${vR} whatever the levels are`
      );
    }
  }
  // Stated as the consequence, so the intent survives a refactor: the notch
  // between a 5 and a 1 must NOT land where the notch between two 3s lands only
  // by coincidence — it must be the identical fixed radius, and the arms around
  // it must differ.
  const lop = starPoints([5, 1, 3, 3, 3], R, 0, 0);
  const bal = starPoints([3, 3, 3, 3, 3], R, 0, 0);
  assert.equal(dist(lop[1]).toFixed(9), dist(bal[1]).toFixed(9));
  assert.notEqual(dist(lop[0]).toFixed(3), dist(bal[0]).toFixed(3));
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
  // Denominator DERIVED from the constants, not typed as 25. Hardcoding it
  // meant raising MAX_LEVEL turned a deliberate change into a red test that
  // said nothing about the raster this test exists to check.
  assert.match(plain, new RegExp(`SKILL POINTS 15\\.0/${ARMS * MAX_LEVEL}`));
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

test("more work never shortens an arm", () => {
  // Found adversarially, and it was the ugly kind of wrong: OUTSIDE THE BOX used
  // night hours as a SHARE of the day, so every daytime event shrank it. During
  // a live scan users watched that arm collapse from 3.5 to 1.5 as starreckon
  // discovered MORE of their work, and the arm's real driver was daytime tool
  // volume — a different axis's input, in a star whose whole claim is that an
  // arm answers to its own axis. Monotonicity is the property; this is the test.
  const base = {
    hour_buckets: new Array(24).fill(3),
    models: { a: 1, b: 1 },
    tool_calls: 900,
    input_tokens: 3e6,
    output_tokens: 1e6,
    active_days: 12,
    longest_streak_days: 4,
    projects_count: 3,
    languages: { javascript: 2 },
  };
  const bump = (key, add) => ({ ...base, [key]: (base[key] ?? 0) + add });

  for (const key of ["tool_calls", "input_tokens", "output_tokens", "active_days",
    "longest_streak_days", "projects_count"]) {
    const before = computeLevels(base);
    const after = computeLevels(bump(key, key.includes("tokens") ? 5e6 : 25));
    for (let i = 0; i < ARMS; i++)
      assert.ok(after[i] >= before[i] - 1e-9, `raising ${key} shortened the ${AXES[i]} arm`);
  }

  // The specific regression: activity added at ANY hour of the day.
  for (let h = 0; h < 24; h++) {
    const hb = base.hour_buckets.slice();
    hb[h] += 200;
    const before = computeLevels(base);
    const after = computeLevels({ ...base, hour_buckets: hb });
    for (let i = 0; i < ARMS; i++)
      assert.ok(
        after[i] >= before[i] - 1e-9,
        `adding activity at ${h}:00 shortened the ${AXES[i]} arm (${before[i]} -> ${after[i]})`
      );
  }
});

test("renderCard clamps hostile levels instead of throwing or printing NaN", async () => {
  // src/card.mjs had no test at all and no input validation, while the SVG
  // renderer clamped everything — so the two renderers disagreed on the same
  // input, one drawing a level-0 arm and the other labelling it "LV. NaN".
  // Infinity was worse: the node-dot loop ran until V8's max string length.
  const { renderCard } = await import("../src/card.mjs");
  const agg = {
    total_input_tokens: 1, total_output_tokens: 1,
    total_cache_read_tokens: 0, total_cache_write_tokens: 0,
    total_sessions: 1, total_duration_hours: 1,
    longest_streak_days: 1, active_days: 1,
  };
  for (const lv of [
    [Infinity, 1, 1, 1, 1], [NaN, 1, 1, 1, 1], ["3", 1, 1, 1, 1],
    [null, 1, 1, 1, 1], [1, 2, 3], [1, 2, 3, 4, 5, 6, 7], [], undefined,
  ]) {
    let svg;
    assert.doesNotThrow(() => { svg = renderCard(lv, agg, null, {}); }, `renderCard threw on ${JSON.stringify(lv)}`);
    assert.doesNotMatch(svg, /NaN|Infinity|undefined/, `card printed a non-number for ${JSON.stringify(lv)}`);
    assert.equal((svg.match(/<polygon/g) ?? []).length, 2, "hull + ghost, whatever the input");
  }
});

test("a model id from a log cannot carry a path, a secret or prose into a snapshot", async () => {
  // Snapshots are the file this tool tells you is safe to sync, and `model` is
  // the one string copied out of a log that reaches them. It had no
  // sanitisation: a crafted (or merely non-standard) log wrote an absolute path,
  // an api-key-shaped string and an email straight into ~/.starreckon/snapshots,
  // and the leak scan passed it because the path belonged to another home.
  const { sanitizeModel } = await import("../src/scan.mjs");
  assert.equal(sanitizeModel("claude-opus-5"), "claude-opus-5", "a real model id must survive intact");
  assert.equal(sanitizeModel("gpt-5-codex"), "gpt-5-codex");

  const hostile = [
    "/Users/someone/Projects/AcmeSecretClient/x sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "person@example.com",
    "x".repeat(400),
    "we should probably refactor the billing module before the audit lands",
  ];
  for (const h of hostile) {
    const out = String(sanitizeModel(h) ?? "");
    assert.ok(out.length <= 64, `sanitised model is ${out.length} chars: ${out.slice(0, 40)}`);
    assert.doesNotMatch(out, /\/|@|sk-ant|Acme|someone|refactor/, `model channel leaked: ${out}`);
  }
  // Same input must give the same pseudonym, or the distinct-model count that
  // feeds OUTSIDE THE BOX would drift run to run.
  assert.equal(sanitizeModel(hostile[0]), sanitizeModel(hostile[0]));
  assert.notEqual(sanitizeModel(hostile[0]), sanitizeModel(hostile[1]));
});

test("axis labels stay inside the canvas instead of rendering clipped", () => {
  // Caught by looking at a rendered PNG, not by any assertion: at the old radius
  // and font size, "OUTSIDE THE BOX" (the longest axis name, end-anchored and
  // hanging leftward) ran off the left edge and the label came out cut in half.
  // A star whose labels are sheared off is not a portfolio artifact.
  for (const size of [320, 520, 900]) {
    const svg = renderStarSvg([5, 5, 5, 5, 5], { size, labels: true });
    const texts = [...svg.matchAll(
      /<text x="([-\d.]+)" y="([-\d.]+)" text-anchor="(\w+)" class="(ax|lvn)" font-size="([\d.]+)">([^<]+)<\/text>/g
    )];
    assert.ok(texts.length >= ARMS * 2, `expected ${ARMS * 2} label texts, got ${texts.length}`);
    for (const [, xs, , anchor, , fss, content] of texts) {
      const x = Number(xs), fontSize = Number(fss);
      // Monospace at the declared size, plus the 1.5px letter-spacing the
      // stylesheet applies. Deliberately a slight over-estimate.
      const width = content.length * (fontSize * 0.62 + 1.5);
      const left = anchor === "end" ? x - width : anchor === "middle" ? x - width / 2 : x;
      const right = left + width;
      assert.ok(
        left >= -1 && right <= size + 1,
        `size ${size}: "${content}" spans ${left.toFixed(0)}..${right.toFixed(0)}, outside 0..${size}`
      );
    }
  }
});

test("the animated star is the same shape, and still has no script in it", () => {
  // Animation must be presentation only. The frozen final frame has to be the
  // exact geometry the static render produces, or the picture people screenshot
  // disagrees with the picture the tests check.
  const levels = [5, 1.2, 4.7, 5, 4];
  const size = 400;
  const anim = renderStarSvg(levels, { size, labels: false, ghost: false, animate: true });

  assert.match(anim, /<animate /, "expected SMIL animation");
  assert.doesNotMatch(anim, /<script/i, "animation must never need script");
  assert.doesNotMatch(anim, /https?:\/\/(?!www\.w3\.org)/, "no remote references");

  // The LAST value in the hull's animation must equal the static geometry.
  const vals = /<animate attributeName="points"[^>]*values="([^"]+)"/.exec(anim);
  assert.ok(vals, "hull animation not found");
  const finalFrame = vals[1].split(";").pop().trim();
  const cx = size / 2, R = size * 0.42;
  const expected = starPoints(levels, R, cx, cx)
    .map(([x, y]) => `${(Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, "")},${(Math.round(y * 10) / 10).toFixed(1).replace(/\.0$/, "")}`)
    .join(" ");
  assert.equal(finalFrame, expected, "the animation settles on a different shape than the static render");

  // And it must start collapsed, or there is no growth to watch.
  const firstFrame = vals[1].split(";")[0].trim();
  assert.notEqual(firstFrame, finalFrame, "the animation must start somewhere other than its end state");
});

test("renderStar uses a wider canvas when opts.columns is large", () => {
  // opts.columns is the injected terminal width — no process.stdout dependency.
  const narrow  = renderStar([3, 3, 3, 3, 3], { color: false, columns: 80 });
  const medium  = renderStar([3, 3, 3, 3, 3], { color: false, columns: 100 });
  const wide    = renderStar([3, 3, 3, 3, 3], { color: false, columns: 140 });

  const rowLen = (s) => Math.max(...s.split("\n").map((l) => l.length));
  const rowCnt = (s) => s.split("\n").length;

  // Wider terminal → wider canvas → longer lines.
  assert.ok(rowLen(medium) > rowLen(narrow),  "100-col canvas must be wider than 80-col");
  assert.ok(rowLen(wide)   > rowLen(medium),  "140-col canvas must be wider than 100-col");

  // Wider canvas → more rows (star is taller to stay roughly square).
  assert.ok(rowCnt(medium) > rowCnt(narrow),  "100-col canvas must have more rows than 80-col");
  assert.ok(rowCnt(wide)   > rowCnt(medium),  "140-col canvas must have more rows than 100-col");

  // All three must still contain all axis labels and the score footer.
  for (const frame of [narrow, medium, wide]) {
    for (const ax of AXES) assert.match(frame, new RegExp(ax));
    assert.match(frame, /SKILL POINTS/);
  }
});

test("renderStar defaults to base canvas when columns is absent or narrow", () => {
  // Narrow or missing columns must not crash and must produce the base canvas.
  const noCol   = renderStar([2, 2, 2, 2, 2], { color: false });
  const zeroCol = renderStar([2, 2, 2, 2, 2], { color: false, columns: 0 });
  const tinyCol = renderStar([2, 2, 2, 2, 2], { color: false, columns: 40 });
  // All three should produce identical output — same base canvas.
  assert.equal(noCol, zeroCol, "columns:0 must fall back to base canvas");
  assert.equal(noCol, tinyCol, "columns:40 must fall back to base canvas");
  // And it must still be a multi-row frame with labels.
  assert.ok(noCol.split("\n").length >= 26, "base canvas must have at least 26 rows");
});

test("colour on/off does not change row count for any canvas size", () => {
  for (const columns of [80, 100, 140]) {
    const plain   = renderStar([4, 3, 5, 2, 1], { color: false, columns });
    const colored = renderStar([4, 3, 5, 2, 1], { color: true,  columns });
    assert.equal(
      plain.split("\n").length,
      colored.split("\n").length,
      `columns=${columns}: colour must not change the row count`
    );
  }
});

// ── B7: arm-tip animation — opts.progress ────────────────────────────────────

test("renderStar with progress=[1,1,1,1,1] matches rendering with no progress option", () => {
  const levels = [1, 2, 3, 4, 5];
  const withFull = renderStar(levels, { color: false, columns: 80, progress: [1, 1, 1, 1, 1] });
  const normal   = renderStar(levels, { color: false, columns: 80 });
  assert.equal(withFull, normal, "progress=all-ones must match the default (no progress option)");
});

test("renderStar with progress=undefined matches rendering with no progress option", () => {
  const levels = [4, 1, 3, 5, 2];
  const withUndef = renderStar(levels, { color: false, columns: 80, progress: undefined });
  const normal    = renderStar(levels, { color: false, columns: 80 });
  assert.equal(withUndef, normal, "progress=undefined must behave identically to omitting the option");
});

test("renderStar hull shrinks when progress < 1 for a non-zero arm", () => {
  // When one arm's progress is 0.5, its effective level is halved, so the
  // hull polygon differs from the full frame (it's shorter on that arm).
  // Labels still show the full level (not the partial).
  const levels = [0, 0, 5, 0, 0]; // only arm 2 populated
  const full   = renderStar(levels, { color: false, columns: 80 });
  const half   = renderStar(levels, { color: false, columns: 80, progress: [1, 1, 0.5, 1, 1] });
  assert.notEqual(half, full, "half-progress arm must produce a different raster than fully-grown");
});

test("renderStar labels always show the target level, not the animated level", () => {
  // Even at progress=0.5, labels should show the original level, not level*0.5.
  const levels = [3, 0, 0, 0, 0];
  const halfway = renderStar(levels, { color: false, columns: 80, progress: [0.5, 1, 1, 1, 1] });
  // The label for axis 0 should reference the full level (3), not 1.5
  assert.match(halfway, /LV\.3/, "arm label must show full target level even at half-progress");
});

test("renderStar with progress=0 for all arms still shows labels at full target level", () => {
  // The raster shrinks but labels always pin to the target, so the user can
  // see where the arm is heading during animation.
  const levels = [2, 3, 1, 4, 5];
  const atZeroProgress = renderStar(levels, { color: false, columns: 80, progress: [0, 0, 0, 0, 0] });
  // All 5 labels must still reference their full target levels, not 0.
  assert.match(atZeroProgress, /LV\.2/, "arm 0 label must show full level at zero progress");
  assert.match(atZeroProgress, /LV\.3/, "arm 1 label must show full level at zero progress");
  assert.match(atZeroProgress, /LV\.5/, "arm 4 label must show full level at zero progress");
});
