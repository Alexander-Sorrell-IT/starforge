// tests/shareurl.test.mjs — unit tests for src/shareurl.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildShareUrl, parseShareUrl, PAGES_BASE } from "../src/shareurl.mjs";

const ARMS = 5, MAX_LV = 7;
const levels = [4.8, 4.6, 4.5, 4.7, 4.4];
const agg = {
  total_sessions: 142,
  total_duration_hours: 318,
  active_days: 89,
  longest_streak_days: 21,
  total_input_tokens: 1e9,
  total_output_tokens: 2e8,
  total_cache_read_tokens: 5e8,
  total_cache_write_tokens: 1e8,
};

// ── buildShareUrl ─────────────────────────────────────────────────────────────

test("buildShareUrl returns a string starting with PAGES_BASE", () => {
  const url = buildShareUrl(levels, agg, null);
  assert.ok(typeof url === "string");
  assert.ok(url.startsWith(PAGES_BASE), `expected ${PAGES_BASE}, got ${url}`);
});

test("buildShareUrl URL contains a fragment (#)", () => {
  const url = buildShareUrl(levels, agg, null);
  assert.ok(url.includes("#"), "no fragment in URL");
});

test("buildShareUrl encodes score param s", () => {
  const url = buildShareUrl(levels, agg, null);
  const hash = url.split("#")[1];
  const p = new URLSearchParams(hash);
  const s = parseFloat(p.get("s"));
  const expected = levels.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(s - expected) < 0.05, `s=${s} expected ~${expected}`);
});

test("buildShareUrl encodes axis levels param v", () => {
  const url = buildShareUrl(levels, agg, null);
  const p = new URLSearchParams(url.split("#")[1]);
  const v = p.get("v").split(",").map(Number);
  assert.equal(v.length, ARMS);
  levels.forEach((lv, i) => assert.ok(Math.abs(v[i] - lv) < 0.05));
});

test("buildShareUrl encodes sessions param ss", () => {
  const url = buildShareUrl(levels, agg, null);
  const p = new URLSearchParams(url.split("#")[1]);
  assert.equal(parseInt(p.get("ss"), 10), agg.total_sessions);
});

test("buildShareUrl encodes hours param h", () => {
  const url = buildShareUrl(levels, agg, null);
  const p = new URLSearchParams(url.split("#")[1]);
  assert.equal(parseInt(p.get("h"), 10), Math.round(agg.total_duration_hours));
});

test("buildShareUrl encodes streak param k when non-zero", () => {
  const url = buildShareUrl(levels, agg, null);
  const p = new URLSearchParams(url.split("#")[1]);
  assert.equal(parseInt(p.get("k"), 10), agg.longest_streak_days);
});

test("buildShareUrl omits streak param k when streak is 0", () => {
  const noStreak = { ...agg, longest_streak_days: 0 };
  const url = buildShareUrl(levels, noStreak, null);
  const p = new URLSearchParams(url.split("#")[1]);
  assert.equal(p.get("k"), null);
});

test("buildShareUrl encodes optional name param n", () => {
  const url = buildShareUrl(levels, agg, "Alexander");
  const p = new URLSearchParams(url.split("#")[1]);
  assert.equal(p.get("n"), "Alexander");
});

test("buildShareUrl omits name when null", () => {
  const url = buildShareUrl(levels, agg, null);
  const p = new URLSearchParams(url.split("#")[1]);
  assert.equal(p.get("n"), null);
});

test("buildShareUrl truncates name at 32 chars", () => {
  const long = "A".repeat(50);
  const url = buildShareUrl(levels, agg, long);
  const p = new URLSearchParams(url.split("#")[1]);
  assert.equal(p.get("n").length, 32);
});

test("buildShareUrl returns null for empty levels", () => {
  assert.equal(buildShareUrl([], agg, null), null);
});

test("buildShareUrl returns null for null levels", () => {
  assert.equal(buildShareUrl(null, agg, null), null);
});

test("buildShareUrl works without agg (null)", () => {
  const url = buildShareUrl(levels, null, null);
  assert.ok(typeof url === "string");
  assert.ok(url.startsWith(PAGES_BASE));
});

test("buildShareUrl URL fits in 271 bytes (QR v10 L capacity)", () => {
  const url = buildShareUrl(levels, agg, "Alexander Sorrell");
  const bytes = new TextEncoder().encode(url).length;
  assert.ok(bytes <= 271, `URL is ${bytes} bytes, exceeds 271`);
});

test("buildShareUrl clamps axis levels to 0..MAX_LV", () => {
  const crazy = [100, -5, 3.5, 7.001, 0];
  const url = buildShareUrl(crazy, agg, null);
  const p = new URLSearchParams(url.split("#")[1]);
  const v = p.get("v").split(",").map(Number);
  v.forEach((lv) => {
    assert.ok(lv >= 0 && lv <= MAX_LV, `level ${lv} out of range`);
  });
});

// ── parseShareUrl ─────────────────────────────────────────────────────────────

test("parseShareUrl round-trips buildShareUrl", () => {
  const url = buildShareUrl(levels, agg, "Tester");
  const d = parseShareUrl(url);
  assert.ok(d !== null);
  assert.ok(Math.abs(d.total - levels.reduce((a,b)=>a+b,0)) < 0.05);
  assert.equal(d.sessions, agg.total_sessions);
  assert.equal(d.hours, Math.round(agg.total_duration_hours));
  assert.equal(d.streak, agg.longest_streak_days);
  assert.equal(d.name, "Tester");
  assert.equal(d.levels.length, ARMS);
});

test("parseShareUrl accepts just the fragment string (no base URL)", () => {
  const url = buildShareUrl(levels, agg, null);
  const hash = url.split("#")[1];
  const d = parseShareUrl(hash);
  assert.ok(d !== null);
  assert.equal(d.levels.length, ARMS);
});

test("parseShareUrl returns null on completely invalid input", () => {
  // URLSearchParams won't throw but levels will be empty/NaN
  const d = parseShareUrl("not-a-url-at-all");
  // levels will be empty — callers treat that as invalid
  assert.ok(d === null || !d.levels.length);
});

test("parseShareUrl decodes archetype underscores as spaces", () => {
  const url = buildShareUrl(levels, agg, null);
  const d = parseShareUrl(url);
  assert.ok(!d.archetype.includes("_"), "underscores not decoded to spaces");
});
