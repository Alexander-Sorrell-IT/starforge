// Tests for src/accounts.mjs — per-account attribution and the FLOOR metric.
// All fixtures live in a temp dir; nothing depends on machine-specific data.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverAccounts,
  floorTotals,
  findConfigDirs,
  accountFor,
  readStatsCache,
} from "../src/accounts.mjs";
import { maskPath } from "../src/redact.mjs";

function tok(input = 0, output = 0, cacheRead = 0, cacheWrite = 0) {
  return { input, output, cacheRead, cacheWrite };
}

function usageLine(uuid, day, u) {
  const rec = {
    ...(uuid ? { uuid } : {}),
    timestamp: `${day}T10:00:00.000Z`,
    message: { model: "claude-opus-4", usage: u },
  };
  return JSON.stringify(rec);
}

function writeJsonl(path, lines) {
  writeFileSync(path, lines.join("\n") + "\n");
}

// Build the full fixture home described inline below. Returns its path.
function buildFixtureHome() {
  const home = mkdtempSync(join(tmpdir(), "starforge-accounts-"));

  // --- account A: dir named ".claude" — identity via the HOME quirk file.
  mkdirSync(join(home, ".claude", "projects", "p1", "s1", "subagents"), {
    recursive: true,
  });
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      oauthAccount: { emailAddress: "a@example.com" },
      userID: "aaaabbbbccccddddeeee",
    })
  );
  // Main transcript: dup uuid, no-uuid record, non-integer fields, iterations
  // (must never be summed), truncated final line.
  writeFileSync(
    join(home, ".claude", "projects", "p1", "s1.jsonl"),
    [
      usageLine("u1", "2026-01-05", {
        input_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 100,
        output_tokens: 50,
        iterations: [{ input_tokens: 999999 }],
      }),
      usageLine("u2", "2026-01-15", {
        input_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 100,
        output_tokens: 50,
      }),
      usageLine("u1", "2026-01-05", {
        // duplicate uuid: whole record skipped
        input_tokens: 100,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 100,
        output_tokens: 50,
      }),
      usageLine(null, "2026-01-15", { input_tokens: 5, output_tokens: 5 }),
      usageLine("u3", "2026-01-15", {
        input_tokens: null,
        output_tokens: "9",
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 1.5,
      }),
      'not json at all',
      '{"uuid":"u4","message":{"usage":{"input_tokens":999', // truncated live line
    ].join("\n")
  );
  // Subagent transcript: separate billed conversation, counts in totals but
  // not as a session.
  writeJsonl(join(home, ".claude", "projects", "p1", "s1", "subagents", "agent-1.jsonl"), [
    usageLine("u5", "2026-01-15", { input_tokens: 10, output_tokens: 10 }),
  ]);
  // Frozen counter for account A.
  writeFileSync(
    join(home, ".claude", "stats-cache.json"),
    JSON.stringify({
      modelUsage: {
        "claude-opus-4": {
          inputTokens: 400,
          outputTokens: 100,
          cacheReadInputTokens: 400,
          cacheCreationInputTokens: 100,
          costUSD: 5.0,
          contextWindow: 200000,
        },
      },
      dailyModelTokens: { "2026-01-05": { "claude-opus-4": 12 } }, // trap: never summed
      lastComputedDate: "2026-01-10",
      firstSessionDate: "2025-12-01T00:00:00Z",
      totalSessions: 3,
      totalMessages: 40,
    })
  );

  // --- copy of A's profile on the Desktop, dir also named ".claude":
  // found by the WALK (not the glob), resolves to account A via the quirk,
  // contributes ZERO tokens (global uuid dedup) but its file still counts as
  // a session file.
  mkdirSync(join(home, "Desktop", "stash", ".claude", "projects", "p1"), {
    recursive: true,
  });
  writeJsonl(join(home, "Desktop", "stash", ".claude", "projects", "p1", "s1.jsonl"), [
    usageLine("u1", "2026-01-05", {
      input_tokens: 100,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 100,
      output_tokens: 50,
    }),
    usageLine("u2", "2026-01-15", {
      input_tokens: 50,
      cache_read_input_tokens: 100,
      output_tokens: 50,
    }),
  ]);

  // --- account B: TWO profiles sharing one login, counter in b1 only.
  // The counter must be applied exactly once for the account.
  for (const name of [".claude-b1", ".claude-b2"]) {
    mkdirSync(join(home, name, "projects", "pb"), { recursive: true });
    writeFileSync(
      join(home, name, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "b@example.com" } })
    );
  }
  writeJsonl(join(home, ".claude-b1", "projects", "pb", "sb1.jsonl"), [
    usageLine("v1", "2026-01-20", { input_tokens: 100 }),
  ]);
  writeJsonl(join(home, ".claude-b2", "projects", "pb", "sb2.jsonl"), [
    usageLine("v2", "2026-01-20", { input_tokens: 50 }),
  ]);
  writeFileSync(
    join(home, ".claude-b1", "stats-cache.json"),
    JSON.stringify({
      modelUsage: {
        "claude-sonnet-4": { inputTokens: 4000, outputTokens: 1000 },
      },
      lastComputedDate: "2026-01-10",
      firstSessionDate: "2025-11-01",
    })
  );

  // --- account C: counter SMALLER than what is on disk (all transcript days
  // before lastComputedDate) — floor must clamp to the measured figure.
  mkdirSync(join(home, ".claude-c", "projects", "pc"), { recursive: true });
  writeFileSync(
    join(home, ".claude-c", ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "c@example.com" } })
  );
  writeJsonl(join(home, ".claude-c", "projects", "pc", "sc.jsonl"), [
    usageLine("w1", "2025-12-30", { input_tokens: 500 }),
  ]);
  writeFileSync(
    join(home, ".claude-c", "stats-cache.json"),
    JSON.stringify({
      modelUsage: { "claude-opus-4": { inputTokens: 10 } },
      lastComputedDate: "2026-01-01",
    })
  );

  // --- tier-2 (API-key) profile: userID only.
  mkdirSync(join(home, ".claude-api", "projects", "pa"), { recursive: true });
  writeFileSync(
    join(home, ".claude-api", ".claude.json"),
    JSON.stringify({ userID: "0123456789abcdef0123" })
  );
  writeJsonl(join(home, ".claude-api", "projects", "pa", "sa.jsonl"), [
    usageLine("y1", "2026-02-01", { output_tokens: 5 }),
  ]);

  // --- tier-3 unknown profile: no config at all.
  mkdirSync(join(home, ".claude-x", "projects", "px"), { recursive: true });
  writeJsonl(join(home, ".claude-x", "projects", "px", "sx.jsonl"), [
    usageLine("x1", "2026-02-01", { input_tokens: 5 }),
  ]);

  // --- glob-matching dirs that are NOT profiles (shape test must reject).
  mkdirSync(join(home, ".claude_app"), { recursive: true }); // no projects/
  mkdirSync(join(home, ".claude-empty", "projects"), { recursive: true }); // no jsonl

  // --- symlink to a real profile: walk must skip it (no double count).
  try {
    symlinkSync(join(home, ".claude-b1"), join(home, "Desktop", "linkprof"));
  } catch {
    // symlinks unavailable: fine, dedup-by-realpath covers it anyway
  }

  return home;
}

// Expected on-disk per profile (see fixture construction above):
//   A .claude:            in 165, out 115, cr 207, cw 50, sessions 1
//   A Desktop copy:       all zero, sessions 1
//   B b1: in 100 s1 | B b2: in 50 s1 | C: in 500 s1 | api: out 5 s1 | x: in 5 s1
// Floors:
//   A: counter {400,100,400,100} + after(2026-01-15) {65,65,107,0} = {465,165,507,100}
//   B: counter {4000,1000,0,0} + after(2026-01-20) {150,0,0,0} = {4150,1000,0,0}, once
//   C: concat grand 10 < measured 500 -> clamped to measured {500,0,0,0}
//   api / unknown: no counter -> null

test("discoverAccounts: full fixture end to end", async (t) => {
  const home = buildFixtureHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const rows = await discoverAccounts({ home });
  const byDir = new Map(rows.map((r) => [r.configDir, r]));

  // Discovery: 7 profiles; rejects .claude_app / .claude-empty; live glob'd
  // profiles come before the walked Desktop copy.
  assert.equal(rows.length, 7);
  const dirs = rows.map((r) => r.configDir);
  assert.ok(dirs.indexOf(maskPath(join(home, ".claude"))) <
    dirs.indexOf(maskPath(join(home, "Desktop", "stash", ".claude"))));
  assert.ok(!dirs.some((d) => d.includes(".claude_app")));
  assert.ok(!dirs.some((d) => d.includes(".claude-empty")));
  assert.ok(!dirs.some((d) => d.includes("linkprof")));

  // Account A live profile: quirk identity + counting edge cases.
  const a = byDir.get(maskPath(join(home, ".claude")));
  assert.equal(a.account, "a@example.com");
  assert.deepEqual(a.onDisk, { ...tok(165, 115, 207, 50), sessions: 1 });
  assert.deepEqual(a.floor, tok(465, 165, 507, 100));

  // Desktop copy: same account via the ".claude"-name quirk, zero tokens
  // (global dedup), no second claim of the counter.
  const copy = byDir.get(maskPath(join(home, "Desktop", "stash", ".claude")));
  assert.equal(copy.account, "a@example.com");
  assert.deepEqual(copy.onDisk, { ...tok(0, 0, 0, 0), sessions: 1 });
  assert.equal(copy.floor, null);

  // Account B: counter applied exactly once across two profiles.
  const b1 = byDir.get(maskPath(join(home, ".claude-b1")));
  const b2 = byDir.get(maskPath(join(home, ".claude-b2")));
  assert.equal(b1.account, "b@example.com");
  assert.equal(b2.account, "b@example.com");
  assert.deepEqual(b1.onDisk, { ...tok(100, 0, 0, 0), sessions: 1 });
  assert.deepEqual(b2.onDisk, { ...tok(50, 0, 0, 0), sessions: 1 });
  assert.deepEqual(b1.floor, tok(4150, 1000, 0, 0));
  assert.equal(b2.floor, null);

  // Account C: floor clamped up to the measured on-disk figure.
  const c = byDir.get(maskPath(join(home, ".claude-c")));
  assert.deepEqual(c.floor, tok(500, 0, 0, 0));

  // Tier 2 and tier 3 identities; no counter -> floor null.
  const api = byDir.get(maskPath(join(home, ".claude-api")));
  assert.equal(api.account, "user:0123456789ab");
  assert.deepEqual(api.onDisk, { ...tok(0, 5, 0, 0), sessions: 1 });
  assert.equal(api.floor, null);
  const x = byDir.get(maskPath(join(home, ".claude-x")));
  assert.equal(x.account, "unknown (.claude-x)");
  assert.deepEqual(x.onDisk, { ...tok(5, 0, 0, 0), sessions: 1 });
  assert.equal(x.floor, null);

  // Fleet rollup: floor uses each account once; counter-less accounts fall
  // back to their measured totals.
  const fleet = floorTotals(rows);
  assert.deepEqual(fleet.onDisk, { ...tok(820, 120, 207, 50), sessions: 7 });
  assert.deepEqual(fleet.floor, tok(5120, 1170, 507, 100));
});

test("CLAUDE_CONFIG_DIR is ignored when scanning an overridden home", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "starforge-accounts-env-"));
  const other = mkdtempSync(join(tmpdir(), "starforge-accounts-envdir-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
    delete process.env.CLAUDE_CONFIG_DIR;
  });
  // a real profile living at $CLAUDE_CONFIG_DIR
  mkdirSync(join(other, "prof", "projects", "p"), { recursive: true });
  writeJsonl(join(other, "prof", "projects", "p", "s.jsonl"), [
    usageLine("e1", "2026-01-01", { input_tokens: 1 }),
  ]);
  process.env.CLAUDE_CONFIG_DIR = join(other, "prof");

  const dirs = findConfigDirs(home);
  assert.deepEqual(dirs, []); // env must not leak into a test scan
  const rows = await discoverAccounts({ home });
  assert.deepEqual(rows, []);
});

test("empty or absent home yields empty results, never throws", async () => {
  const home = mkdtempSync(join(tmpdir(), "starforge-accounts-empty-"));
  try {
    assert.deepEqual(await discoverAccounts({ home }), []);
    assert.deepEqual(readStatsCache(home), []);
    assert.deepEqual(
      floorTotals([]),
      {
        onDisk: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: 0 },
        floor: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }
    );
    // A home path that does not exist at all.
    const gone = join(home, "does-not-exist");
    assert.deepEqual(await discoverAccounts({ home: gone }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("accountFor tiers and the ~/.claude quirk", () => {
  const home = mkdtempSync(join(tmpdir(), "starforge-accounts-acct-"));
  try {
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(home, ".claude-o"), { recursive: true });
    // quirk: .claude reads HOME/.claude.json
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "q@example.com" } })
    );
    assert.equal(accountFor(join(home, ".claude"), home), "q@example.com");
    // other dirs read their own .claude.json
    writeFileSync(
      join(home, ".claude-o", ".claude.json"),
      JSON.stringify({ userID: "ffffeeeeddddcccc" })
    );
    assert.equal(accountFor(join(home, ".claude-o"), home), "user:ffffeeeedddd");
    // unreadable/missing config
    assert.equal(
      accountFor(join(home, ".claude-nope"), home),
      "unknown (.claude-nope)"
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("readStatsCache sums only the four billed counters", () => {
  const home = mkdtempSync(join(tmpdir(), "starforge-accounts-sc-"));
  try {
    mkdirSync(join(home, ".claude-sc"), { recursive: true });
    writeFileSync(
      join(home, ".claude-sc", "stats-cache.json"),
      JSON.stringify({
        modelUsage: {
          m1: {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 4,
            costUSD: 99,
            webSearchRequests: 7,
          },
          m2: { inputTokens: 10 },
        },
        dailyModelTokens: { "2026-01-01": { m1: 123456 } },
        lastComputedDate: "2026-01-31",
        firstSessionDate: "2025-06-01T12:00:00Z",
      })
    );
    const entries = readStatsCache(home);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].total, 20); // 1+2+3+4+10, never costUSD/daily
    assert.deepEqual(entries[0].tok, tok(11, 2, 3, 4));
    assert.equal(entries[0].lastComputed, "2026-01-31");
    assert.equal(entries[0].firstSession, "2025-06-01");
    assert.equal(entries[0].account, "unknown (.claude-sc)");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
