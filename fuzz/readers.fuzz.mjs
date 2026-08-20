// Coverage-guided fuzzing of the readers, which have never had it.
//
// Atheris found SEVEN crashes in deadreckon's Python readers, every one the
// same shape: a JSON value that is not the type the reader assumed. Atheris is
// Python-only, so this half of the fleet has never been fuzzed at all — the
// 958 tests all feed it transcripts someone thought of.
//
// The contract being fuzzed: A READER NEVER THROWS. A malformed transcript is
// a transcript to skip and name, not an exception that takes the scan down
// with it. Any throw here is a finding.
//
//   npx jazzer fuzz/readers.fuzz --sync -- -runs=200000
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readClaudeOrphans, readClawspring, readLmstudio, readCopilotChat, readHistory,
} from "../src/readers.mjs";

// Fragments that appear in real transcripts, so the fuzzer starts near the
// format instead of a million miles from it.
const KEYS = [
  "message", "usage", "input_tokens", "output_tokens", "cache_read_input_tokens",
  "cache_creation_input_tokens", "session_id", "sessionId", "timestamp", "ts",
  "lastTotalInputTokens", "lastModelUsage", "totalTokens", "requests",
  "total_input_tokens", "total_output_tokens", "model", "role", "type", "uuid",
];
// The values that broke the Python side: a bool, a string, a list, a null
// where a dict was assumed.
const VALUES = ["true", "false", "null", "0", '""', "[]", "{}", '"x"', "-1",
                "1e400", "1.5", '{"usage":true}', '[{"usage":[]}]', "9".repeat(40)];

function jsonish(d) {
  const n = d.consumeIntegralInRange(0, 6);
  if (n === 0) return d.consumeString(d.consumeIntegralInRange(0, 60));
  const parts = [];
  for (let i = 0; i < d.consumeIntegralInRange(1, 6); i++) {
    const k = KEYS[d.consumeIntegralInRange(0, KEYS.length - 1)];
    const v = VALUES[d.consumeIntegralInRange(0, VALUES.length - 1)];
    parts.push(`${JSON.stringify(k)}:${v}`);
  }
  return `{${parts.join(",")}}`;
}

export function fuzz(data) {
  const { FuzzedDataProvider } = globalThis.__jazzer_fdp__ ?? {};
  const d = FuzzedDataProvider
    ? new FuzzedDataProvider(data)
    : makeProvider(data);

  const home = mkdtempSync(join(tmpdir(), "srfuzz-"));
  try {
    const body = [];
    for (let i = 0; i < d.consumeIntegralInRange(1, 5); i++) body.push(jsonish(d));
    const jsonl = body.join("\n") + (d.consumeIntegralInRange(0, 1) ? "\n" : "");
    const one = body[0];

    mkdirSync(join(home, ".claude", "projects", "w"), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", "w", "s-1.jsonl"), jsonl);
    writeFileSync(join(home, ".claude.json"), one);

    mkdirSync(join(home, ".clawspring", "sessions", "daily", "2026-01-01"), { recursive: true });
    writeFileSync(join(home, ".clawspring", "sessions", "daily", "2026-01-01", "session_a.json"), one);

    mkdirSync(join(home, ".lmstudio", "conversations"), { recursive: true });
    writeFileSync(join(home, ".lmstudio", "conversations", "c-1.json"), one);

    const calls = [
      ["claudeOrphans", () => readClaudeOrphans(home, new Set(["live-1"]))],
      ["clawspring",    () => readClawspring(home)],
      ["lmstudio",      () => readLmstudio(home)],
      ["copilotChat",   () => readCopilotChat(home)],
      ["history",       () => readHistory(home)],
    ];
    for (const [who, call] of calls) {
      let r;
      try { r = call(); }
      catch (e) { e.message = `${who}: ${e.message}\n  input was: ${jsonl.slice(0, 300)}`; throw e; }
      const fail = (m) => { throw new Error(`${who}: ${m}\n  input was: ${jsonl.slice(0, 300)}`); };
      // A reader that returns is also making promises. Check the ones every
      // caller relies on, because a silently wrong shape is worse than a throw.
      if (r == null) fail("reader returned null");
      if (typeof r.state !== "string") fail(`state is ${typeof r.state}`);
      if (!Array.isArray(r.sessions)) fail(`sessions is ${typeof r.sessions}`);
      if (r.total != null && !Number.isFinite(r.total)) fail(`total is ${r.total}`);
      for (const s of r.sessions) {
        if (s == null || typeof s !== "object") fail("a session is not an object");
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// A tiny provider so the file also runs under plain node for a smoke test.
function makeProvider(buf) {
  let i = 0;
  const byte = () => (i < buf.length ? buf[i++] : 0);
  return {
    consumeIntegralInRange: (lo, hi) => lo + (byte() % Math.max(1, hi - lo + 1)),
    consumeString: (n) => Buffer.from(Array.from({ length: n }, byte)).toString("latin1"),
  };
}
