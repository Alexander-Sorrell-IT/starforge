// @ts-nocheck
// Defects found by an adversarial source review, not by this suite.
//
// Every one of these was live in a published release and none of the 378 tests
// then passing caught it. They are grouped here because they share a cause: a
// fix that landed in one file and not its twin, or a string that was trusted
// because it looked like a name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyStats, parseClaudeFile, parseCodexFile, finalize, creditUsage } from "../src/scan.mjs";
import { computeLevels } from "../src/star.mjs";
import { renderCard } from "../src/card.mjs";
import { cardStack, cardRank, box } from "../src/wrapped.mjs";

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("--name cannot inject script or break the SVG", () => {
  // renderCard interpolated opts.name raw, and statspage.mjs INLINES that SVG
  // into the HTML page — so a crafted --name executed when the page was opened.
  // starsvg.mjs had escapeText() the whole time; card.mjs never called it.
  const svg = renderCard(new Array(5).fill(4),
    { total_sessions: 1, active_days: 1, languages: {}, models: {} }, null,
    { name: 'R&D</text><script>alert(1)</script><text>' });
  assert.ok(!svg.includes("<script>"), "a script tag reached the SVG");
  assert.ok(svg.includes("&lt;script&gt;"), "it must be escaped, not stripped");
  assert.ok(svg.includes("R&amp;D"), "a bare ampersand makes the file invalid XML");
});

test("a Codex tool name cannot carry a credential into the reports", async () => {
  // The Claude branch ran sanitizeModel on item.name; the Codex branch 80 lines
  // away wrote payload.name raw, straight into tool_call_counts.
  const home = mkdtempSync(join(tmpdir(), "sf-codex-"));
  const dir = join(home, ".codex", "sessions");
  mkdirSync(dir, { recursive: true });
  const secret = "sk-ant-api03-ZZZZYYYYXXXXWWWWVVVVUUUU";
  writeFileSync(join(dir, "r.jsonl"), JSON.stringify({
    type: "response_item", timestamp: "2026-07-01T10:00:00.000Z",
    payload: { type: "function_call", name: secret },
  }));
  const stats = emptyStats();
  await parseCodexFile(join(dir, "r.jsonl"), stats, {});
  const out = finalize(stats);
  assert.ok(
    !JSON.stringify(out).includes(secret),
    "a credential named as a tool reached the report verbatim"
  );
});

test("token counters accept only finite numbers", () => {
  // `?? 0` accepted a STRING, and "500" + 0 concatenates rather than adds.
  const seen = new Map();
  const d = creditUsage(seen, "a", { input_tokens: "500", output_tokens: null,
    cache_read_input_tokens: undefined, cache_creation_input_tokens: NaN });
  for (const [k, v] of Object.entries(d))
    assert.ok(Number.isFinite(v), `${k} is ${v}`);
  assert.equal(d.in, 500, "a numeric string is coerced, not concatenated");
  assert.equal(creditUsage(new Map(), "b", { input_tokens: {} }).in, 0);
});

test("a negative token counter cannot make an axis NaN", () => {
  // computeLevels' lg() had no clamp while explainLevels' copy did. log1p of
  // anything below -1 is NaN, and one NaN arm poisons the total, tier and
  // archetype.
  const lv = computeLevels({ input_tokens: -2e6, output_tokens: 0, active_days: 3, longest_streak_days: 2 });
  for (const v of lv) assert.ok(Number.isFinite(v), `level is ${v}`);
});

test("the exclusion prompt also covers the directory fallback", async () => {
  // The predicate was applied to d.cwd only. When cwd is uninformative — which
  // is exactly when the directory name IS the project — an excluded directory's
  // name still reached the reports.
  const home = mkdtempSync(join(tmpdir(), "sf-excl-"));
  const dir = join(home, ".claude", "projects", "-home-me-SECRETCLIENT-audit");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s.jsonl"), JSON.stringify({
    type: "assistant", cwd: "/workspace", timestamp: "2026-07-01T10:00:00.000Z", uuid: "u1",
    message: { role: "assistant", id: "m1", model: "claude-opus-5",
      content: [{ type: "text", text: "x" }], usage: { input_tokens: 1, output_tokens: 1 } },
  }));
  const stats = emptyStats();
  await parseClaudeFile(join(dir, "s.jsonl"), stats,
    { excluded: (p) => String(p).includes("SECRETCLIENT") });
  const out = finalize(stats);
  assert.ok(
    !JSON.stringify(out).includes("SECRETCLIENT"),
    "an excluded project name reached the report through the directory fallback"
  );
});

test("no card loses its last words to the frame", () => {
  // box() clips at 60 instead of wrapping. Three separate cards have now lost
  // text this way, so this checks the two that were still doing it.
  const agg = {
    models: { "claude-opus-4-1-20250805": 120, "claude-3-5-sonnet-20241022": 80,
      "claude-3-5-haiku-20241022": 40 },
    languages: { python: 9, rust: 4 }, tool_call_counts: { Bash: 10 },
    night_hours: 120, longest_streak_days: 10, active_days: 40,
  };
  for (const [name, lines] of [["cardStack", cardStack(agg, null)], ["cardRank", cardRank(null, agg, [])]]) {
    for (const l of lines.map(strip))
      assert.ok(l.length <= 60, `${name}: "${l}" is ${l.length} cols`);
    assert.equal(new Set(box(lines).split("\n").map((l) => strip(l).length)).size, 1,
      `${name}: ragged frame`);
  }
  assert.ok(
    strip(cardStack(agg, null).join("\n")).includes("claude-3-5-haiku-20241022"),
    "the third model was clipped off the card entirely"
  );
});
