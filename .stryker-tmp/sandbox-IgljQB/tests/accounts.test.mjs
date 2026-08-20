// @ts-nocheck
// Tests for src/accounts.mjs — per-account attribution and the FLOOR metric.
// All fixtures live in a temp dir; nothing depends on machine-specific data.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync,
         existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverAccounts,
  floorTotals,
  findConfigDirs,
  accountFor,
  readStatsCache,
  displayAccount,
} from "../src/accounts.mjs";
import { maskPath, accountPseudonym, findEmail } from "../src/redact.mjs";

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
  const home = mkdtempSync(join(tmpdir(), "starreckon-accounts-"));

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
  //
  // IT CARRIES A CONFIG NOW, and that is the point of the change rather than a
  // convenience. A profile found deep in the tree with NO config beside it is a
  // copy somebody made, and counting those published 489,464,459 tokens under
  // invented accounts on the author's real machine — excluded by ruling on
  // 2026-08-10. This fixture's Desktop profile exists to prove DISCOVERY ORDER
  // (glob'd before walked), which is still worth proving, so it is given the
  // config that makes it a legitimately nested profile. The config-less case
  // gets its own fixture below, where it belongs.
  mkdirSync(join(home, "Desktop", "stash", ".claude", "projects", "p1"), {
    recursive: true,
  });
  writeFileSync(
    join(home, "Desktop", "stash", ".claude", ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "a@example.com" } })
  );

  // --- a profile-shaped copy with NO config, deep in the tree. It must be
  // found by shape and then REFUSED, because nothing about it says whose it is.
  mkdirSync(join(home, "Desktop", "unclaimed_copy", ".claude", "projects", "p1"), {
    recursive: true,
  });
  writeJsonl(
    join(home, "Desktop", "unclaimed_copy", ".claude", "projects", "p1", "s9.jsonl"),
    [usageLine("u-unclaimed", "2026-01-09", {
      input_tokens: 777, cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0, output_tokens: 7,
    })]
  );
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

  // THE RULING, ASSERTED. A profile-shaped directory found deep in the tree
  // with no config beside it is a copy, not a profile, and it is refused —
  // 489,464,459 tokens on the author's machine were published under invented
  // accounts before this rule existed. Excluded, never re-attributed: giving
  // that data a real account would be worse than the bug, because invented
  // numbers would then look owned.
  assert.ok(!dirs.some((d) => d.includes("unclaimed_copy")),
    "a deep, config-less profile-shaped copy must not be counted");

  // Account A live profile: quirk identity + counting edge cases.
  // The identity that leaves the module is the PSEUDONYM, not the address —
  // rows are what cli.mjs writes into expanded-*.json and the stats page.
  const a = byDir.get(maskPath(join(home, ".claude")));
  assert.equal(a.account, accountPseudonym("a@example.com"));
  // out 124, NOT 115: the fixture's `output_tokens: "9"` is COUNTED now.
  //
  // This file asserted a numeric string was skipped while
  // tests/hardening.test.mjs asserted `"500"` coerces to 500 — two tests, two
  // opposite rules, both green because accounts.mjs and scan.mjs each had their
  // own token guard. Folding accounts.mjs onto creditUsage (which is what
  // removed a 2.71x inflation from every per-account and ledger figure) forced
  // the choice, and it went to coercion: a serialiser writing "9" is a real
  // thing and dropping it loses nine tokens with nobody told. `1.5` is still
  // refused — one and a half tokens is not a count — which is why cacheWrite
  // stays 50 and does not become 51.5.
  assert.deepEqual(a.onDisk, { ...tok(165, 124, 207, 50), sessions: 1 });
  assert.deepEqual(a.floor, tok(465, 174, 507, 100));

  // Desktop copy: same account via the ".claude"-name quirk, zero tokens
  // (global dedup), no second claim of the counter.
  const copy = byDir.get(maskPath(join(home, "Desktop", "stash", ".claude")));
  assert.equal(copy.account, accountPseudonym("a@example.com"));
  // sessions 0, not 1. A COPY OF A SESSION IS THE SAME SESSION.
  //
  // This asserted that a copied profile's file "still counts as a session file"
  // even while contributing zero tokens — counting the path rather than the
  // work. That is the assumption the archive-mirror defect rested on: on the
  // real machine ~/.ai-logs-archive holds a hard-link mirror of every profile,
  // and 132 sessions were published as 384 because each mirror file was counted
  // again. Sessions are keyed by their own id now, machine-wide, so whichever
  // copy is read first counts and the rest are the same session.
  assert.deepEqual(copy.onDisk, { ...tok(0, 0, 0, 0), sessions: 0 });
  assert.equal(copy.floor, null);

  // Account B: counter applied exactly once across two profiles.
  const b1 = byDir.get(maskPath(join(home, ".claude-b1")));
  const b2 = byDir.get(maskPath(join(home, ".claude-b2")));
  assert.equal(b1.account, accountPseudonym("b@example.com"));
  assert.equal(b2.account, accountPseudonym("b@example.com"));
  // grouping still works: one account, one label, across two profiles
  assert.notEqual(b1.account, a.account);
  assert.deepEqual(b1.onDisk, { ...tok(100, 0, 0, 0), sessions: 1 });
  assert.deepEqual(b2.onDisk, { ...tok(50, 0, 0, 0), sessions: 1 });
  assert.deepEqual(b1.floor, tok(4150, 1000, 0, 0));
  assert.equal(b2.floor, null);

  // Account C: floor clamped up to the measured on-disk figure.
  const c = byDir.get(maskPath(join(home, ".claude-c")));
  assert.deepEqual(c.floor, tok(500, 0, 0, 0));

  // Tier 2 and tier 3 identities; no counter -> floor null.
  const api = byDir.get(maskPath(join(home, ".claude-api")));
  assert.equal(api.account, accountPseudonym("user:0123456789ab"));
  assert.deepEqual(api.onDisk, { ...tok(0, 5, 0, 0), sessions: 1 });
  assert.equal(api.floor, null);
  const x = byDir.get(maskPath(join(home, ".claude-x")));
  assert.equal(x.account, "unknown (.claude-x)");
  assert.deepEqual(x.onDisk, { ...tok(5, 0, 0, 0), sessions: 1 });
  assert.equal(x.floor, null);

  // Fleet rollup: floor uses each account once; counter-less accounts fall
  // back to their measured totals.
  const fleet = floorTotals(rows);
  // out 129, not 120 — the same `output_tokens: "9"` as above, seen once in the
  // fleet roll-up. See the note on a.onDisk for why a numeric string counts.
  // 6, not 7 — the Desktop copy's session is the same session as the original.
  // See the note on copy.onDisk above.
  assert.deepEqual(fleet.onDisk, { ...tok(820, 129, 207, 50), sessions: 6 });
  // +9, the same numeric-string output as above, reaching the fleet floor.
  assert.deepEqual(fleet.floor, tok(5120, 1179, 507, 100));
});

// ---- identity policy (red-team HIGH: raw OAuth email in shareable output) ---
// The identity is an OAuth EMAIL ADDRESS. Every structure discoverAccounts
// hands back is written to a file by cli.mjs (expanded-*.json, the stats page,
// a --join-fleet folder), so none of them may carry an address by default.
// The ONE exception is `identities`, which is terminal-only by contract.
test("identity policy: no address in anything a caller writes; raw only via --show-accounts", async (t) => {
  const home = buildFixtureHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const res = await discoverAccounts({ home, fleet: true });

  // Every payload cli.mjs writes: not one email address anywhere in the tree.
  for (const [what, blob] of [
    ["rows", res.rows],
    ["fleetAccounts", res.fleetAccounts],
    ["fleetSessions", res.fleetSessions],
    ["fleetStatsCache", res.fleetStatsCache],
  ]) {
    const json = JSON.stringify(blob);
    const hit = findEmail(json);
    assert.equal(hit, null, `${what} leaked an address: ${hit?.value}`);
    assert.ok(json.includes("acct-"), `${what} should carry acct-<hash> labels`);
  }

  // ...and the pseudonyms are the SAME label across every payload, or the
  // per-account totals a reader joins on would silently split.
  const aLabel = accountPseudonym("a@example.com");
  assert.ok(res.fleetAccounts.some((r) => r.account === aLabel));
  assert.ok(res.fleetSessions.some((r) => r.account === aLabel));

  // The raw addresses survive in memory for the terminal table only.
  const ids = new Map(res.identities.map((x) => [x.account, x.identity]));
  assert.equal(ids.get(aLabel), "a@example.com");
  assert.equal(res.showAccounts, false);

  // Opt in and the raw addresses come back — the flag is not decorative.
  const raw = await discoverAccounts({ home, fleet: true, showAccounts: true });
  assert.ok(raw.rows.some((r) => r.account === "a@example.com"));
  assert.ok(JSON.stringify(raw.fleetSessions).includes("b@example.com"));
  assert.equal(raw.showAccounts, true);
});

test("displayAccount pseudonymises the two identifying tiers and only those", () => {
  // tier 1: OAuth email — the user's real-world name
  assert.equal(displayAccount("a@example.com"), accountPseudonym("a@example.com"));
  // tier 2: userID — an account handle, still an identifier
  assert.equal(displayAccount("user:0123456789ab"), accountPseudonym("user:0123456789ab"));
  // tier 3: no identity at all, just the profile dir name — nothing to hide,
  // and hashing it would make the row unreadable for no privacy gain.
  assert.equal(displayAccount("unknown (.claude-x)"), "unknown (.claude-x)");
  // opt-in returns every tier verbatim
  assert.equal(displayAccount("a@example.com", true), "a@example.com");
  assert.equal(displayAccount("user:0123456789ab", true), "user:0123456789ab");
  // two addresses an "a***@gmail.com" style mask would MERGE stay distinct
  assert.notEqual(
    displayAccount("alice@gmail.com"),
    displayAccount("adam@gmail.com")
  );
});

test("CLAUDE_CONFIG_DIR is ignored when scanning an overridden home", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "starreckon-accounts-env-"));
  const other = mkdtempSync(join(tmpdir(), "starreckon-accounts-envdir-"));
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
  const home = mkdtempSync(join(tmpdir(), "starreckon-accounts-empty-"));
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
  const home = mkdtempSync(join(tmpdir(), "starreckon-accounts-acct-"));
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
  const home = mkdtempSync(join(tmpdir(), "starreckon-accounts-sc-"));
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

// ── the streaming rewrite: one message, many rows ───────────────────────────
//
// THE SUITE COULD NOT FAIL ON THIS. accounts.mjs deduped on the row `uuid` and
// SUMMED, while scan.mjs and deadreckon dedup on `message.id` keeping a running
// maximum. A streaming write emits a NEW uuid per chunk and keeps the SAME
// message.id, so the uuid set removed almost nothing and every partial write of
// one assistant message was counted again.
//
// Measured on one profile copied to a scratch home — no .claude.json, no
// deleted sessions, floor 0, so nothing lifetime about it:
//     accounts.mjs  1,409,787,623     scan.mjs / deadreckon  520,497,793
// 2.71x, on every per-account figure, the ledger, --join-fleet and the machine
// floor. The fixture above has no repeated message.id at all, so reverting the
// fix left it green — which is why this case exists separately.
test("a streaming rewrite is one message, not four", async () => {
  const home = mkdtempSync(join(tmpdir(), "starreckon-stream-"));
  const proj = join(home, ".claude", "projects", "p1");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(home, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "s@example.com" } }));

  // One assistant message, written four times as it streamed. Each chunk is a
  // new row with its own uuid; the id and the growing counters are the message.
  const rows = [10, 25, 40, 40].map((n, i) => JSON.stringify({
    uuid: `chunk-${i}`, sessionId: "sess-1", timestamp: "2026-02-01T10:00:0" + i + ".000Z",
    type: "assistant",
    message: { id: "m-stream", role: "assistant", model: "claude-opus-5",
      usage: { input_tokens: n, output_tokens: n * 2,
               cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  }));
  writeFileSync(join(proj, "s1.jsonl"), rows.join("\n") + "\n");

  const out = await discoverAccounts({ home, showAccounts: true });
  const t = out[0].onDisk;
  // The message cost what its LARGEST write says: 40 in, 80 out.
  assert.equal(t.input, 40,
    "115 is the sum of every chunk — the uuid set removes nothing because each "
    + "chunk carries its own uuid");
  assert.equal(t.output, 80);
});

// ── the archive mirror is the same work, not more of it ─────────────────────
//
// ~/.ai-logs-archive/claude/<name> is a HARD-LINK mirror of ~/<name>: the same
// inodes, under a second path, so the transcripts survive retention deleting
// the originals. Tokens were already safe — creditUsage keys on message.id
// across the whole machine, so a mirror credits nothing — but two other numbers
// were not:
//
//   sessions were counted per FILE:  132 live became 384 on this machine
//   accounts were keyed per DIR:     5 real became 14, with NINE phantom
//                                    `unknown (<dirname>)` rows published
//
// Neither is fixed by skipping the archive. It exists so a session survives its
// original being deleted; skip it and the count collapses the moment retention
// runs. Identity settles both.
test("an archived session is the same session, and its mirror is the same account", async () => {
  const home = mkdtempSync(join(tmpdir(), "starreckon-mirror-"));
  writeFileSync(join(home, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "owner@example.com" } }));

  const row = (uuid, id, n) => JSON.stringify({
    uuid, sessionId: "sess-A", timestamp: "2026-03-01T09:00:00.000Z", type: "assistant",
    message: { id, role: "assistant", model: "claude-opus-5",
      usage: { input_tokens: n, output_tokens: n, cache_read_input_tokens: 0,
               cache_creation_input_tokens: 0 } },
  });
  const live = join(home, ".claude", "projects", "p1");
  mkdirSync(live, { recursive: true });
  writeFileSync(join(live, "sess-A.jsonl"), row("u1", "m1", 100) + "\n");

  // the mirror: same content, second path, no config of its own
  const mirror = join(home, ".ai-logs-archive", "claude", ".claude", "projects", "p1");
  mkdirSync(mirror, { recursive: true });
  writeFileSync(join(mirror, "sess-A.jsonl"), row("u1", "m1", 100) + "\n");

  const out = await discoverAccounts({ home, showAccounts: true });
  const total = out.reduce((a, r) => a + r.onDisk.sessions, 0);
  assert.equal(total, 1,
    "2 means the mirror was counted as a second session — it is the same session");

  const accounts = new Set(out.map((r) => r.account));
  assert.equal(accounts.size, 1,
    "a mirror with no config of its own must inherit its SOURCE's account, not "
    + "invent `unknown (<dirname>)` — nine of those were published on the real machine");
  assert.ok(![...accounts].some((a) => String(a).startsWith("unknown (")),
    `phantom account: ${[...accounts]}`);
  rmSync(home, { recursive: true, force: true });
});

// ── the second counter, cross-checked against the first ──────────────────────
//
// TWO PROGRAMS IN ONE REPOSITORY COUNT THE SAME TRANSCRIPTS. scan.mjs walks
// them with parseClaudeFile for the star and the reports; accounts.mjs walks
// them again with scanProfile for the ledger, the per-account tables,
// --join-fleet and the MACHINE TOTAL FLOOR. They share creditUsage and nothing
// else — separate walkers, separate line filters, separate accumulators.
//
// NOTHING HELD THEM TO EACH OTHER. discoverAccounts builds its own seen-map
// (accounts.mjs:655) on every call; there is no parameter for a shared one and
// no caller passes one, so this path has always counted independently. When it
// deduped on rec.uuid instead of message.id it read 1,409,787,623 against
// scan.mjs's 520,497,793 — a 2.71x inflation in the number that feeds the
// floor — and the way that was found was a person copying a profile to a
// scratch home and running both by hand (accounts.mjs:449-454). No test could
// see it, because each program was only ever asked whether it agreed with
// itself.
//
// A CROSS-CHECK, NOT A REFUSAL. Refusing to run standalone was the other
// option and it is the wrong one: standalone IS the calling convention —
// cli.mjs:1125 is the only caller and it passes no map — so a refusal would
// delete the feature rather than guard it. What was missing is the comparison.
//
// The fixture carries the exact shape the 2.71x came from: one assistant
// message re-emitted three times by a streaming write, each row with a FRESH
// uuid and the SAME message.id and counters that only grow. Dedup on uuid
// credits all three (600/600); dedup on message.id credits the last (300/300).
test("scanProfile and parseClaudeFile agree, token for token, on the same files", async () => {
  const { emptyStats, parseClaudeFile } = await import("../src/scan.mjs");
  const home = mkdtempSync(join(tmpdir(), "starreckon-agree-"));
  writeFileSync(join(home, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "owner@example.com" } }));

  const row = (uuid, id, n) => JSON.stringify({
    uuid, sessionId: "sess-A", timestamp: "2026-03-01T09:00:00.000Z",
    type: "assistant", cwd: "/home/owner/work/api",
    message: { id, role: "assistant", model: "claude-opus-5",
      usage: { input_tokens: n, output_tokens: n * 2,
               cache_read_input_tokens: n * 3, cache_creation_input_tokens: n * 4 } },
  });

  const p1 = join(home, ".claude", "projects", "-home-owner-work-api");
  mkdirSync(p1, { recursive: true });
  writeFileSync(join(p1, "sess-A.jsonl"), [
    row("uuid-1", "msg-1", 100),   // a streaming write, emitted three times:
    row("uuid-2", "msg-1", 200),   // fresh uuid, same message.id, growing
    row("uuid-3", "msg-1", 300),   // counters. Only the last is the message.
    row("uuid-4", "msg-2", 7),
  ].join("\n") + "\n");

  // A SECOND PROFILE HOLDING THE SAME SESSION. Both programs dedup
  // machine-wide, so this must credit nothing in either — and if only one of
  // them scopes its map per profile, the totals part company here.
  const alt = join(home, ".claude-alt");
  mkdirSync(join(alt, "projects", "-home-owner-work-api"), { recursive: true });
  writeFileSync(join(alt, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "owner@example.com" } }));
  writeFileSync(join(alt, "projects", "-home-owner-work-api", "sess-A.jsonl"),
    row("uuid-5", "msg-1", 300) + "\n");

  // Path 1 — accounts.mjs, exactly as cli.mjs calls it: no shared state.
  const rows = await discoverAccounts({ home });
  const A = tok();
  for (const r of rows) {
    A.input += r.onDisk.input; A.output += r.onDisk.output;
    A.cacheRead += r.onDisk.cacheRead; A.cacheWrite += r.onDisk.cacheWrite;
  }

  // Path 2 — scan.mjs, over THE SAME FILES, found by accounts.mjs's own
  // discovery so the comparison is of the two COUNTERS and not of two
  // different file lists.
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".jsonl")) files.push(p);
    }
  };
  for (const dir of findConfigDirs(home)) {
    const root = join(dir, "projects");
    if (existsSync(root)) walk(root);
  }
  assert.ok(files.length >= 2, `the fixture must give both paths files: ${files.length}`);
  const stats = emptyStats();
  for (const f of files) await parseClaudeFile(f, stats);
  const B = tok();
  for (const s of stats.sessions.values()) {
    B.input += s.tok.in; B.output += s.tok.out;
    B.cacheRead += s.tok.cr; B.cacheWrite += s.tok.cw;
  }

  // PER BUCKET, NOT PER TOTAL. Two counters that disagree by a swap agree on
  // every sum, and this file's whole subject is a counter nothing checked.
  for (const k of ["input", "output", "cacheRead", "cacheWrite"])
    assert.equal(A[k], B[k],
      `${k}: accounts.mjs says ${A[k]}, scan.mjs says ${B[k]}. These read the ` +
      `same bytes; a disagreement is one of them being wrong about the machine.`);

  // And the value both must arrive at, worked out by hand rather than taken
  // from either program: msg-1 credits its maximum ONCE across both profiles
  // (300 · 600 · 900 · 1200), msg-2 credits 7 · 14 · 21 · 28.
  assert.deepEqual(A, tok(307, 614, 921, 1228),
    "measured: uuid dedup gives 907/1814/2721/3628 — the 2.71x, in miniature");
  rmSync(home, { recursive: true, force: true });
});
