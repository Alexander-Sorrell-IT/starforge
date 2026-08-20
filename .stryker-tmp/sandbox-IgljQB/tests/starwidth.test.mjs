// @ts-nocheck
// The star follows the TERMINAL. The files it writes do not.
//
// A star that sizes itself to process.stdout.columns is an obvious win on a
// wide terminal and a silent disaster in a file: buildCompareReport() renders
// the same renderStar() frames into ~/.starreckon/reports/report-*.txt and the
// Desktop report.txt, and if the width came from the terminal then the CONTENT
// of those files would depend on which window happened to run the scan. Two
// machines holding an identical corpus would publish different bytes, which is
// exactly what tests/determinism.test.mjs exists to prevent — and it would not
// catch this one, because it runs both halves of its comparison in the same
// process, with the same stdout.
//
// So the width is an explicit option with a pinned default, the terminal is
// read ONLY at the call sites that print to a terminal, and the last test here
// is the one that matters: file output is a function of the corpus alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderStar,
  buildCompareReport,
  terminalStarWidth,
  STAR_WIDTH,
  MAX_STAR_WIDTH,
} from "../src/star.mjs";
import { AXES } from "../src/starsvg.mjs";

const LV = [5, 1, 4, 2, 3];
const widthOf = (frame) => Math.max(...frame.split("\n").map((l) => l.length));
const rowsOf = (frame) => frame.split("\n").length;
// The shaded glyphs ARE the star. Counting them separates a bigger drawing
// from the same drawing with more blank margin around it.
const ink = (frame) => [...frame].filter((c) => "░▒▓█".includes(c)).length;

test("the default width is the pinned 78, and an option-free call still renders it", () => {
  assert.equal(STAR_WIDTH, 78, "78 is the width every file on disk was written at");
  assert.equal(
    renderStar(LV, { color: false }),
    renderStar(LV, { color: false, width: STAR_WIDTH }),
    "omitting width must be the same call as passing the default"
  );
  assert.ok(widthOf(renderStar(LV, { color: false })) <= 78);
  assert.equal(rowsOf(renderStar(LV, { color: false })), 26);
});

test("a wider width draws a BIGGER star, not the same star with more margin", () => {
  const narrow = renderStar(LV, { color: false });
  const wide = renderStar(LV, { color: false, width: 120 });
  assert.ok(widthOf(wide) > widthOf(narrow), "the frame must actually get wider");
  assert.ok(widthOf(wide) <= 120, "and must never exceed the width it was given");
  assert.ok(
    ink(wide) > ink(narrow) * 1.5,
    `the drawing must grow with the canvas: ${ink(narrow)} glyphs at 78 vs ${ink(wide)} at 120`
  );
  assert.ok(rowsOf(wide) > rowsOf(narrow), "a wider star is a taller star, or it is an ellipse");
});

test("nothing is clipped at any width the terminal path can ask for", () => {
  for (const width of [78, 96, 110, 120, MAX_STAR_WIDTH]) {
    const frame = renderStar(LV, { color: false, width });
    for (const ax of AXES)
      assert.ok(frame.includes(ax), `axis label "${ax}" clipped at width ${width}`);
    assert.ok(frame.includes("SKILL POINTS"), `footer clipped at width ${width}`);
    assert.ok(widthOf(frame) <= width, `frame overflowed its own width at ${width}`);
  }
});

test("terminalStarWidth never narrows below 78 and never passes the cap", () => {
  assert.equal(terminalStarWidth({ columns: 40, rows: 50 }), STAR_WIDTH,
    "a narrow terminal keeps the canonical star — shrinking is not this feature");
  assert.equal(terminalStarWidth({}), STAR_WIDTH, "no columns at all (a pipe) is the default");
  assert.equal(terminalStarWidth({ columns: NaN, rows: NaN }), STAR_WIDTH);
  assert.equal(terminalStarWidth({ columns: 1000, rows: 1000 }), MAX_STAR_WIDTH,
    "past the cap the star stops growing; a 1000-column star is not a feature");
  const w = terminalStarWidth({ columns: 100, rows: 100 });
  assert.ok(w > STAR_WIDTH && w < 100, `expected a width between 78 and 100, got ${w}`);
});

test("a SHORT terminal never gets a frame taller than itself", () => {
  // LiveStar.draw() redraws in place with cursor-up. A frame taller than the
  // viewport scrolls, the cursor-up lands in the wrong row, and the redraw
  // tears down the screen. On a wide-but-short window height binds, not columns.
  for (const rows of [30, 40, 60]) {
    const w = terminalStarWidth({ columns: 400, rows });
    assert.ok(
      rowsOf(renderStar(LV, { color: false, width: w })) <= rows,
      `a ${rows}-row terminal was offered width ${w}`
    );
  }
  // Below the canonical star's own 26 rows there is nothing this feature can
  // do: it declines to grow rather than shrinking, because shrinking the star
  // on narrow terminals is a different change than the one asked for. The
  // 26-row frame in a 20-row window is exactly what shipped before this.
  assert.equal(terminalStarWidth({ columns: 400, rows: 20 }), STAR_WIDTH,
    "a short terminal must not be made worse — but it is not made better either");
});

test("THE TRAP: a report file is a function of the corpus, never of the terminal", () => {
  const mine = {
    month: { month: "2026-08", levels: [4, 3, 5, 2, 1] },
    life: { months: 6, levels: [5, 4, 5, 3, 2] },
  };
  // The stamp is the one line allowed to differ between two calls.
  const strip = (s) => s.split("\n").filter((l) => !l.startsWith("generated ")).join("\n");
  const cols0 = process.stdout.columns;
  const rows0 = process.stdout.rows;
  try {
    process.stdout.columns = 220;
    process.stdout.rows = 80;
    // If the mutation did not take, this test proves nothing — say so rather
    // than passing vacuously.
    assert.equal(process.stdout.columns, 220, "could not fake a wide terminal; test is inert");
    const wideTerminal = strip(buildCompareReport({ mine }));

    process.stdout.columns = 80;
    process.stdout.rows = 24;
    const narrowTerminal = strip(buildCompareReport({ mine }));

    assert.equal(wideTerminal, narrowTerminal,
      "report content changed with the terminal — byte-comparability across machines is gone");
    assert.ok(
      Math.max(...wideTerminal.split("\n").map((l) => l.length)) <= STAR_WIDTH,
      "a saved report must stay inside 78 columns whatever window wrote it"
    );
  } finally {
    process.stdout.columns = cols0;
    process.stdout.rows = rows0;
  }
});
