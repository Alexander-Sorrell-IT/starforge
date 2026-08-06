import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORRECTION_RE,
  classifyProvider,
  rateForModel,
  computeStreaks,
  sweepConcurrency,
  computeToolRelationship,
  collectProfileSignals,
  computeProfile,
} from "../src/profile.mjs";
import { renderStatsPage, human } from "../src/statspage.mjs";

// ---- fixtures --------------------------------------------------------------

function claudeLine(obj) {
  return JSON.stringify(obj);
}

function writeClaudeFixture(dir) {
  const p = join(dir, "sess-claude-1.jsonl");
  const lines = [
    // filtered out: injected wrapper, slash command, too short
    claudeLine({ type: "user", sessionId: "sess-claude-1", timestamp: "2026-08-01T10:00:00Z", cwd: "/Users/someone/Projects/demo", message: { content: "<command-name>/foo</command-name>" } }),
    claudeLine({ type: "user", sessionId: "sess-claude-1", timestamp: "2026-08-01T10:01:00Z", message: { content: "/compact" } }),
    claudeLine({ type: "user", sessionId: "sess-claude-1", timestamp: "2026-08-01T10:02:00Z", message: { content: "ok do it" } }),
    // counted: one question, one correction
    claudeLine({ type: "user", sessionId: "sess-claude-1", timestamp: "2026-08-01T10:03:00Z", message: { content: "Please refactor the parser to handle unicode?" } }),
    claudeLine({ type: "user", sessionId: "sess-claude-1", timestamp: "2026-08-01T10:04:00Z", message: { content: "no that's wrong, revert the change immediately" } }),
    // assistant: usage (deduped by msg id), model, tool_use with file paths
    claudeLine({
      type: "assistant", sessionId: "sess-claude-1", timestamp: "2026-08-01T10:05:00Z",
      message: {
        id: "msg_1", model: "claude-sonnet-4-5",
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000 },
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "/Users/someone/Projects/demo/src/app.py" } },
          { type: "tool_use", name: "Bash", input: {} },
        ],
      },
    }),
    // duplicate message id: usage must NOT double-count
    claudeLine({
      type: "assistant", sessionId: "sess-claude-1", timestamp: "2026-08-01T10:06:00Z",
      message: { id: "msg_1", model: "claude-sonnet-4-5", usage: { input_tokens: 1000, output_tokens: 500 }, content: [] },
    }),
  ];
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

function writeCodexFixture(dir) {
  const p = join(dir, "rollout-codex.jsonl");
  const lines = [
    claudeLine({ type: "session_meta", timestamp: "2026-08-01T22:00:00Z", payload: { id: "codex-sess-1", model: "gpt-5-codex", cwd: "/Users/someone/Projects/otherproj" } }),
    claudeLine({ type: "response_item", timestamp: "2026-08-01T22:01:00Z", payload: { role: "user", content: [{ type: "input_text", text: "Set up the build pipeline for the repo" }] } }),
    claudeLine({ type: "response_item", timestamp: "2026-08-01T22:02:00Z", payload: { type: "function_call", name: "shell" } }),
    // cumulative token counters: second event OVERWRITES the first
    claudeLine({ type: "event_msg", timestamp: "2026-08-01T22:03:00Z", payload: { info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100 } } } }),
    claudeLine({ type: "event_msg", timestamp: "2026-08-01T22:04:00Z", payload: { info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 1000, output_tokens: 400 } } } }),
  ];
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

// Synthetic signals in the exact shape collectProfileSignals returns.
function syntheticSignals() {
  const day = (d) => Date.parse(`2026-08-0${d}T10:00:00Z`);
  return {
    generated_at: "2026-08-02T00:00:00.000Z",
    files_scanned: 3,
    per_source: {
      claude_code: {
        files: 2, prompt_turns: 80, prompt_chars_total: 16000, question_turns: 20,
        correction_turns: 8, tool_calls: 400,
        tool_counts: { Edit: 120, Bash: 100, Read: 90, Write: 40, Task: 30, Grep: 20 },
        languages: { python: 5, javascript: 3 },
        first_ts: day(1), last_ts: day(2),
      },
      cowork: {
        files: 1, prompt_turns: 20, prompt_chars_total: 1000, question_turns: 10,
        correction_turns: 2, tool_calls: 50,
        tool_counts: { Edit: 30, Read: 20 },
        languages: { markdown: 4 },
        first_ts: day(1), last_ts: day(1),
      },
    },
    sessions: [
      { id: "aaaa1111", source: "claude_code", project: "Projects/demo", start_ts: day(1), end_ts: day(1) + 3.6e6, active_ms: 3.6e6, turns: 50, tok: { in: 1e6, out: 1e6, cr: 4e6, cw: 1e6 }, model: "claude-sonnet-4-5" },
      { id: "bbbb2222", source: "claude_code", project: "Projects/demo", start_ts: day(1) + 1.8e6, end_ts: day(1) + 5.4e6, active_ms: 1.8e6, turns: 30, tok: { in: 5e5, out: 5e5, cr: 0, cw: 0 }, model: "claude-opus-4-6" },
      { id: "cccc3333", source: "cowork", project: null, start_ts: day(2), end_ts: day(2) + 0.6e6, active_ms: 0.6e6, turns: 20, tok: { in: 1e5, out: 1e5, cr: 0, cw: 0 }, model: "claude-sonnet-4-5" },
    ],
    active_days: ["2026-08-01", "2026-08-02"],
    hour_counts: (() => { const h = new Array(24).fill(0); h[10] = 40; h[23] = 30; h[2] = 30; return h; })(),
    weekend_events: 40,
    total_events: 100,
  };
}

// ---- ported primitives -----------------------------------------------------

test("CORRECTION_RE matches Standout's verbatim semantics", () => {
  assert.ok(CORRECTION_RE.test("no that's wrong"));
  assert.ok(CORRECTION_RE.test("actually use the other file"));
  assert.ok(CORRECTION_RE.test("don't do that"));
  assert.ok(CORRECTION_RE.test("Don't forget to also run the tests")); // documented false positive
  assert.ok(!CORRECTION_RE.test("please add a new endpoint"));
});

test("classifyProvider ports verbatim", () => {
  assert.equal(classifyProvider("claude-sonnet-4-5"), "anthropic");
  assert.equal(classifyProvider("gpt-5-codex"), "openai");
  assert.equal(classifyProvider("o3-mini"), "openai");
  assert.equal(classifyProvider("llama-3"), "other");
});

test("rateForModel: known models + default", () => {
  assert.equal(rateForModel("claude-opus-4-6").input, 7.5);
  assert.equal(rateForModel("claude-sonnet-4-5").output, 15);
  assert.equal(rateForModel("gpt-4o").input, 2.5);
  assert.equal(rateForModel("mystery-model").input, 5);
  assert.equal(rateForModel(null).output, 25);
});

test("computeStreaks: zY9 semantics — current walks back from TODAY", () => {
  // active yesterday only -> current is ZERO (this is where scan.mjs deviates)
  assert.deepEqual(computeStreaks(["2026-08-01"], "2026-08-02"), { current: 0, longest: 1 });
  // active today and yesterday -> 2
  assert.deepEqual(computeStreaks(["2026-08-01", "2026-08-02"], "2026-08-02"), { current: 2, longest: 2 });
  // gap in history: longest spans the run, current only the live tail
  assert.deepEqual(
    computeStreaks(["2026-07-25", "2026-07-26", "2026-07-27", "2026-08-02"], "2026-08-02"),
    { current: 1, longest: 3 }
  );
  assert.deepEqual(computeStreaks([], "2026-08-02"), { current: 0, longest: 0 });
});

test("sweepConcurrency: overlap peak, avg, juggle", () => {
  const h = 3.6e6;
  const r = sweepConcurrency([
    { start_ts: 0, end_ts: h, active_ms: h },
    { start_ts: h / 2, end_ts: h * 1.5, active_ms: h },
  ]);
  assert.equal(r.open_peak, 2);
  assert.equal(r.juggle_pct, 33.3); // 30min of 90min covered
  assert.ok(Math.abs(r.open_avg - 4 / 3) < 0.01);
  assert.deepEqual(sweepConcurrency([]), { open_peak: 0, open_avg: 0, juggle_pct: 0 });
});

test("computeToolRelationship: loyalist and switch", () => {
  const mk = (month, source) => ({ start_ts: Date.parse(`${month}-05T10:00:00Z`), source });
  const loyal = computeToolRelationship([mk("2026-05", "claude_code"), mk("2026-06", "claude_code")]);
  assert.equal(loyal.kind, "loyalist");
  assert.equal(loyal.tool, "Claude Code");
  const sw = computeToolRelationship([
    mk("2026-05", "codex"), mk("2026-05", "codex"),
    mk("2026-06", "claude_code"), mk("2026-06", "claude_code"),
    mk("2026-07", "claude_code"),
  ]);
  assert.equal(sw.kind, "switch");
  assert.equal(sw.from_tool, "Codex");
  assert.equal(sw.to_tool, "Claude Code");
  assert.equal(sw.switch_month, "2026-06");
  assert.equal(computeToolRelationship([]).kind, "insufficient");
});

// ---- collectProfileSignals on temp fixtures --------------------------------

test("collectProfileSignals: counts prompts, filters low-signal, dedups usage, no text stored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "starforge-profile-"));
  try {
    const claudePath = writeClaudeFixture(dir);
    const codexPath = writeCodexFixture(dir);
    const sig = await collectProfileSignals([
      { source: "claude_code", path: claudePath },
      { source: "codex", path: codexPath },
      { source: "claude_code", path: join(dir, "missing.jsonl") }, // must be skipped, not throw
    ]);
    const cc = sig.per_source.claude_code;
    assert.equal(cc.prompt_turns, 2); // wrapper, slash, short all filtered
    assert.equal(cc.question_turns, 1);
    assert.equal(cc.correction_turns, 1);
    assert.equal(cc.tool_counts.Edit, 1);
    assert.equal(cc.tool_counts.Bash, 1);
    assert.equal(cc.languages.python, 1);
    const cx = sig.per_source.codex;
    assert.equal(cx.prompt_turns, 1);
    assert.equal(cx.tool_counts.shell, 1);

    const claudeSess = sig.sessions.find((s) => s.source === "claude_code");
    // duplicate msg_1 usage counted once
    assert.equal(claudeSess.tok.in, 1000);
    assert.equal(claudeSess.tok.out, 500);
    assert.equal(claudeSess.tok.cr, 8000);
    assert.equal(claudeSess.tok.cw, 2000);
    assert.equal(claudeSess.model, "claude-sonnet-4-5");
    assert.equal(claudeSess.turns, 5); // raw user turns, pre-filter
    assert.ok(claudeSess.id.length <= 8);
    // path masked before storage
    assert.ok(!JSON.stringify(sig).includes("/Users/someone"));

    const codexSess = sig.sessions.find((s) => s.source === "codex");
    // cumulative counters overwritten, not summed; no cache-write counter
    assert.equal(codexSess.tok.in, 4000);
    assert.equal(codexSess.tok.cr, 1000);
    assert.equal(codexSess.tok.out, 400);
    assert.equal(codexSess.tok.cw, 0);

    // PRIVACY: no prompt text may survive into the signals object
    const blob = JSON.stringify(sig);
    assert.ok(!blob.includes("refactor the parser"));
    assert.ok(!blob.includes("revert the change"));
    assert.ok(!blob.includes("build pipeline"));
    assert.deepEqual(sig.active_days, ["2026-08-01"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectProfileSignals: empty input returns empty signals, never throws", async () => {
  const sig = await collectProfileSignals([]);
  assert.deepEqual(sig.sessions, []);
  assert.deepEqual(sig.per_source, {});
  assert.equal(sig.total_events, 0);
  const sig2 = await collectProfileSignals(undefined);
  assert.deepEqual(sig2.sessions, []);
});

// ---- computeProfile --------------------------------------------------------

test("computeProfile: conversation ratios weighted across sources", () => {
  const now = Date.parse("2026-08-02T12:00:00Z");
  const p = computeProfile(syntheticSignals(), { now });
  // 100 prompt turns, 10 corrections, 30 questions, 17000 chars
  assert.equal(p.conversation.prompt_turns, 100);
  assert.equal(p.conversation.correction_rate_pct, 10);
  assert.equal(p.conversation.question_ratio, 0.3);
  assert.equal(p.conversation.avg_prompt_chars, 170);
  assert.equal(p.conversation.prompt_bucket, "directive");
});

test("computeProfile: delegation, tool mix, craft exclusions", () => {
  const p = computeProfile(syntheticSignals(), { now: Date.parse("2026-08-02T12:00:00Z") });
  assert.equal(p.delegation.tool_calls, 450);
  assert.equal(p.delegation.delegation_ratio, 4.5);
  // hands-on over code sources only: (120 Edit + 40 Write) / 400 claude_code calls
  assert.equal(p.delegation.hands_on_code_pct, 40);
  assert.equal(p.delegation.tool_mix[0].name, "Edit");
  assert.equal(p.delegation.tool_mix[0].count, 150);
  // languages exclude cowork's markdown
  assert.deepEqual(p.languages, { python: 5, javascript: 3 });
});

test("computeProfile: tokens split, retail cost, records, streak override", () => {
  const now = Date.parse("2026-08-02T12:00:00Z");
  const p = computeProfile(syntheticSignals(), { now });
  assert.equal(p.tokens.fresh_input, 1.6e6);
  assert.equal(p.tokens.output, 1.6e6);
  assert.equal(p.tokens.cache_read, 4e6);
  assert.equal(p.tokens.cache_write, 1e6);
  assert.equal(p.tokens.new_content, 1.6e6 + 1e6 + 1.6e6);
  assert.equal(p.tokens.work_tokens, 3.2e6);
  // month 2026-08 dominant model = sonnet (2 sessions vs 1 opus):
  // (1.6M*3 + 1.6M*15 + 4M*0.3 + 1M*3.75)/1M = 4.8+24+1.2+3.75 = 33.75
  assert.equal(p.tokens.retail_cost_usd, 33.75);
  // records: longest session by DURATION
  assert.equal(p.records.longest_session.id, "aaaa1111");
  assert.equal(p.records.most_tokens_session.id, "aaaa1111");
  assert.equal(p.records.most_turns_session.id, "aaaa1111");
  // biggest day: all of aaaa+bbbb start 08-01
  assert.equal(p.records.biggest_day.date, "2026-08-01");
  // streaks: today (08-02) active -> current 2
  assert.equal(p.cadence.current_streak_days, 2);
  assert.equal(p.cadence.longest_streak_days, 2);
  // concurrency: aaaa and bbbb overlap
  assert.equal(p.concurrency.open_peak, 2);
  assert.equal(p.concurrency.longest_session_hours, 1);
});

test("computeProfile: zero prompt turns -> ratios are null, not 0", () => {
  const p = computeProfile(
    { per_source: {}, sessions: [], active_days: [], hour_counts: new Array(24).fill(0), weekend_events: 0, total_events: 0 },
    { now: Date.parse("2026-08-02T12:00:00Z") }
  );
  assert.equal(p.conversation.correction_rate_pct, null);
  assert.equal(p.conversation.question_ratio, null);
  assert.equal(p.conversation.avg_prompt_chars, null);
  assert.equal(p.delegation.delegation_ratio, null);
  assert.equal(p.rhythm.weekend_ratio, null);
  assert.equal(p.proficiency, null);
  assert.equal(p.tokens.retail_cost_usd, null);
});

test("computeProfile: tolerates completely empty/undefined input", () => {
  const p = computeProfile(undefined);
  assert.equal(p.cadence.total_sessions, 0);
  assert.equal(p.records.longest_session, null);
  assert.equal(p.tool_relationship.kind, "insufficient");
});

// ---- renderStatsPage -------------------------------------------------------

test("renderStatsPage: smoke — sections, footer, no raw secrets", () => {
  const now = Date.parse("2026-08-02T12:00:00Z");
  const sig = syntheticSignals();
  sig.sessions[0].project = "Projects/demo api_key= sk-ant-abcdefghij0123456789xyz"; // must be redacted
  const profile = computeProfile(sig, { now });
  const html = renderStatsPage({
    profile,
    agg: { total_sessions: 3, monthly_buckets: [{ month: "2026-07", sessions: 1, input_tokens: 5, output_tokens: 5, cache_tokens: 0 }, { month: "2026-08", sessions: 2, input_tokens: 5, output_tokens: 5, cache_tokens: 0 }] },
    accounts: [{ account: "a@example.com", tokens: 12345 }],
    starSvg: "<svg xmlns='http://www.w3.org/2000/svg'><text>STAR</text></svg>",
    velocity: { hours_trend_per_month: 2.5 },
    name: "ALEX",
  });
  assert.ok(html.startsWith("<!doctype html>"));
  for (const key of [
    "JUDGMENT SIGNALS", "RHYTHM", "TOKEN ECONOMICS", "TOOLS &amp; MODELS",
    "CRAFT", "RECORDS", "ACCOUNTS",
    // "nothing uploaded" used to be required here. The footer must NOT assert
    // it (see tests/cli-ux.test.mjs) — the page cannot prove it — so the
    // required string is the honest replacement.
    "computed locally", "no page can prove its own no-egress claim", "ALEX", "STAR",
    "correction rate", "question ratio", "delegation ratio",
  ])
    assert.ok(html.includes(key), `missing: ${key}`);
  assert.ok(!html.includes("sk-ant-abcdefghij"), "secret leaked into HTML");
  assert.ok(!html.includes("<script"), "page must have zero JS");
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html), "no external resources");
});

test("renderStatsPage: all-null input renders dashes, never crashes", () => {
  const html = renderStatsPage({});
  assert.ok(html.includes("&#8212;"));
  assert.ok(html.includes("computed locally"));
  const html2 = renderStatsPage();
  assert.ok(typeof html2 === "string" && html2.length > 500);
});

test("human formatter: K/M/B/T", () => {
  assert.equal(human(950), "950");
  assert.equal(human(1500), "1.5K");
  assert.equal(human(2.4e6), "2.4M");
  assert.equal(human(3.1e9), "3.1B");
  assert.equal(human(1.2e12), "1.2T");
  assert.equal(human(null), null);
});
