// Tests for src/scanners.mjs — synthetic fixtures in os.tmpdir() per provider
// format, from the porting spec. No dependence on machine-specific data.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PROVIDERS,
  providerOf,
  scanAllProviders,
  scanProvider,
  scannerVersion,
  sqliteColumnRaw,
} from "../src/scanners.mjs";

function mkHome() {
  return mkdtempSync(join(tmpdir(), "starforge-scanners-"));
}

function put(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const J = (o) => JSON.stringify(o);

// ---- gemini ----------------------------------------------------------------

test("gemini: groups by sessionId across files, cached subset, ignores total", () => {
  const home = mkHome();
  const chats = join(home, ".gemini", "tmp", "hashA", "chats");
  // One session checkpointed across two files.
  put(
    join(chats, "session-1.json"),
    J({
      sessionId: "g-s1",
      projectHash: "hashA",
      messages: [
        {
          timestamp: "2026-01-01T00:00:00Z",
          model: "gemini-2.5-pro",
          tokens: { input: 100, cached: 40, output: 20, thoughts: 5, tool: 3, total: 128 },
        },
        { timestamp: "2026-01-01T00:01:00Z" }, // no tokens dict: not a turn
      ],
    })
  );
  put(
    join(chats, "session-2.json"),
    J({
      sessionId: "g-s1",
      projectHash: "hashA",
      messages: [
        {
          timestamp: "2026-01-01T00:05:00Z",
          model: "gemini-2.5-pro",
          tokens: { input: 50, cached: 50, output: 10, thoughts: 0, tool: 0, total: 60 },
        },
      ],
    })
  );
  // JSONL variant: bare per-line message records + one corrupt line.
  put(
    join(chats, "session-3.jsonl"),
    [
      J({ timestamp: "2026-01-02T00:00:00Z", model: "gemini-2.5-flash", tokens: { input: 10, cached: 0, output: 2 } }),
      "{{{not json",
      "",
    ].join("\n")
  );
  const { providers, perSession } = scanProvider("gemini", [home]);
  const row = providers.gemini;
  assert.equal(row.sessions, 2); // g-s1 merged across files + session-3 stem
  // g-s1: input (100-40+3)+(50-50+0)=63, s3: 10 -> 73
  assert.equal(row.input, 73);
  assert.equal(row.cacheRead, 40 + 50);
  assert.equal(row.output, 25 + 10 + 2);
  assert.equal(row.cacheWrite, 0);
  assert.equal(row.installed, true);
  assert.equal(row.models["gemini-2.5-pro"], 2);
  const s1 = perSession.find((s) => s.session_id === "g-s1");
  assert.equal(s1.turns, 2);
  assert.equal(s1.model, "gemini-2.5-pro");
  assert.equal(s1.vendor, "google");
  assert.equal(s1.billed, true);
  assert.equal(s1.month, "2026-01");
});

test("gemini: copied profile under home dedupes by session_id (multi_base)", () => {
  const home = mkHome();
  const doc = J({
    sessionId: "g-dup",
    projectHash: "hashB",
    messages: [
      { timestamp: "2026-01-03T00:00:00Z", model: "gemini-2.5-pro", tokens: { input: 100, cached: 0, output: 10 } },
    ],
  });
  put(join(home, ".gemini", "tmp", "hashB", "chats", "session-1.json"), doc);
  // A backup copy two levels down: found by the depth-4 home walk, then
  // deduped by sessionId so it contributes nothing extra.
  put(join(home, "Desktop", "backupZ", ".gemini", "tmp", "hashB", "chats", "session-1.json"), doc);
  const { providers } = scanProvider("gemini", [home]);
  assert.equal(providers.gemini.sessions, 1);
  assert.equal(providers.gemini.input, 100);
});

// ---- copilot ---------------------------------------------------------------

test("copilot: shutdown-only usage, compaction whitelist, both layouts, crashed skip", () => {
  const home = mkHome();
  const state = join(home, ".copilot", "session-state");
  // Nested layout.
  put(
    join(state, "aaaa-bbbb", "events.jsonl"),
    [
      J({ timestamp: "2026-02-01T10:00:00Z", type: "assistant.message", data: { model: "claude-sonnet-4.5" } }),
      J({ timestamp: "2026-02-01T10:01:00Z", type: "context.snapshot", data: { currentTokens: 99999, conversationTokens: 88888 } }),
      J({ timestamp: "2026-02-01T10:01:30Z", type: "session.truncation", data: { tokenLimit: 200000, preTruncationTokensInMessages: 150000, tokensRemovedDuringTruncation: 50000 } }),
      J({ timestamp: "2026-02-01T10:02:00Z", type: "session.compaction_complete", data: { compactionTokensUsed: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, duration: 5000 } } }),
      J({ timestamp: "2026-02-01T10:03:00Z", type: "session.shutdown", data: { modelMetrics: { "claude-sonnet-4.5": { usage: { inputTokens: 1000, outputTokens: 200, reasoningTokens: 50, cacheReadTokens: 400, cacheWriteTokens: 300 } } } } }),
    ].join("\n")
  );
  // Flat layout: <uuid>.jsonl directly in session-state/.
  put(
    join(state, "cccc-dddd.jsonl"),
    J({ timestamp: "2026-02-02T09:00:00Z", type: "session.shutdown", data: { modelMetrics: { "gpt-5": { usage: { inputTokens: 10, outputTokens: 5 } } } } })
  );
  // Crashed session: no shutdown/compaction -> contributes NOTHING.
  put(
    join(state, "eeee-ffff", "events.jsonl"),
    J({ timestamp: "2026-02-03T09:00:00Z", type: "assistant.message", data: { model: "gpt-5" } })
  );
  const { providers, perSession } = scanProvider("copilot", [home]);
  const row = providers.copilot;
  assert.equal(row.sessions, 2);
  assert.equal(row.input, 1000 + 100 + 10);
  assert.equal(row.output, 200 + 50 + 20 + 5); // reasoning alongside output
  assert.equal(row.cacheRead, 400 + 30);
  assert.equal(row.cacheWrite, 300);
  const a = perSession.find((s) => s.session_id === "aaaa-bbbb");
  assert.equal(a.model, "claude-sonnet-4.5"); // compaction never wins the vote
  assert.equal(a.vendor, "anthropic"); // cli=copilot, provider=anthropic
  const flat = perSession.find((s) => s.session_id === "cccc-dddd");
  assert.equal(flat.vendor, "openai");
  assert.ok(!perSession.find((s) => s.session_id === "eeee-ffff"));
});

// ---- grok ------------------------------------------------------------------

test("grok: turn_completed only, modelUsage over top-level, epoch timestamps", () => {
  const home = mkHome();
  const sdir = join(home, ".grok", "sessions", "%2FUsers%2Ftest%2Fproj", "sess-1");
  put(
    join(sdir, "updates.jsonl"),
    [
      // Mid-turn snapshot with the SAME field names: must be ignored.
      J({ timestamp: 1750000000, params: { update: { sessionUpdate: "usage_snapshot", usage: { inputTokens: 500, outputTokens: 100 } } } }),
      // Per-model breakdown wins over the top-level sum.
      J({ timestamp: "2026-03-01T00:00:00Z", params: { update: { sessionUpdate: "turn_completed", usage: { inputTokens: 999, outputTokens: 999, modelUsage: { "grok-4": { inputTokens: 300, cachedReadTokens: 120, outputTokens: 80 } } } } }, _meta: { totalTokens: 123456 } }),
      // No modelUsage: top level as fallback; epoch ms timestamp.
      J({ timestamp: 1750000000000, params: { update: { sessionUpdate: "turn_completed", usage: { inputTokens: 50, cachedReadTokens: 10, outputTokens: 5 } } } }),
    ].join("\n")
  );
  const { providers, perSession } = scanProvider("grok", [home]);
  const row = providers.grok;
  assert.equal(row.sessions, 1);
  assert.equal(row.input, 300 - 120 + (50 - 10));
  assert.equal(row.cacheRead, 120 + 10);
  assert.equal(row.output, 80 + 5);
  const s = perSession[0];
  assert.equal(s.turns, 2);
  assert.equal(s.model, "grok-4");
  assert.equal(s.vendor, "xai");
  assert.equal(s.project, "/Users/test/proj"); // url-decoded
  assert.deepEqual(row.models, { "grok-4": 1, grok: 1 });
});

// ---- kilo ------------------------------------------------------------------

test("kilo: tokensIn already contains cache, placeholder rows skipped, model from history", () => {
  const home = mkHome();
  const tdir = join(
    home, ".config", "Code", "User", "globalStorage", "kilocode.kilo-code", "tasks", "task-1"
  );
  put(
    join(tdir, "ui_messages.json"),
    J([
      { ts: 1738368000000, say: "text", text: "hi" },
      {
        ts: 1738368060000,
        say: "api_req_started",
        text: J({ tokensIn: 1000, tokensOut: 50, cacheReads: 600, cacheWrites: 200, inferenceProvider: "anthropic" }),
      },
      { ts: 1738368120000, say: "api_req_started", text: J({ tokensIn: 0, tokensOut: 0 }) },
    ])
  );
  put(
    join(tdir, "api_conversation_history.json"),
    'stuff <model>anthropic/claude-sonnet-4.5</model> more'
  );
  const { providers, perSession } = scanProvider("kilo", [home]);
  const row = providers.kilo;
  assert.equal(row.sessions, 1);
  assert.equal(row.input, 1000 - 600 - 200); // subtract BOTH cache buckets
  assert.equal(row.cacheRead, 600);
  assert.equal(row.cacheWrite, 200);
  assert.equal(row.output, 50);
  const s = perSession[0];
  assert.equal(s.turns, 1); // placeholder row skipped
  assert.equal(s.model, "claude-sonnet-4.5"); // last path segment
  assert.equal(s.vendor, "anthropic");
  assert.equal(s.month, "2025-02"); // epoch ms 1738368000000 = 2025-02-01
  assert.ok(s.account.includes("Code"));
});

// ---- antigravity -----------------------------------------------------------

const AGY_KEY = Buffer.from("safeCodeiumworldKeYsecretBalloon");

function pbv(n) {
  const bytes = [];
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n) b |= 0x80;
    bytes.push(b);
  } while (n);
  return Buffer.from(bytes);
}
const varField = (fn, n) => Buffer.concat([pbv(fn * 8), pbv(n)]);
const lenField = (fn, buf) => Buffer.concat([pbv(fn * 8 + 2), pbv(buf.length), buf]);

function agyTrajectory() {
  // ModelUsageStats: f2 uncached=100, f3 output=50, f5 cached=30,
  // f9+f10 = 40+10 == f3, f11 request id.
  const usageMsg = Buffer.concat([
    varField(2, 100), varField(3, 50), varField(5, 30),
    varField(9, 40), varField(10, 10), lenField(11, Buffer.from("req-1")),
  ]);
  const step = lenField(9, usageMsg);
  const tsMsg = varField(1, 1738368000); // 2025-02-01T00:00:00Z, shape {1:sec}
  return Buffer.concat([
    lenField(1, Buffer.concat([step, lenField(4, tsMsg)])),
    lenField(2, step), // SAME request in another step: dedup on field 11
    lenField(7, Buffer.from("model: gemini-3-flash")),
  ]);
}

function agyEncrypt(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", AGY_KEY, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]);
}

test("antigravity: encrypted .pb decodes, dedups on request id, garbage is unreadable", () => {
  const home = mkHome();
  const conv = join(home, ".gemini", "antigravity-cli", "conversations");
  put(join(conv, "conv-pb-1.pb"), agyEncrypt(agyTrajectory()));
  put(join(conv, "garbage.pb"), randomBytes(256)); // bad tag -> unreadable, never zero
  const { providers, perSession } = scanProvider("antigravity", [home]);
  const row = providers.antigravity;
  assert.equal(row.sessions, 1);
  assert.equal(row.unreadable, 1);
  assert.equal(row.input, 100);
  assert.equal(row.cacheRead, 30);
  assert.equal(row.output, 50);
  const s = perSession[0];
  assert.equal(s.turns, 1); // duplicated request counted once
  assert.equal(s.model, "gemini-3-flash");
  assert.equal(s.vendor, "google");
  assert.equal(s.month, "2025-02"); // from the embedded Timestamp
});

test("antigravity: .db via SQLite, gen_metadata model outvotes blob scan", (t) => {
  let hasSqlite3 = true;
  try { execFileSync("sqlite3", ["--version"], { stdio: "ignore" }); } catch { hasSqlite3 = false; }
  if (!hasSqlite3) return t.skip("sqlite3 CLI not available to build fixture");
  const home = mkHome();
  const conv = join(home, ".gemini", "antigravity-cli", "conversations");
  mkdirSync(conv, { recursive: true });
  const db = join(conv, "conv-db-1.db");
  const hex = agyTrajectory().toString("hex");
  const genHex = Buffer.from("please use gemini-3-flash-high today").toString("hex");
  execFileSync("sqlite3", [
    db,
    `CREATE TABLE steps (metadata BLOB);
     INSERT INTO steps VALUES (x'${hex}');
     CREATE TABLE gen_metadata (data BLOB);
     INSERT INTO gen_metadata VALUES (x'${genHex}');`,
  ]);
  const { providers, perSession } = scanProvider("antigravity", [home]);
  assert.equal(providers.antigravity.sessions, 1);
  assert.equal(providers.antigravity.input, 100);
  assert.equal(providers.antigravity.output, 50);
  assert.equal(providers.antigravity.cacheRead, 30);
  // Longest match carries the tier suffix; 1000-weight vote is authoritative.
  assert.equal(perSession[0].model, "gemini-3-flash-high");
});

test("antigravity: raw sqlite reader reads table columns directly", (t) => {
  let hasSqlite3 = true;
  try { execFileSync("sqlite3", ["--version"], { stdio: "ignore" }); } catch { hasSqlite3 = false; }
  if (!hasSqlite3) return t.skip("sqlite3 CLI not available to build fixture");
  const dir = mkHome();
  const db = join(dir, "raw.db");
  execFileSync("sqlite3", [
    db,
    `CREATE TABLE steps (id INTEGER, metadata BLOB);
     INSERT INTO steps VALUES (1, x'deadbeef');
     INSERT INTO steps VALUES (2, x'cafe');`,
  ]);
  const rows = sqliteColumnRaw(db, "steps", "metadata");
  assert.equal(rows.length, 2);
  assert.equal(Buffer.from(rows[0]).toString("hex"), "deadbeef");
  assert.equal(Buffer.from(rows[1]).toString("hex"), "cafe");
  assert.throws(() => sqliteColumnRaw(db, "nope", "x"));
});

// ---- shared machinery ------------------------------------------------------

test("providerOf prefix table", () => {
  assert.equal(providerOf("claude-opus-4"), "anthropic");
  assert.equal(providerOf("gpt-5.5"), "openai");
  assert.equal(providerOf("gemini-3-flash"), "google");
  assert.equal(providerOf("grok-4"), "xai");
  assert.equal(providerOf("unknown"), "synthetic");
  assert.equal(providerOf("weird-model"), "other");
});

test("scannerVersion is a 12-char hex fingerprint", () => {
  assert.match(scannerVersion(), /^[0-9a-f]{12}$/);
});

test("unknown provider throws; empty home yields zero rows, not throws", () => {
  assert.throws(() => scanProvider("nope", [mkHome()]));
  const { providers, perSession } = scanAllProviders([mkHome()]);
  assert.deepEqual(Object.keys(providers).sort(), [...PROVIDERS].sort());
  assert.equal(perSession.length, 0);
  for (const row of Object.values(providers)) {
    assert.equal(row.sessions, 0);
    assert.equal(row.installed, false);
    assert.equal(row.firstTs, null);
  }
});

// ---- live machine (absence must not throw) ---------------------------------

test("scanAllProviders live run tolerates whatever this machine has", () => {
  const res = scanAllProviders();
  assert.ok(res.providers && res.perSession);
  for (const name of PROVIDERS) {
    const row = res.providers[name];
    assert.ok(row, `row for ${name}`);
    assert.equal(typeof row.sessions, "number");
    assert.equal(typeof row.installed, "boolean");
    assert.ok(row.input >= 0 && row.output >= 0);
  }
  for (const s of res.perSession) {
    assert.ok(PROVIDERS.includes(s.provider));
    assert.ok(Number.isFinite(s.input) && s.input >= 0);
  }
});
