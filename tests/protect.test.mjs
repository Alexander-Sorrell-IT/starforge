// tests/protect.test.mjs — pure-logic tests for src/protect.mjs
//
// All tests use temporary directories. No real Claude profile is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync, writeFileSync, rmSync, readFileSync,
  linkSync, statSync, existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  findClaudeProfiles,
  raisePeriod,
  linkTree,
  needsProtection,
} from "../src/protect.mjs";

// ── helpers ───────────────────────────────────────────────────────────────────

function tmp() {
  const d = join(tmpdir(), "protect-test-" + Math.floor(Math.random() * 1e9));
  mkdirSync(d, { recursive: true });
  return d;
}

function makeProfile(home, name = ".claude") {
  // A minimal Claude profile: has projects/ with at least one .jsonl
  const profile = join(home, name);
  const proj = join(profile, "projects", "my-project");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "session-abc.jsonl"), '{"type":"test"}\n');
  return profile;
}

function makeSettings(profile, days) {
  writeFileSync(
    join(profile, "settings.json"),
    JSON.stringify({ cleanupPeriodDays: days }, null, 2)
  );
}

// ── findClaudeProfiles ────────────────────────────────────────────────────────

// Every test below hands findClaudeProfiles a temp home and asserts on what is
// INSIDE it, so the $CLAUDE_CONFIG_DIR sweep — which deliberately reaches
// outside the home — has to be switched off or the assertions are about this
// developer's machine rather than about the fixture. Three of them failed here
// for exactly that reason: the variable was set to an alternate profile in that
// shell, so "empty home" returned one profile.
//
// The tests that follow this block switch it back ON, because turning a
// behaviour off in every test is how the behaviour stops being tested at all.
const NO_ENV = { configDir: null };

test("findClaudeProfiles returns [] for empty home dir", () => {
  const home = tmp();
  assert.deepEqual(findClaudeProfiles(home, NO_ENV), []);
  rmSync(home, { recursive: true, force: true });
});

test("findClaudeProfiles finds a profile by shape", () => {
  const home = tmp();
  makeProfile(home, ".claude");
  const found = findClaudeProfiles(home, NO_ENV);
  assert.ok(found.length >= 1, "expected at least one profile");
  assert.ok(found.some(p => p.endsWith(".claude")));
  rmSync(home, { recursive: true, force: true });
});

test("findClaudeProfiles finds non-standard profile names", () => {
  const home = tmp();
  makeProfile(home, ".claude-alt");
  makeProfile(home, ".my-claude");
  const found = findClaudeProfiles(home, NO_ENV);
  assert.ok(found.some(p => p.endsWith(".claude-alt")));
  assert.ok(found.some(p => p.endsWith(".my-claude")));
  rmSync(home, { recursive: true, force: true });
});

test("findClaudeProfiles skips directory without .jsonl (not a profile)", () => {
  const home = tmp();
  // projects/ exists but has no .jsonl
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  writeFileSync(join(home, ".claude", "projects", "readme.txt"), "nothing");
  const found = findClaudeProfiles(home, NO_ENV);
  assert.equal(found.length, 0);
  rmSync(home, { recursive: true, force: true });
});

test("findClaudeProfiles skips .ai-logs-archive", () => {
  const home = tmp();
  // Put a profile-shaped directory inside the archive — must not be counted
  const archiveProfile = join(home, ".ai-logs-archive", "claude", ".claude");
  mkdirSync(join(archiveProfile, "projects", "proj"), { recursive: true });
  writeFileSync(join(archiveProfile, "projects", "proj", "s.jsonl"), "{}");
  const found = findClaudeProfiles(home, NO_ENV);
  assert.equal(found.length, 0);
  rmSync(home, { recursive: true, force: true });
});

test("findClaudeProfiles deduplicates by inode", () => {
  const home = tmp();
  makeProfile(home, ".claude");
  // Walk will find it twice if not deduplicated — but dedup should give 1
  const found = findClaudeProfiles(home, NO_ENV);
  const unique = new Set(found);
  assert.equal(found.length, unique.size);
  rmSync(home, { recursive: true, force: true });
});

// The CLAUDE_CONFIG_DIR sweep, asserted rather than assumed. Without these two
// the parameter added above would be a silent off-switch: delete the `add`
// call and all six tests above still pass, because none of them can see it.
// A profile the glob cannot reach is the documented reason this sweep exists —
// ~/.my-claude is missed by any ~/.claude* glob — so it needs a test that dies
// when it goes away.

test("findClaudeProfiles honours CLAUDE_CONFIG_DIR outside the home", () => {
  const home = tmp();
  const elsewhere = tmp();                      // a DIFFERENT tree entirely
  makeProfile(elsewhere, "config");
  const found = findClaudeProfiles(home, { configDir: join(elsewhere, "config") });
  assert.equal(found.length, 1, "the out-of-home config dir was not picked up");
  assert.ok(found[0].endsWith("config"));
  rmSync(home, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

test("findClaudeProfiles does not double-count a CLAUDE_CONFIG_DIR inside the home", () => {
  const home = tmp();
  makeProfile(home, ".claude");
  // Same directory reached by both routes: the .claude* fast path AND the env
  // var. The inode dedup is what must stop it counting twice.
  const found = findClaudeProfiles(home, { configDir: join(home, ".claude") });
  assert.equal(found.length, 1);
  rmSync(home, { recursive: true, force: true });
});

// ── raisePeriod ───────────────────────────────────────────────────────────────

test("raisePeriod creates settings.json with 36500 when absent", () => {
  const home = tmp();
  const profile = makeProfile(home);
  const result = raisePeriod(profile);
  assert.equal(result.changed, true);
  const written = JSON.parse(readFileSync(join(profile, "settings.json"), "utf-8"));
  assert.equal(written.cleanupPeriodDays, 36500);
  rmSync(home, { recursive: true, force: true });
});

test("raisePeriod raises from 30 to 36500", () => {
  const home = tmp();
  const profile = makeProfile(home);
  makeSettings(profile, 30);
  const result = raisePeriod(profile);
  assert.equal(result.changed, true);
  const written = JSON.parse(readFileSync(join(profile, "settings.json"), "utf-8"));
  assert.equal(written.cleanupPeriodDays, 36500);
  rmSync(home, { recursive: true, force: true });
});

test("raisePeriod does not lower a value already above 36500", () => {
  const home = tmp();
  const profile = makeProfile(home);
  makeSettings(profile, 99999);
  const result = raisePeriod(profile);
  assert.equal(result.changed, false);
  const written = JSON.parse(readFileSync(join(profile, "settings.json"), "utf-8"));
  assert.equal(written.cleanupPeriodDays, 99999);
  rmSync(home, { recursive: true, force: true });
});

test("raisePeriod does not lower 36500", () => {
  const home = tmp();
  const profile = makeProfile(home);
  makeSettings(profile, 36500);
  const result = raisePeriod(profile);
  assert.equal(result.changed, false);
  rmSync(home, { recursive: true, force: true });
});

test("raisePeriod preserves other keys in settings.json", () => {
  const home = tmp();
  const profile = makeProfile(home);
  writeFileSync(
    join(profile, "settings.json"),
    JSON.stringify({ cleanupPeriodDays: 30, theme: "dark", otherKey: 42 }, null, 2)
  );
  raisePeriod(profile);
  const written = JSON.parse(readFileSync(join(profile, "settings.json"), "utf-8"));
  assert.equal(written.theme, "dark");
  assert.equal(written.otherKey, 42);
  assert.equal(written.cleanupPeriodDays, 36500);
  rmSync(home, { recursive: true, force: true });
});

test("raisePeriod creates a backup file on first edit", () => {
  const home = tmp();
  const profile = makeProfile(home);
  makeSettings(profile, 30);
  raisePeriod(profile);
  assert.ok(existsSync(join(profile, "settings.json.before-starreckon")));
  rmSync(home, { recursive: true, force: true });
});

test("raisePeriod dry run changes nothing", () => {
  const home = tmp();
  const profile = makeProfile(home);
  makeSettings(profile, 30);
  const before = readFileSync(join(profile, "settings.json"), "utf-8");
  const result = raisePeriod(profile, { dry: true });
  assert.equal(result.changed, true); // would change
  const after = readFileSync(join(profile, "settings.json"), "utf-8");
  assert.equal(before, after); // but didn't
  rmSync(home, { recursive: true, force: true });
});

test("raisePeriod dry run on already-raised profile", () => {
  const home = tmp();
  const profile = makeProfile(home);
  makeSettings(profile, 36500);
  const result = raisePeriod(profile, { dry: true });
  assert.equal(result.changed, false);
  rmSync(home, { recursive: true, force: true });
});

// ── linkTree ──────────────────────────────────────────────────────────────────

test("linkTree links .jsonl files into archive", () => {
  const home = tmp();
  const src = join(home, "sessions");
  mkdirSync(src);
  writeFileSync(join(src, "session-1.jsonl"), '{"a":1}');
  writeFileSync(join(src, "session-2.jsonl"), '{"b":2}');

  const result = linkTree(src, "test-store", { home });
  assert.equal(result.linked, 2);
  assert.equal(result.failed, 0);

  const archive = join(home, ".ai-logs-archive", "test-store");
  assert.ok(existsSync(join(archive, "session-1.jsonl")));
  assert.ok(existsSync(join(archive, "session-2.jsonl")));
  rmSync(home, { recursive: true, force: true });
});

test("linkTree skips already-linked files (same inode)", () => {
  const home = tmp();
  const src = join(home, "sessions");
  mkdirSync(src);
  writeFileSync(join(src, "session-1.jsonl"), '{"a":1}');

  // First link
  const r1 = linkTree(src, "test-store", { home });
  assert.equal(r1.linked, 1);

  // Second link — already there at same inode
  const r2 = linkTree(src, "test-store", { home });
  assert.equal(r2.linked, 0);
  assert.equal(r2.skipped, 1);
  rmSync(home, { recursive: true, force: true });
});

test("linkTree does not link credential files", () => {
  const home = tmp();
  const src = join(home, "sessions");
  mkdirSync(src);
  writeFileSync(join(src, "session-1.jsonl"), '{"a":1}');
  writeFileSync(join(src, ".credentials.json"), '{"token":"secret"}');
  writeFileSync(join(src, "oauth_creds.json"), '{"oauth":"secret"}');

  const result = linkTree(src, "test-store", { home });
  const archive = join(home, ".ai-logs-archive", "test-store");

  assert.ok(existsSync(join(archive, "session-1.jsonl")));
  assert.ok(!existsSync(join(archive, ".credentials.json")));
  assert.ok(!existsSync(join(archive, "oauth_creds.json")));
  rmSync(home, { recursive: true, force: true });
});

test("linkTree does not link files in secret subdirectories", () => {
  const home = tmp();
  const src = join(home, "sessions");
  const secretDir = join(src, "mcp-secrets");
  mkdirSync(secretDir, { recursive: true });
  writeFileSync(join(secretDir, "gh.json"), '{"token":"secret"}');
  writeFileSync(join(src, "real-session.jsonl"), '{"a":1}');

  const result = linkTree(src, "test-store", { home });
  const archive = join(home, ".ai-logs-archive", "test-store");

  assert.ok(existsSync(join(archive, "real-session.jsonl")));
  assert.ok(!existsSync(join(archive, "mcp-secrets", "gh.json")));
  rmSync(home, { recursive: true, force: true });
});

test("linkTree ignores non-session file extensions", () => {
  const home = tmp();
  const src = join(home, "sessions");
  mkdirSync(src);
  writeFileSync(join(src, "session.jsonl"), "{}");
  writeFileSync(join(src, "config.toml"), "[config]");
  writeFileSync(join(src, "readme.md"), "# docs");

  linkTree(src, "test-store", { home });
  const archive = join(home, ".ai-logs-archive", "test-store");

  assert.ok(existsSync(join(archive, "session.jsonl")));
  assert.ok(!existsSync(join(archive, "config.toml")));
  assert.ok(!existsSync(join(archive, "readme.md")));
  rmSync(home, { recursive: true, force: true });
});

test("linkTree returns correct counts (linked/skipped/failed)", () => {
  const home = tmp();
  const src = join(home, "sessions");
  mkdirSync(src);
  writeFileSync(join(src, "a.jsonl"), "{}");
  writeFileSync(join(src, "b.jsonl"), "{}");
  writeFileSync(join(src, "c.jsonl"), "{}");

  // First pass: link all three
  const r1 = linkTree(src, "test-store", { home });
  assert.equal(r1.linked, 3);
  assert.equal(r1.skipped, 0);

  // Second pass: all already linked
  const r2 = linkTree(src, "test-store", { home });
  assert.equal(r2.linked, 0);
  assert.equal(r2.skipped, 3);
  rmSync(home, { recursive: true, force: true });
});

test("linkTree dry run links nothing but reports correctly", () => {
  const home = tmp();
  const src = join(home, "sessions");
  mkdirSync(src);
  writeFileSync(join(src, "session.jsonl"), "{}");

  const result = linkTree(src, "test-store", { home, dry: true });
  assert.equal(result.linked, 1);

  // Archive should not exist (dry run)
  assert.ok(!existsSync(join(home, ".ai-logs-archive", "test-store", "session.jsonl")));
  rmSync(home, { recursive: true, force: true });
});

test("linkTree returns absent when source does not exist", () => {
  const home = tmp();
  const result = linkTree(join(home, "nonexistent"), "test-store", { home });
  assert.equal(result.status, "absent");
  rmSync(home, { recursive: true, force: true });
});

test("linkTree archives .db and .db-wal files", () => {
  const home = tmp();
  const src = join(home, "db-store");
  mkdirSync(src);
  writeFileSync(join(src, "sessions.db"), Buffer.alloc(100));
  writeFileSync(join(src, "sessions.db-wal"), Buffer.alloc(50));

  const result = linkTree(src, "test-db", { home });
  assert.equal(result.linked, 2);

  const archive = join(home, ".ai-logs-archive", "test-db");
  assert.ok(existsSync(join(archive, "sessions.db")));
  assert.ok(existsSync(join(archive, "sessions.db-wal")));
  rmSync(home, { recursive: true, force: true });
});

test("linkTree archives nested subdirectory structure", () => {
  const home = tmp();
  const src = join(home, "sessions");
  mkdirSync(join(src, "2026", "07", "01"), { recursive: true });
  writeFileSync(join(src, "2026", "07", "01", "rollout-abc.jsonl"), "{}");

  linkTree(src, "codex", { home });
  const archive = join(home, ".ai-logs-archive", "codex");
  assert.ok(existsSync(join(archive, "2026", "07", "01", "rollout-abc.jsonl")));
  rmSync(home, { recursive: true, force: true });
});

// ── needsProtection ───────────────────────────────────────────────────────────

test("needsProtection returns false when no Claude profiles exist", () => {
  const home = tmp();
  assert.equal(needsProtection(home, NO_ENV), false);
  rmSync(home, { recursive: true, force: true });
});

test("needsProtection returns true when profile has default 30-day period", () => {
  const home = tmp();
  const profile = makeProfile(home);
  makeSettings(profile, 30);
  assert.equal(needsProtection(home, NO_ENV), true);
  rmSync(home, { recursive: true, force: true });
});

test("needsProtection returns false when all profiles are raised", () => {
  const home = tmp();
  const profile = makeProfile(home);
  makeSettings(profile, 36500);
  assert.equal(needsProtection(home, NO_ENV), false);
  rmSync(home, { recursive: true, force: true });
});

test("needsProtection returns true when any profile is unprotected", () => {
  const home = tmp();
  const p1 = makeProfile(home, ".claude");
  const p2 = makeProfile(home, ".claude-alt");
  makeSettings(p1, 36500); // protected
  makeSettings(p2, 30);    // not protected
  assert.equal(needsProtection(home, NO_ENV), true);
  rmSync(home, { recursive: true, force: true });
});

// ── credentials are recognised by SHAPE, not by a list of ten names ──────────
//
// SECRET_NAMES held `oauth_creds.json`. `~/.aider` was archived whole. So
// `oauth-keys.json` — one character different — was hard-linked into
// ~/.ai-logs-archive/aider/ on every tick, under a header that says "NEVER
// archives credential files". Found by the 2026-08-16 full inventory. An
// exact-name denylist cannot keep a promise about names it has not seen.
test("linkTree refuses credential-shaped names it has never seen, and archives records", () => {
  const home = tmp();
  const src = join(home, "store");
  mkdirSync(src);
  // credentials — none of these were in the old exact list
  for (const n of ["oauth-keys.json", "api_key.json", "refresh_token.json", "id_rsa", "cookies.txt"])
    writeFileSync(join(src, n), "SECRET");
  // records — the word "token" as a unit of measure, not a credential
  for (const n of ["session-1.jsonl", "token_ledger.jsonl", "token-usage.json", "cookie-cutter.json"])
    writeFileSync(join(src, n), '{"a":1}');

  const r = linkTree(src, "shape-store", { home });
  const archive = join(home, ".ai-logs-archive", "shape-store");
  for (const n of ["oauth-keys.json", "api_key.json", "refresh_token.json", "id_rsa", "cookies.txt"])
    assert.ok(!existsSync(join(archive, n)), `${n} is a credential and must not be archived`);
  for (const n of ["session-1.jsonl", "token_ledger.jsonl", "token-usage.json", "cookie-cutter.json"])
    assert.ok(existsSync(join(archive, n)), `${n} is a record and must be archived`);
  assert.equal(r.linked, 4);
  rmSync(home, { recursive: true, force: true });
});
