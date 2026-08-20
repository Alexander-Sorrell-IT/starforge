// @ts-nocheck
// The per-session export: one record per session, and the four counters kept
// apart inside it.
//
// WHY THIS FILE EXISTS. finalize() sums stats.sessions and drops the Map, so
// every number that ever left this process was a grand total — and a grand
// total is exactly the shape of check that five sum-preserving corruptions have
// already walked straight through. Swap two sessions' tokens, move one
// session's tokens into its neighbour, move input into output: the headline
// figure is unchanged in all three, and a differential against another counter
// built on headline figures says PASS.
//
// So the failures pinned here are the ones that would make the export useless
// for the differential it exists to feed:
//
//   1. a session DROPPED — fewer records than sessions, tokens quietly missing
//      from the file while the headline total still reconciles from `stats`
//   2. a session DOUBLE-COUNTED — the same id emitted twice, which would show
//      the sibling counter a phantom session and a doubled total
//   3. two files sharing one session id (a sub-agent transcript carries its
//      PARENT's id) split into two records — the same double-count wearing the
//      shape of a real corpus
//   4. the per-field sums drifting from finalize()'s totals, i.e. the export
//      and the headline disagreeing about the same scan
//   5. a path-derived session id written out RAW, which would put the home
//      directory and the username into a new file while every other file this
//      program writes has them masked
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  emptyStats,
  parseClaudeFile,
  parseCodexFile,
  finalize,
  sessionRecords,
} from "../src/scan.mjs";
import { projectPseudonym } from "../src/redact.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "sr-sess-"));

const usage = (n) => ({
  input_tokens: n,
  cache_creation_input_tokens: n * 2,
  cache_read_input_tokens: n * 3,
  output_tokens: n * 4,
});

// One assistant row. `mid` is the message id creditUsage dedupes on, so two
// rows written with the same mid are the same API call, not two.
const row = (sid, mid, n, ts, cwd = "/home/somebody/work/repo") =>
  JSON.stringify({
    type: "assistant",
    sessionId: sid,
    timestamp: ts,
    cwd,
    message: { id: mid, model: "claude-opus-4", usage: usage(n) },
  });

function writeTranscript(dir, projectDir, file, lines) {
  const proj = join(dir, "projects", projectDir);
  mkdirSync(proj, { recursive: true });
  const p = join(proj, file);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

// ---- 1 + 2: every session, exactly once ------------------------------------

test("one record per session — no session dropped, none emitted twice", async () => {
  const dir = tmp();
  const a = writeTranscript(dir, "-work-alpha", "s.jsonl", [
    row("sess-a", "m1", 1, "2026-03-01T10:00:00Z"),
    row("sess-a", "m2", 2, "2026-03-01T10:05:00Z"),
  ]);
  const b = writeTranscript(dir, "-work-beta", "s.jsonl", [
    row("sess-b", "m3", 5, "2026-03-02T11:00:00Z"),
  ]);
  const c = writeTranscript(dir, "-work-gamma", "s.jsonl", [
    row("sess-c", "m4", 7, "2026-03-03T12:00:00Z"),
  ]);

  const stats = emptyStats();
  for (const p of [a, b, c]) await parseClaudeFile(p, stats, {});

  const recs = sessionRecords(stats);
  // The invariant the whole file turns on: the export is 1:1 with the Map the
  // counting path built. A record count that merely "looks about right" is what
  // let a dropped session hide behind a reconciling grand total.
  assert.equal(recs.length, stats.sessions.size, "one record per session");
  assert.equal(recs.length, 3);
  const ids = recs.map((r) => r.session_id);
  assert.deepEqual([...ids].sort(), ["sess-a", "sess-b", "sess-c"]);
  assert.equal(new Set(ids).size, ids.length, "no id emitted twice");
});

test("re-reading the same transcript adds no session and no tokens", async () => {
  // A file listed twice by the walk (a symlink, a second root) must not become
  // a second session or a second helping of tokens.
  const dir = tmp();
  const p = writeTranscript(dir, "-work-alpha", "s.jsonl", [
    row("sess-a", "m1", 10, "2026-03-01T10:00:00Z"),
  ]);
  const once = emptyStats();
  await parseClaudeFile(p, once, {});
  const twice = emptyStats();
  await parseClaudeFile(p, twice, {});
  await parseClaudeFile(p, twice, {});

  assert.deepEqual(sessionRecords(twice), sessionRecords(once));
  assert.equal(sessionRecords(twice).length, 1);
});

// ---- 3: two files, one session ---------------------------------------------

test("a session spanning two transcripts is ONE record carrying both files' tokens", async () => {
  // The real shape: a sub-agent transcript lives in its own directory and
  // carries its PARENT's sessionId. Splitting it into two records would double
  // the session count the sibling counter is joined against.
  const dir = tmp();
  const parent = writeTranscript(dir, "-work-alpha", "s.jsonl", [
    row("shared-id", "m1", 1, "2026-03-01T10:00:00Z"),
  ]);
  const child = writeTranscript(dir, "-work-alpha-sub", "agent.jsonl", [
    row("shared-id", "m2", 3, "2026-03-01T10:30:00Z"),
  ]);

  const stats = emptyStats();
  for (const p of [parent, child]) await parseClaudeFile(p, stats, {});
  const recs = sessionRecords(stats);

  assert.equal(recs.length, 1, "one id is one session, however many files it spans");
  assert.deepEqual(recs[0].tokens, {
    input_tokens: 4,                  // 1 + 3
    cache_creation_input_tokens: 8,   // 2 + 6
    cache_read_input_tokens: 12,      // 3 + 9
    output_tokens: 16,                // 4 + 12
  });
  assert.equal(recs[0].start, "2026-03-01T10:00:00.000Z");
  assert.equal(recs[0].end, "2026-03-01T10:30:00.000Z");
});

// ---- 4: the export and the headline describe the same scan -----------------

test("per-field sums equal finalize()'s totals, field by field", async () => {
  const dir = tmp();
  const files = [
    writeTranscript(dir, "-work-alpha", "s.jsonl", [
      row("sess-a", "m1", 1, "2026-03-01T10:00:00Z"),
      row("sess-a", "m1", 1, "2026-03-01T10:00:01Z"), // duplicate write, not a second call
      row("sess-a", "m2", 9, "2026-03-01T10:05:00Z"),
    ]),
    writeTranscript(dir, "-work-beta", "s.jsonl", [
      row("sess-b", "m3", 5, "2026-03-02T11:00:00Z"),
    ]),
    writeTranscript(dir, "-work-gamma", "s.jsonl", [
      row("sess-c", "m4", 7, "2026-03-03T12:00:00Z"),
    ]),
  ];
  const stats = emptyStats();
  for (const p of files) await parseClaudeFile(p, stats, {});

  const agg = finalize(stats);
  const recs = sessionRecords(stats);
  const sum = (k) => recs.reduce((t, r) => t + r.tokens[k], 0);

  // Per FIELD, not on the total: a total reconciles just as happily when input
  // has been credited as output, which is the corruption a token counter is
  // most likely to actually have.
  assert.equal(sum("input_tokens"), agg.total_input_tokens);
  assert.equal(sum("output_tokens"), agg.total_output_tokens);
  assert.equal(sum("cache_read_input_tokens"), agg.total_cache_read_tokens);
  assert.equal(sum("cache_creation_input_tokens"), agg.total_cache_write_tokens);
  assert.equal(recs.length, agg.total_sessions);
  assert.ok(agg.total_input_tokens > 0, "the fixture must actually carry tokens");
  for (const r of recs)
    assert.equal(
      r.total,
      r.tokens.input_tokens + r.tokens.cache_creation_input_tokens
        + r.tokens.cache_read_input_tokens + r.tokens.output_tokens,
      `${r.session_id}: total disagrees with its own fields`
    );
});

// ---- 5: what the file is allowed to contain --------------------------------

test("a row-declared id is the join key, verbatim", async () => {
  const dir = tmp();
  const p = writeTranscript(dir, "-work-alpha", "s.jsonl", [
    row("2b4f9c1e-0000-4a00-8000-000000000001", "m1", 1, "2026-03-01T10:00:00Z"),
  ]);
  const stats = emptyStats();
  await parseClaudeFile(p, stats, {});
  const [rec] = sessionRecords(stats);
  assert.equal(rec.session_id, "2b4f9c1e-0000-4a00-8000-000000000001");
  assert.equal(rec.id_source, "row");
});

test("a path-derived id is masked, and pseudonymised under --no-projects", async () => {
  // No row carries a sessionId, so the id falls back to <parent-dir>/<stem> —
  // and a Claude project directory name is a working-directory path with the
  // slashes rewritten to dashes, so it carries the username.
  const user = userInfo().username;
  const dir = tmp();
  const encoded = `-home-${user}-clients-acme`;
  const p = writeTranscript(dir, encoded, "journal.jsonl", [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-03-01T10:00:00Z",
      message: { id: "m1", model: "claude-opus-4", usage: usage(1) },
    }),
  ]);
  const stats = emptyStats();
  await parseClaudeFile(p, stats, {});

  const [rec] = sessionRecords(stats);
  assert.equal(rec.id_source, "path", "this id was invented from a path, and must say so");
  if (user.length >= 4)
    assert.ok(
      !rec.session_id.includes(user),
      `the username survived into the export: ${rec.session_id}`
    );

  // --no-projects is a privacy flag, and a privacy flag that fails OPEN is
  // worse than none: masking the username still leaves "clients-acme" readable.
  const rawId = [...stats.sessions.keys()][0];
  const [masked] = sessionRecords(stats, { noProjects: true });
  assert.equal(masked.session_id, projectPseudonym(rawId));
  assert.ok(!masked.session_id.includes("acme"));
});

test("each record names the store it came from", async () => {
  const dir = tmp();
  const p = writeTranscript(dir, "-work-alpha", "s.jsonl", [
    row("sess-a", "m1", 1, "2026-03-01T10:00:00Z"),
  ]);
  const stats = emptyStats();
  await parseClaudeFile(p, stats, { cli: "claude" });
  assert.equal(sessionRecords(stats)[0].cli, "claude");

  const cowork = emptyStats();
  await parseClaudeFile(p, cowork, { cli: "cowork" });
  assert.equal(
    sessionRecords(cowork)[0].cli,
    "cowork",
    "Cowork is parsed by the Claude reader and is still a different tool"
  );
});

test("codex sessions export alongside claude ones, on the same identity", async () => {
  const dir = tmp();
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "rollout-2026-03-01.jsonl");
  writeFileSync(
    p,
    [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-03-01T10:00:00Z",
        payload: { id: "codex-abc", model: "gpt-5", cwd: "/home/somebody/work/repo" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-03-01T10:01:00Z",
        payload: {
          info: {
            total_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 6 },
            last_token_usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 6 },
          },
        },
      }),
    ].join("\n") + "\n"
  );
  const stats = emptyStats();
  await parseCodexFile(p, stats, { cli: "codex" });
  const [rec] = sessionRecords(stats);
  assert.equal(rec.session_id, "codex-abc");
  assert.equal(rec.id_source, "row");
  assert.equal(rec.cli, "codex");
  const agg = finalize(stats);
  assert.equal(rec.tokens.input_tokens, agg.total_input_tokens);
  assert.equal(rec.tokens.output_tokens, agg.total_output_tokens);
});

test("the record order is a function of the records, not of the walk order", async () => {
  // Two machines holding the same corpus must produce the same bytes; Map order
  // is insertion order, which is directory order one layer up.
  const dir = tmp();
  const a = writeTranscript(dir, "-work-alpha", "s.jsonl", [
    row("sess-a", "m1", 1, "2026-03-01T10:00:00Z"),
  ]);
  const b = writeTranscript(dir, "-work-beta", "s.jsonl", [
    row("sess-b", "m2", 1, "2026-03-02T10:00:00Z"),
  ]);
  const fwd = emptyStats();
  for (const p of [a, b]) await parseClaudeFile(p, fwd, {});
  const rev = emptyStats();
  for (const p of [b, a]) await parseClaudeFile(p, rev, {});
  assert.deepEqual(sessionRecords(fwd), sessionRecords(rev));
});
