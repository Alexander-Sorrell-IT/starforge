// QR encoder tests.
//
// A QR code is the easiest thing in the world to get *plausibly* wrong: it
// renders as a convincing square of noise whether or not a scanner can read it.
// The first version of src/qr.mjs produced beautiful, completely unscannable
// output — two bugs, both invisible to the eye:
//
//   1. pad codewords alternated 0xEC/0x11 keyed to the array length instead of
//      the pad position, so the sequence started on the wrong byte for any
//      payload with an odd codeword count;
//   2. the Reed-Solomon generator polynomial was built REVERSED (degree 2 gave
//      [2,3,1] instead of [1,3,2]), so every error-correction codeword was
//      wrong.
//
// Neither is catchable by looking. So these tests decode the matrix rather than
// admiring it: the structural invariants below are checked directly, and the
// full round-trip against an independent decoder runs in tests/qr.decode.mjs
// (not shipped — it needs a dev-only decoder). That script verified 160 random
// payloads and an exact module-for-module match against a reference encoder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeQR, qrToSvg, qrToTerminal } from "../src/qr.mjs";

const URL = "https://github.com/Alexander-Sorrell-IT/starforge";

test("finder patterns sit in exactly the three corners", () => {
  // If these are wrong nothing can even locate the symbol.
  const { size, modules } = encodeQR(URL);
  const finder = (r0, c0) => {
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < 7; c++) {
        const onRing = r === 0 || r === 6 || c === 0 || c === 6;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const expected = onRing || inCore ? 1 : 0;
        assert.equal(
          modules[r0 + r][c0 + c], expected,
          `finder at ${r0},${c0} wrong at offset ${r},${c}`
        );
      }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  // ...and NOT in the fourth corner, which is how orientation is determined.
  let bottomRight = 0;
  for (let r = size - 7; r < size; r++)
    for (let c = size - 7; c < size; c++) bottomRight += modules[r][c];
  assert.notEqual(bottomRight, 33, "a finder pattern in the 4th corner would break orientation");
});

test("timing patterns alternate, and the dark module is set", () => {
  const { size, modules } = encodeQR(URL);
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0, `horizontal timing wrong at ${i}`);
    assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0, `vertical timing wrong at ${i}`);
  }
  assert.equal(modules[size - 8][8], 1, "the always-dark module must be dark");
});

test("version scales with payload length, and size follows the version formula", () => {
  const small = encodeQR("A");
  const big = encodeQR("x".repeat(120));
  assert.equal(small.version, 1);
  assert.equal(small.size, 21, "version 1 is 21x21");
  assert.ok(big.version > small.version, "a longer payload must need a bigger symbol");
  for (const q of [small, big]) assert.equal(q.size, q.version * 4 + 17);
});

test("a payload past the encoder's ceiling is refused, not silently truncated", () => {
  // Refusing is the correct failure: a QR that encodes half a URL scans
  // perfectly and sends you somewhere wrong, which is worse than no QR at all.
  assert.throws(
    () => encodeQR("x".repeat(400)),
    /exceeds this encoder/,
    "an over-long payload must throw rather than encode a truncated payload"
  );
  // ...and the boundary is where it says it is.
  assert.doesNotThrow(() => encodeQR("x".repeat(271)), "271 bytes must still encode");
});

test("encoding is deterministic", () => {
  // The mask is chosen by penalty score; ties must not resolve randomly, or two
  // runs would write different cards for identical input.
  const a = encodeQR(URL), b = encodeQR(URL);
  assert.deepEqual(a.modules, b.modules);
});

test("changing one character changes the matrix", () => {
  const a = encodeQR("https://example.com/a");
  const b = encodeQR("https://example.com/b");
  assert.notDeepEqual(a.modules, b.modules, "different payloads must not encode identically");
});

test("the svg is self-contained and has a module for every dark cell", () => {
  const { modules, size } = encodeQR(URL);
  const svg = qrToSvg(URL, { size: 240 });
  assert.match(svg, /^<svg /);
  assert.doesNotMatch(svg, /https?:\/\/(?!www\.w3\.org)/, "no remote references");
  assert.doesNotMatch(svg, /<script/i);
  // Dark modules are emitted as horizontal runs; total covered area must equal
  // the dark module count, or the rendering silently drops data.
  let dark = 0;
  for (const row of modules) for (const v of row) dark += v;
  const widths = [...svg.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="([\d.]+)"/g)].map((m) => Number(m[1]));
  const s = 240 / (size + 4);
  const covered = widths.reduce((acc, w) => acc + Math.round(w / s), 0);
  assert.equal(covered, dark, "svg rects must cover exactly the dark modules");
});

test("the terminal rendering has a quiet zone and is not blank", () => {
  const out = qrToTerminal(URL, { color: false });
  const lines = out.split("\n");
  assert.ok(lines.length > 10, "expected a multi-row block");
  const widths = new Set(lines.map((l) => l.length));
  assert.equal(widths.size, 1, "every row must be the same width");
  // The first row is quiet zone: all light. On a dark terminal light is "█".
  assert.match(lines[0], /^█+$/, "the top quiet zone must be uniform light");
  assert.ok(/[▀▄ ]/.test(out), "expected half-block glyphs in the body");
});

test("a payload too big for level M falls back to L instead of refusing", () => {
  // The share card's real payload — star levels, sessions, hours, tokens, cache
  // share, streak and the repo URL — is about 260 bytes. Level M tops out at
  // 213, so the card printed "payload too long to encode as a QR" on real data
  // while looking perfect against the shorter fixture this file was written
  // with. The encoder now spends error correction to buy capacity, but only
  // when it has to.
  const short = encodeQR("https://example.com");
  assert.equal(short.level, "M", "short payloads must keep the stronger error correction");

  const real = [
    "starforge skill star 23.7/25 (S+)",
    "firs 5 engi 5 codi 4.7 outs 5 tena 4",
    "153 sessions, 344h active, 29 days",
    "5.7B tokens, 99% cached",
    "longest streak 16d",
    "this code carries the numbers themselves, not a link to them.",
    "https://github.com/Alexander-Sorrell-IT/starforge",
  ].join("\n");
  assert.ok(real.length > 213, "the fixture must exceed the level-M ceiling to be a real test");
  const big = encodeQR(real);
  assert.equal(big.level, "L");
  assert.ok(big.size >= 21 && big.size <= 57);
  assert.equal(big.modules.length, big.size);
});

test("the share payload always fits the encoder", async () => {
  // A card that says "too long to encode" is a card with a hole in it. Whatever
  // the numbers, the payload must be encodable.
  const { sharePayload } = await import("../src/wrapped.mjs");
  const { MAX_BYTES } = await import("../src/qr.mjs");
  const extremes = [
    {},
    { total_sessions: 999999, total_duration_hours: 999999, active_days: 3650,
      total_input_tokens: 9e12, total_output_tokens: 9e12,
      total_cache_read_tokens: 9e14, total_cache_write_tokens: 9e14,
      longest_streak_days: 3650 },
  ];
  for (const agg of extremes) {
    const text = sharePayload([5, 5, 5, 5, 5], agg, "https://github.com/Alexander-Sorrell-IT/starforge");
    assert.ok(text.length <= MAX_BYTES, `payload is ${text.length} bytes, over the ${MAX_BYTES} ceiling`);
    assert.doesNotThrow(() => encodeQR(text), "the share payload must always encode");
  }
});
