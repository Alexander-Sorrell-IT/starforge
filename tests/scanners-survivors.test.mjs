// Targeted kills for scanners.mjs's number-moving survivors.
//
// The first mutation run over scanners.mjs: 50.2%, 923 survivors, 66 of which
// can change a NUMBER. The heaviest by blast radius, and what each one means
// if it drifts:
//
//   scanPortedReaders:1322   the fuller-copy-wins dedup across roots — flip the
//                            >= and the SMALLER copy of every session wins
//   readCopilot:450          rec.turns += 1 — turns silently stop counting
//   readCopilot:477          the COMPACT[k] accumulation — a usage key vanishes
//   activeMinutes:148        the gap threshold — duration inflates or zeroes
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { scanProvider, scanPortedReaders } from "../src/scanners.mjs";

const J = (o) => JSON.stringify(o);
function put(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
const home = () => mkdtempSync(join(tmpdir(), "surv-"));

// ── copilot: turns, duration, and every usage key ──────────────────────────
function copilotHome(stamps, usage) {
  const h = home();
  const rows = stamps.map((t, i) =>
    J({ timestamp: t, type: "assistant.message", data: { model: "m" } }));
  rows.push(J({ timestamp: stamps[stamps.length - 1], type: "session.shutdown",
                data: { modelMetrics: { m: { usage } } } }));
  put(join(h, ".copilot", "session-state", "s1", "events.jsonl"), rows.join("\n"));
  return h;
}

test("copilot: every assistant message is a turn, counted not capped", () => {
  const h = copilotHome(
    ["2026-02-01T10:00:00Z", "2026-02-01T10:01:00Z", "2026-02-01T10:02:00Z"],
    { inputTokens: 10, outputTokens: 5 });
  const { perSession } = scanProvider("copilot", [h]);
  assert.equal(perSession[0].turns, 3,
    "rec.turns += 1 stopped accumulating — 3 messages must be 3 turns");
});

test("copilot: each usage key lands in its own bucket, none folded away", () => {
  const h = copilotHome(["2026-02-01T10:00:00Z"], {
    inputTokens: 11, outputTokens: 7, reasoningTokens: 3,
    cacheReadTokens: 13, cacheWriteTokens: 17,
  });
  const s = scanProvider("copilot", [h]).perSession[0];
  assert.equal(s.input, 11);
  assert.equal(s.output, 7 + 3, "reasoning rides alongside output");
  assert.equal(s.cacheRead, 13);
  assert.equal(s.cacheWrite, 17);
  // Distinct primes: any swapped or dropped bucket changes the total.
  assert.equal(s.input + s.output + s.cacheRead + s.cacheWrite, 51);
});

test("copilot: duration counts gaps within the threshold and drops the break", () => {
  // 10:00→10:05→10:10 is two 5-minute gaps; then a 4-HOUR break; then one
  // more minute. activeMinutes must count 10+1, never 250.
  const h = copilotHome(
    ["2026-02-01T10:00:00Z", "2026-02-01T10:05:00Z", "2026-02-01T10:10:00Z",
     "2026-02-01T14:10:00Z", "2026-02-01T14:11:00Z"],
    { inputTokens: 1, outputTokens: 1 });
  const s = scanProvider("copilot", [h]).perSession[0];
  assert.equal(s.duration_min, 11,
    `a 4-hour break was counted as active time (got ${s.duration_min})`);
});

// ── scanPortedReaders: the fuller copy wins, whichever root comes first ────
function clawHome(sid, tokens) {
  const h = home();
  put(join(h, ".clawspring", "sessions", "daily", "d", `session_${sid}.json`),
      J({ session_id: sid, total_input_tokens: tokens, total_output_tokens: 0 }));
  return h;
}

test("the fuller copy of a session wins across roots", async () => {
  const small = clawHome("cs-1", 100);
  const full = clawHome("cs-1", 900);
  for (const roots of [[small, full], [full, small]]) {
    const r = await scanPortedReaders(roots, { knownClaudeIds: new Set() });
    assert.equal(r.providers.clawspring.sessions, 1,
      "one session in two roots must not become two");
    assert.equal(r.providers.clawspring.input, 900,
      `roots ${roots[0] === small ? "small-first" : "full-first"}: the ` +
      "smaller copy won the dedup — the >= flipped");
  }
});

test("distinct sessions across roots are both kept", async () => {
  const a = clawHome("cs-a", 100);
  const b = clawHome("cs-b", 200);
  const r = await scanPortedReaders([a, b], { knownClaudeIds: new Set() });
  assert.equal(r.providers.clawspring.sessions, 2);
  assert.equal(r.providers.clawspring.input, 300);
});
