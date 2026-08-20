// @ts-nocheck
import { test } from "node:test";
import assert from "node:assert";
import { redactSecrets, maskPath, REDACTED } from "../src/redact.mjs";
import { homedir } from "node:os";

test("redacts provider tokens", () => {
  const s = redactSecrets(
    "key sk-ant-api03-abcdefghijklmnopqrstuvwx and ghp_" + "a".repeat(36)
  );
  assert.ok(!s.includes("sk-ant"));
  assert.ok(!s.includes("ghp_a"));
  assert.ok(s.includes(REDACTED));
});

test("redacts env-style assignments", () => {
  const s = redactSecrets("DEEPGRAM_API_KEY=abc123def456ghij");
  assert.strictEqual(s, `DEEPGRAM_API_KEY=${REDACTED}`);
});

test("redacts connection-string passwords", () => {
  const s = redactSecrets("postgres://admin:hunter2secret@db.local:5432/x");
  assert.ok(!s.includes("hunter2secret"));
});

test("redacts 32-byte hex private keys", () => {
  const s = redactSecrets("pk 0x" + "ab".repeat(32));
  assert.ok(!s.includes("abab"));
});

test("leaves normal prose alone", () => {
  const s = redactSecrets("refactor the vault interest accrual path");
  assert.strictEqual(s, "refactor the vault interest accrual path");
});

test("masks home directory", () => {
  const s = maskPath(homedir() + "/Documents/Projects/x.ts");
  assert.strictEqual(s, "~/Documents/Projects/x.ts");
});
