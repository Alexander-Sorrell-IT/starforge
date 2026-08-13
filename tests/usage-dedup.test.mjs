// Counting one API call once, at its full value.
//
// Claude Code writes the same assistant message repeatedly while it streams —
// up to 19 times in the 20,217-transcript corpus. Every copy carries the same
// message.id and the same input/cache figures, and an EARLY copy carries a
// partial output_tokens: 8, where the finished answer was 434.
//
// That gives two ways to be wrong, in opposite directions:
//
//   count every row      -> 42,415,350,168 tokens claimed for 18,443,391,808 spent
//   keep the first row   -> 35.6% of all output tokens silently discarded
//                           (31,005,673 of 87,199,429)
//
// starreckon shipped the second one. Both are pinned here, because a future
// "simplification" to either shape is a plausible edit that no other test sees:
// the totals stay in the right ballpark and nothing throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { creditUsage, emptyStats, parseClaudeFile, finalize } from "../src/scan.mjs";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const usage = (out, extra = {}) => ({
  input_tokens: 1,
  cache_creation_input_tokens: 25703,
  cache_read_input_tokens: 44628,
  output_tokens: out,
  ...extra,
});

test("one message written many times is counted once", () => {
  const seen = new Map();
  const first = creditUsage(seen, "msg_1", usage(8));
  assert.deepEqual(first, { in: 1, out: 8, cr: 44628, cw: 25703 });
  // Three identical repeats add nothing at all.
  for (let i = 0; i < 3; i++)
    assert.deepEqual(creditUsage(seen, "msg_1", usage(8)), { in: 0, out: 0, cr: 0, cw: 0 });
});

test("the final write's output is credited, not the partial one", () => {
  // The exact shape from the corpus: four partial writes at 8, then the real 434.
  const seen = new Map();
  let out = 0;
  for (const o of [8, 8, 8, 8, 434]) out += creditUsage(seen, "msg_1", usage(o)).out;
  assert.equal(out, 434, "the completed answer must be what counts");
});

test("a later, smaller write can never reduce a total", () => {
  // Max rather than last: a truncated final write must not erase work that
  // really happened.
  const seen = new Map();
  let out = 0;
  for (const o of [434, 8]) out += creditUsage(seen, "msg_1", usage(o)).out;
  assert.equal(out, 434);
});

test("different messages are independent", () => {
  const seen = new Map();
  assert.equal(creditUsage(seen, "a", usage(100)).out, 100);
  assert.equal(creditUsage(seen, "b", usage(200)).out, 200);
  assert.equal(creditUsage(seen, "a", usage(100)).out, 0);
});

test("a message with no id is its own message", () => {
  // Nothing to correlate it with, so it must not be folded into a previous one.
  const seen = new Map();
  assert.equal(creditUsage(seen, null, usage(50)).out, 50);
  assert.equal(creditUsage(seen, null, usage(50)).out, 50);
});

test("missing usage fields count as zero, never NaN", () => {
  const seen = new Map();
  const d = creditUsage(seen, "x", {});
  assert.deepEqual(d, { in: 0, out: 0, cr: 0, cw: 0 });
  for (const v of Object.values(creditUsage(seen, "y", undefined)))
    assert.ok(Number.isFinite(v));
});

test("end to end: a streamed transcript reports the finished output", async () => {
  const home = mkdtempSync(join(tmpdir(), "sf-dedup-"));
  const dir = join(home, ".claude", "projects", "-w-a");
  mkdirSync(dir, { recursive: true });
  const rows = [];
  rows.push({ type: "user", cwd: "/w/a", timestamp: "2026-07-15T15:00:00.000Z", uuid: "u0",
    message: { role: "user", content: "a prompt long enough to be counted" } });
  // Five writes of ONE assistant message, exactly as Claude Code emits them.
  [8, 8, 8, 8, 434].forEach((o, i) =>
    rows.push({ type: "assistant", timestamp: "2026-07-15T15:00:01.000Z", uuid: `m${i}`,
      message: { role: "assistant", id: "msg_stream", model: "claude-opus-5",
        content: [{ type: "text", text: "x" }], usage: usage(o) } })
  );
  const file = join(dir, "s.jsonl");
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n"));

  const stats = emptyStats();
  await parseClaudeFile(file, stats, {}); // async — an unawaited call finalises an empty stats
  const out = finalize(stats);
  assert.equal(out.total_output_tokens, 434, "output must be the finished value, once");
  assert.equal(out.total_input_tokens, 1, "input must not be multiplied by the write count");
  assert.equal(out.total_cache_read_tokens, 44628, "cache must not be multiplied either");
});

test("a bare null line does not silently truncate the rest of the file", async () => {
  // JSON.parse("null") SUCCEEDS and returns null; the next line reads
  // d.timestamp and throws from inside the stream callback, aborting the file.
  // cli.mjs catches it with a bare `catch {}`, so rows before the bad line are
  // kept and everything after is dropped WITHOUT A WORD. A 9-row transcript with
  // a null on line 2 reported 100 output tokens instead of 900. The likely
  // source is a session file that was being written when the process was killed.
  const home = mkdtempSync(join(tmpdir(), "sf-null-"));
  const dir = join(home, ".claude", "projects", "-w-a");
  mkdirSync(dir, { recursive: true });
  const good = (i) => JSON.stringify({ type: "assistant", cwd: "/w/a",
    timestamp: `2026-07-0${i}T10:00:00.000Z`, uuid: `u${i}`,
    message: { role: "assistant", id: `m${i}`, model: "claude-opus-5",
      content: [{ type: "text", text: "x" }],
      usage: { input_tokens: 1000, output_tokens: 100 } } });
  const nine = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(good);

  for (const [label, lines] of [
    ["no null", nine],
    ["null early", [nine[0], "null", ...nine.slice(1)]],
    ["null late", [...nine.slice(0, 7), "null", ...nine.slice(7)]],
    ["null last", [...nine, "null"]],
  ]) {
    const p = join(dir, "s.jsonl");
    writeFileSync(p, lines.join("\n"));
    const stats = emptyStats();
    // exactly what cli.mjs does around the parse
    let threw = null;
    try { await parseClaudeFile(p, stats, {}); } catch (e) { threw = e; }
    const out = finalize(stats);
    assert.equal(threw, null, `${label}: parsing must not throw`);
    assert.equal(out.total_output_tokens, 900, `${label}: every good row must still count`);
  }
});

test("other bare JSON scalars are ignored, not counted", async () => {
  const home = mkdtempSync(join(tmpdir(), "sf-scalar-"));
  const dir = join(home, ".claude", "projects", "-w-a");
  mkdirSync(dir, { recursive: true });
  const good = JSON.stringify({ type: "assistant", cwd: "/w/a",
    timestamp: "2026-07-01T10:00:00.000Z", uuid: "u1",
    message: { role: "assistant", id: "m1", model: "claude-opus-5",
      content: [{ type: "text", text: "x" }],
      usage: { input_tokens: 1000, output_tokens: 100 } } });
  const p = join(dir, "s.jsonl");
  writeFileSync(p, [good, "true", "42", '"hello"', "[1,2]", "null"].join("\n"));
  const stats = emptyStats();
  await parseClaudeFile(p, stats, {});
  const out = finalize(stats);
  assert.equal(out.total_output_tokens, 100, "only the real row counts");
  assert.equal(out.total_sessions, 1);
});
