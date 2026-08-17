// tests/durability.test.mjs — the guarantee the whole design rests on.
//
// Claude Code deletes transcripts on a timer. starreckon's answer is that the
// snapshot is the record and the ledger holds the session, so the work survives
// its own source. Both halves are tested elsewhere, each against hand-built
// data:
//
//   snapshots.test.mjs  "a re-scan that sees less than the snapshot cannot shrink it"
//   ledger.test.mjs     "deleting a transcript cannot lower the total"
//
// Nothing tested the two TOGETHER, on real files, through the actual scan path
// — and "each half works in isolation" is not the claim being made to a user.
// The claim is: delete the logs and lose nothing. This does that literally.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";

import { emptyStats, parseClaudeFile, finalize } from "../src/scan.mjs";
import { record, lifetime } from "../src/ledger.mjs";

async function withHome(home) {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await import(`../src/snapshots.mjs?t=${Date.now()}${Math.random()}`);
  } finally {
    process.env.HOME = prev;
  }
}

function transcript(dir, sessionId, msgs) {
  mkdirSync(dir, { recursive: true });
  const lines = msgs.map(([id, u], i) => JSON.stringify({
    sessionId,
    uuid: `${sessionId}-u${i}`,
    timestamp: `2026-07-0${(i % 9) + 1}T12:00:00.000Z`,
    type: "assistant",
    message: {
      id, role: "assistant", model: "claude-opus-5",
      usage: {
        input_tokens: u[0], cache_creation_input_tokens: u[1],
        cache_read_input_tokens: u[2], output_tokens: u[3],
      },
    },
  }));
  writeFileSync(join(dir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
}

async function scan(home) {
  const stats = emptyStats();
  const proj = join(home, ".claude", "projects", "-w-alpha");
  if (existsSync(proj)) {
    const { readdirSync } = await import("node:fs");
    for (const f of readdirSync(proj).sort())
      await parseClaudeFile(join(proj, f), stats);
  }
  return { stats, agg: finalize(stats) };
}

test("logs age off and the record survives: snapshot and ledger both hold", async () => {
  const home = mkdtempSync(join(tmpdir(), "durable-"));
  const proj = join(home, ".claude", "projects", "-w-alpha");

  // ---- month one: real work, on disk -------------------------------------
  transcript(proj, "s-alpha", [["m1", [1000, 200, 5000, 300]],
                               ["m2", [2000, 0, 8000, 400]]]);
  transcript(proj, "s-beta", [["m3", [500, 100, 1500, 50]]]);

  const first = await scan(home);
  const snaps = await withHome(home);
  snaps.writeSnapshots(first.agg.monthly_buckets ?? [], {});

  const sessions = [...first.stats.sessions.entries()].map(([id, s]) => ({
    cli: "claude", session_id: id,
    total: s.tok.in + s.tok.out + s.tok.cr + s.tok.cw,
    tokens: {
      input_tokens: s.tok.in, cache_creation_input_tokens: s.tok.cw,
      cache_read_input_tokens: s.tok.cr, output_tokens: s.tok.out,
    },
    start: "2026-07-01", model: "claude-opus-5",
  }));
  record(sessions, "v-test-1", home);

  const beforeLife = lifetime(home);
  const beforeMonths = snaps.loadTimeline();
  assert.ok(beforeLife.total > 0, "the scan recorded something to begin with");
  assert.ok(beforeMonths.length > 0, "a month was snapshotted");

  // ---- retention runs. MOST of the month is gone, not all of it. ---------
  //
  // Deleting EVERY transcript was the first draft and it proved nothing about
  // the snapshot: with no sessions left the rescan produces no monthly bucket,
  // writeSnapshots([]) never touches the stored month, and the merge is never
  // exercised. Replacing mergeMonth with a plain assignment — the exact bug
  // that took one real month from 18,000,000 to 3,600,000 input tokens — left
  // the test passing.
  //
  // Retention deletes by AGE, so the realistic shape is a month that comes back
  // smaller rather than empty. That is the case the floor exists for, and it is
  // the only one that makes the merge run.
  rmSync(join(proj, "s-alpha.jsonl"), { force: true });
  assert.ok(!existsSync(join(proj, "s-alpha.jsonl")), "the older log is deleted");

  const after = await scan(home);
  assert.equal(after.stats.sessions.size, 1,
    "one session survives, so the rescan yields a SMALLER month — not an empty one");

  // ---- rescan, exactly as the daemon would -------------------------------
  const snaps2 = await withHome(home);
  snaps2.writeSnapshots(after.agg.monthly_buckets ?? [], {});
  record([], "v-test-1", home);

  const afterLife = lifetime(home);
  const afterMonths = snaps2.loadTimeline();

  // THE GUARANTEE, STATED TWICE BECAUSE IT IS TWO MECHANISMS.
  assert.equal(afterLife.total, beforeLife.total,
    "lifetime dropped after the transcripts were deleted — the ledger is the "
    + "only thing standing between retention and the number, and it did not hold");

  const sum = (ms) => ms.reduce((a, m) => a + (m.input_tokens ?? 0)
    + (m.output_tokens ?? 0) + (m.cache_tokens ?? 0), 0);
  assert.equal(sum(afterMonths), sum(beforeMonths),
    "the monthly snapshot shrank when its logs aged off — the snapshot is "
    + "supposed to be a floor that does not move");

  rmSync(home, { recursive: true, force: true });
});

// The opposite direction has to keep working, or "does not shrink" would be
// satisfied by a record that never changes at all.
test("new work after a deletion still raises both the snapshot and the ledger", async () => {
  const home = mkdtempSync(join(tmpdir(), "durable-"));
  const proj = join(home, ".claude", "projects", "-w-alpha");

  transcript(proj, "s-one", [["m1", [1000, 0, 0, 100]]]);
  let s = await scan(home);
  let snaps = await withHome(home);
  snaps.writeSnapshots(s.agg.monthly_buckets ?? [], {});
  record([{ cli: "claude", session_id: "s-one", total: 1100,
            tokens: { input_tokens: 1000, cache_creation_input_tokens: 0,
                      cache_read_input_tokens: 0, output_tokens: 100 },
            start: "2026-07-01", model: "m" }], "v-test-1", home);
  const before = lifetime(home).total;

  rmSync(join(proj, "s-one.jsonl"), { force: true });
  transcript(proj, "s-two", [["m9", [4000, 0, 0, 400]]]);

  s = await scan(home);
  snaps = await withHome(home);
  snaps.writeSnapshots(s.agg.monthly_buckets ?? [], {});
  record([{ cli: "claude", session_id: "s-two", total: 4400,
            tokens: { input_tokens: 4000, cache_creation_input_tokens: 0,
                      cache_read_input_tokens: 0, output_tokens: 400 },
            start: "2026-07-01", model: "m" }], "v-test-1", home);

  assert.ok(lifetime(home).total > before,
    "a record that cannot grow is not a floor, it is a fossil");
  rmSync(home, { recursive: true, force: true });
});
