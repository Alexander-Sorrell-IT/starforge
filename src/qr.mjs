// QR encoder — byte mode, versions 1..10, EC level M. Zero dependencies.
//
// Written rather than installed on purpose. This package ships with no
// dependencies at all, and that is not a vanity metric here: the whole pitch is
// that you can read every line that runs on your machine before you run it, and
// `starforge-cli verify` scans the SHIPPED files for network and process APIs.
// A dependency would be code the verifier never sees and the reader never
// audits, pulled in to draw a square.
//
// Correctness is not assumed. tests/qr.test.mjs checks this encoder's output
// against an independent reference encoder AND decodes the rendered matrix, so
// "it looks like a QR code" is never the standard.

// EC level indicators are NOT in numeric order in the spec: L=01, M=00.
const EC_LEVEL_M = 0b00;
const EC_LEVEL_L = 0b01;

// [ecCodewordsPerBlock, blocksInGroup1, dataCodewordsPerBlockG1, blocksInGroup2, dataCodewordsPerBlockG2]
// Level M, versions 1..10. From ISO/IEC 18004 Table 13-22.
const EC_TABLE_M = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

// Level L, versions 1..10. Same shape as EC_TABLE_M.
//
// L exists here because M was not enough. At version 10 level M the payload
// ceiling is 213 bytes, and the share card's real payload — star levels,
// sessions, hours, tokens, cache share, streak and the repo URL — runs to about
// 260. So the card printed "payload too long to encode as a QR" on real data
// while looking fine on the shorter fixture I tested with. L trades error
// correction for capacity (271 bytes at v10), which is the right trade for a
// code being read off a screen a foot away rather than a scuffed parcel label.
const EC_TABLE_L = {
  1: [7, 1, 19, 0, 0],
  2: [10, 1, 34, 0, 0],
  3: [15, 1, 55, 0, 0],
  4: [20, 1, 80, 0, 0],
  5: [26, 1, 108, 0, 0],
  6: [18, 2, 68, 0, 0],
  7: [20, 2, 78, 0, 0],
  8: [24, 2, 97, 0, 0],
  9: [30, 2, 116, 0, 0],
  10: [18, 2, 68, 2, 69],
};

const TABLES = { M: EC_TABLE_M, L: EC_TABLE_L };
const LEVEL_BITS = { M: EC_LEVEL_M, L: EC_LEVEL_L };

// Alignment pattern centre coordinates per version (version 1 has none).
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

// ---- GF(256) ---------------------------------------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // QR's generator polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// Generator polynomial for `degree` error-correction codewords.
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    // Multiply poly by (x + α^i). poly[0] is the LEADING coefficient, so the
    // x term keeps its index in the longer array and the α^i term shifts down
    // by one. Writing these the other way round builds the generator reversed —
    // for degree 2 it yields [2,3,1] instead of [1,3,2] — which produces
    // plausible-looking but wrong EC codewords and a QR nothing can scan.
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor);
  }
  return res;
}

// ---- bit buffer ------------------------------------------------------------
class Bits {
  constructor() { this.bits = []; }
  put(value, length) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  get length() { return this.bits.length; }
}

// Total data codewords available at a version (level M).
function dataCodewords(version, level = "M") {
  const [ec, b1, d1, b2, d2] = TABLES[level][version];
  return b1 * d1 + b2 * d2;
}

// Prefer M (stronger error correction); fall back to L only when the payload
// does not otherwise fit, so short codes keep the better recovery.
function chooseVersion(byteLen) {
  for (const level of ["M", "L"]) {
    for (let v = 1; v <= 10; v++) {
      // mode (4) + char count (8 for v1-9, 16 for v10+) + data + terminator
      const countBits = v < 10 ? 8 : 16;
      if (4 + countBits + byteLen * 8 <= dataCodewords(v, level) * 8) return { version: v, level };
    }
  }
  return null;
}

/** Largest payload this encoder can carry, in bytes. */
export const MAX_BYTES = dataCodewords(10, "L") - 3;

// ---- matrix ----------------------------------------------------------------
function makeMatrix(size) {
  return {
    m: Array.from({ length: size }, () => new Array(size).fill(null)),
    size,
  };
}

function placeFinder(mx, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r, cc = col + c;
      if (rr < 0 || rr >= mx.size || cc < 0 || cc >= mx.size) continue;
      const inner =
        (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
        (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
        (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      mx.m[rr][cc] = inner ? 1 : 0;
    }
  }
}

function placeAlignment(mx, version) {
  const centers = ALIGN[version];
  for (const r of centers) {
    for (const c of centers) {
      // Skip the three corners occupied by finder patterns.
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= mx.size - 9) || (r >= mx.size - 9 && c <= 8))
        continue;
      for (let dr = -2; dr <= 2; dr++)
        for (let dc = -2; dc <= 2; dc++)
          mx.m[r + dr][c + dc] =
            Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0;
    }
  }
}

function placeTiming(mx) {
  for (let i = 8; i < mx.size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    if (mx.m[6][i] === null) mx.m[6][i] = v;
    if (mx.m[i][6] === null) mx.m[i][6] = v;
  }
}

// Format info: 5 data bits (2 EC level + 3 mask), BCH(15,5), XOR mask 0x5412.
function formatBits(ecLevel, mask) {
  let data = (ecLevel << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

// Version info for versions >= 7: 6 data bits, BCH(18,6).
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

function reserveFormatAreas(mx, version) {
  for (let i = 0; i < 9; i++) {
    if (mx.m[8][i] === null) mx.m[8][i] = 0;
    if (mx.m[i][8] === null) mx.m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (mx.m[8][mx.size - 1 - i] === null) mx.m[8][mx.size - 1 - i] = 0;
    if (mx.m[mx.size - 1 - i][8] === null) mx.m[mx.size - 1 - i][8] = 0;
  }
  mx.m[mx.size - 8][8] = 1; // the always-dark module
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3), c = i % 3;
      mx.m[mx.size - 11 + c][r] = 0;
      mx.m[r][mx.size - 11 + c] = 0;
    }
  }
}

function writeFormat(mx, ecLevel, mask) {
  const bits = formatBits(ecLevel, mask);
  for (let i = 0; i < 15; i++) {
    const bit = (bits >>> i) & 1;
    // Copy 1 — around the top-left finder.
    if (i < 6) mx.m[i][8] = bit;
    else if (i < 8) mx.m[i + 1][8] = bit;
    else if (i === 8) mx.m[8][7] = bit;
    else mx.m[8][14 - i] = bit;
    // Copy 2 — split between bottom-left and top-right.
    if (i < 8) mx.m[8][mx.size - 1 - i] = bit;
    else mx.m[mx.size - 15 + i][8] = bit;
  }
}

function writeVersion(mx, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >>> i) & 1;
    const r = Math.floor(i / 3), c = i % 3;
    mx.m[mx.size - 11 + c][r] = bit;
    mx.m[r][mx.size - 11 + c] = bit;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function placeData(mx, bits) {
  let idx = 0;
  let upward = true;
  for (let right = mx.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is skipped
    for (let step = 0; step < mx.size; step++) {
      const row = upward ? mx.size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (mx.m[row][col] !== null) continue;
        mx.m[row][col] = idx < bits.length ? bits[idx] : 0;
        idx++;
      }
    }
    upward = !upward;
  }
}

function penalty(m, size) {
  let score = 0;
  // Rule 1 — runs of 5+ same-colour modules in a row or column.
  for (let i = 0; i < size; i++) {
    for (const line of [m[i], m.map((row) => row[i])]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (line[j] === line[j - 1]) run++;
        else { if (run >= 5) score += run - 2; run = 1; }
      }
      if (run >= 5) score += run - 2;
    }
  }
  // Rule 2 — 2x2 blocks of one colour.
  for (let r = 0; r < size - 1; r++)
    for (let c = 0; c < size - 1; c++)
      if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1])
        score += 3;
  // Rule 3 — the finder-like 1:1:3:1:1 pattern.
  const p1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const p2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (line, pat, at) => pat.every((v, k) => line[at + k] === v);
  for (let i = 0; i < size; i++) {
    const row = m[i], col = m.map((r) => r[i]);
    for (let j = 0; j + 11 <= size; j++) {
      if (matches(row, p1, j) || matches(row, p2, j)) score += 40;
      if (matches(col, p1, j) || matches(col, p2, j)) score += 40;
    }
  }
  // Rule 4 — deviation from a 50/50 dark ratio.
  let dark = 0;
  for (const row of m) for (const v of row) dark += v;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/**
 * Encode `text` and return { size, modules } where modules[r][c] is 0 or 1.
 * Throws if the text is too long for version 10 at EC level M (~271 bytes).
 */
export function encodeQR(text, { forceMask = null } = {}) {
  const bytes = [...new TextEncoder().encode(String(text))];
  const chosen = chooseVersion(bytes.length);
  if (chosen == null)
    throw new Error(`qr: ${bytes.length} bytes exceeds this encoder (max ${MAX_BYTES})`);
  const { version, level } = chosen;

  const [ecLen, b1, d1, b2, d2] = TABLES[level][version];
  const totalData = dataCodewords(version, level);

  const bb = new Bits();
  bb.put(0b0100, 4);                       // byte mode
  bb.put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) bb.put(b, 8);
  // Terminator, then pad to a byte boundary, then alternating pad codewords.
  bb.put(0, Math.min(4, totalData * 8 - bb.length));
  while (bb.length % 8 !== 0) bb.bits.push(0);
  const codewords = [];
  for (let i = 0; i < bb.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bb.bits[i + j];
    codewords.push(byte);
  }
  // Pad codewords alternate 0xEC, 0x11 starting from the FIRST pad byte. Keying
  // the alternation to codewords.length instead started the sequence on 0x11
  // whenever the payload happened to be an odd number of codewords, which
  // corrupted the data block for roughly half of all inputs.
  const PAD = [0xec, 0x11];
  for (let p = 0; codewords.length < totalData; p++) codewords.push(PAD[p % 2]);

  // Split into blocks, compute EC per block, then interleave.
  const blocks = [];
  let pos = 0;
  for (let i = 0; i < b1; i++) { blocks.push(codewords.slice(pos, pos + d1)); pos += d1; }
  for (let i = 0; i < b2; i++) { blocks.push(codewords.slice(pos, pos + d2)); pos += d2; }
  const ecBlocks = blocks.map((b) => rsEncode(b, ecLen));

  const interleaved = [];
  const maxData = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++)
    for (const b of blocks) if (i < b.length) interleaved.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) interleaved.push(b[i]);

  const bits = [];
  for (const byte of interleaved)
    for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);

  const size = version * 4 + 17;

  // Build once with function patterns, then try all 8 masks and keep the best.
  let best = null;
  const masksToTry = forceMask == null ? [0, 1, 2, 3, 4, 5, 6, 7] : [forceMask];
  for (const mask of masksToTry) {
    const mx = makeMatrix(size);
    placeFinder(mx, 0, 0);
    placeFinder(mx, 0, size - 7);
    placeFinder(mx, size - 7, 0);
    placeAlignment(mx, version);
    placeTiming(mx);
    // Remember which cells are function patterns BEFORE data goes in, because
    // the mask must be applied to data cells only.
    const reserved = mx.m.map((row) => row.map((v) => v !== null));
    reserveFormatAreas(mx, version);
    const reservedAll = mx.m.map((row) => row.map((v) => v !== null));
    placeData(mx, bits);
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++)
        if (!reservedAll[r][c] && MASKS[mask](r, c)) mx.m[r][c] ^= 1;
    writeFormat(mx, LEVEL_BITS[level], mask);
    writeVersion(mx, version);
    void reserved;
    const score = penalty(mx.m, size);
    if (!best || score < best.score) best = { score, modules: mx.m };
  }

  return { size, version, level, modules: best.modules };
}

/** Terminal rendering: two module rows per character cell, via half-blocks. */
export function qrToTerminal(text, { quiet = 2, color = true } = {}) {
  const { size, modules } = encodeQR(text);
  const n = size + quiet * 2;
  const at = (r, c) =>
    r >= quiet && r < quiet + size && c >= quiet && c < quiet + size
      ? modules[r - quiet][c - quiet]
      : 0;
  const lines = [];
  // Dark modules must be the LIGHT glyph on a dark terminal or scanners fail:
  // a QR is read as dark-on-light, so invert deliberately rather than by taste.
  const W = color ? "\x1b[97m" : "";
  const RESET = color ? "\x1b[0m" : "";
  for (let r = 0; r < n; r += 2) {
    let line = W;
    for (let c = 0; c < n; c++) {
      const top = at(r, c), bot = at(r + 1, c);
      line += top && bot ? " " : top ? "▄" : bot ? "▀" : "█";
    }
    lines.push(line + RESET);
  }
  return lines.join("\n");
}

/** SVG rendering: one <rect> per dark module run, no external references. */
export function qrToSvg(text, { size: px = 240, quiet = 2, dark = "#03101a", light = "#eaffff" } = {}) {
  const { size, modules } = encodeQR(text);
  const n = size + quiet * 2;
  const s = px / n;
  let rects = "";
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!modules[r][c]) { c++; continue; }
      let run = 0;
      while (c + run < size && modules[r][c + run]) run++;
      const x = (c + quiet) * s, y = (r + quiet) * s;
      rects += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${(run * s).toFixed(2)}" height="${s.toFixed(2)}"/>`;
      c += run;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}" shape-rendering="crispEdges" role="img"><title>QR code</title>` +
    `<rect width="${px}" height="${px}" fill="${light}"/><g fill="${dark}">${rects}</g></svg>`;
}
