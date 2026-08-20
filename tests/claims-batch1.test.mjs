// Guards for the claims the census found UNGUARDED.
//
// claims_probe.mjs makes each sentence the code states in the absolute FALSE in
// a throwaway copy and runs the suites that ought to notice. These three were
// falsified and every suite stayed green, so the comment was the only thing
// holding them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creditUsage } from "../src/scan.mjs";
import { accountPseudonym } from "../src/redact.mjs";
import { writeMachineFolder } from "../src/fleet.mjs";

// ── scan.mjs — a row with no message.id still has an identity ────────────────
//
// `creditUsage` credits a message once. A row with no `message.id` was treated
// as having no identity at all, so every one of them was credited IN FULL EVERY
// TIME IT WAS SEEN — the differential fuzzer caught it as starreckon reading
// exactly DOUBLE on 20 of 60 generated corpora, truth 43,669 against 71,263.
// The row uuid IS an identity: stable across copies, per row, so a streaming
// rewrite still gets its own entry. `msg.id` first, uuid second.
//
// The fix landed with no test. Removing the uuid fallback left every suite
// green, which is how it would come back.

const usage = (n) => ({ input_tokens: n, output_tokens: 0,
                        cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

function creditTwice(id) {
  const seen = new Map();
  const a = creditUsage(seen, id, usage(100));
  const b = creditUsage(seen, id, usage(100));
  return a.in + b.in;
}

test("a row seen twice under one message.id is credited once", () => {
  assert.equal(creditTwice("msg-1"), 100);
});

test("a row with NO message.id is still credited once, by its uuid", () => {
  // This is the whole claim. Without the uuid fallback the id is null, null is
  // not correlatable, and the same row banks 200.
  assert.equal(creditTwice("uuid:row-abc"), 100,
    "an id-less row credited twice is the 2x the differential fuzzer found");
});

test("two different rows are two messages, not one", () => {
  const seen = new Map();
  const a = creditUsage(seen, "uuid:row-a", usage(100));
  const b = creditUsage(seen, "uuid:row-b", usage(100));
  assert.equal(a.in + b.in, 200, "distinct rows must not collapse into one");
});

test("the id-less path produces an id at all", () => {
  // The mutation the census applies replaces the uuid fallback with `null`.
  // Assert on the source too, because a null id reaching creditUsage is
  // indistinguishable from a row that legitimately had none.
  const src = readFileSync(new URL("../src/scan.mjs", import.meta.url), "utf8");
  assert.match(src, /uuid:\$\{d\.uuid\}/,
    "the row uuid is the identity a row with no message.id has");
  assert.ok(src.indexOf("typeof msg.id") < src.indexOf("d.uuid"),
    "message.id must be tried FIRST — the uuid is per row, so leading with it "
    + "makes every streaming rewrite its own message");
});

// ── redact.mjs — the pseudonym is salted ─────────────────────────────────────
//
// accountPseudonym is the only thing standing between a published report and
// the user's Claude account address. It is a constant-salted sha256 prefix, and
// the file says so honestly. Drop the salt and it becomes a BARE sha256 of an
// email — a wordlist away from the address it exists to hide — and every
// privacy suite stayed green when the census did exactly that.

test("the pseudonym is not a bare hash of the identity", async () => {
  const { createHash } = await import("node:crypto");
  const email = "someone@example.com";
  const bare = "acct-" + createHash("sha256").update(email).digest("hex").slice(0, 8);
  assert.notEqual(accountPseudonym(email), bare,
    "an unsalted digest of an address is reversible with a wordlist");
});

test("the pseudonym never contains the identity, or any part of it", () => {
  // DERIVED FROM THE INPUT, not three hardcoded fragments. The first version
  // spelled out "someone" and "example.com", which CodeQL read as an
  // incomplete URL check (js/incomplete-url-substring-sanitization) — a false
  // positive on a negative assertion, but the literals were the weaker test
  // anyway: they check the parts someone happened to think of.
  const email = "someone.surname@sub.example.co.uk";
  const p = accountPseudonym(email);
  assert.ok(!p.includes(email), "the whole address survived");
  for (const part of email.split(/[@._-]/).filter((x) => x.length >= 3)) {
    assert.ok(!p.includes(part), `the pseudonym still carries "${part}"`);
  }
  assert.match(p, /^acct-[0-9a-f]{8}$/, "a pseudonym is a label, not a transform");
});

test("the pseudonym is stable and distinguishing", () => {
  assert.equal(accountPseudonym("a@b.c"), accountPseudonym("a@b.c"),
    "two machines must agree on one account's label");
  assert.notEqual(accountPseudonym("a@b.c"), accountPseudonym("a@b.d"),
    "two accounts must not collapse into one label");
});

test("an absent identity does not throw and does not become a shared label", () => {
  for (const v of [null, undefined, ""]) assert.match(accountPseudonym(v), /^acct-[0-9a-f]{8}$/);
});

// ── fleet.mjs — a real report is never clobbered by a stub ───────────────────
//
// writeMachineFolder writes a REPORT.md stub only if nothing is there, because
// combine.py links every machine row to <folder>/human-readable/REPORT.md and a
// real report written by deadreckon must survive a starreckon fleet write.

function machineFolder() {
  const dir = mkdtempSync(join(tmpdir(), "fleet-"));
  return dir;
}

// The shape writeMachineFolder actually validates — taken from fleet.test.mjs,
// not guessed. It rejects an account with no identity and one with no by_model,
// which is why a hand-written stub fixture fails before it reaches the claim.
const F4 = (i, cw, cr, o) => ({
  input_tokens: i, cache_creation_input_tokens: cw,
  cache_read_input_tokens: cr, output_tokens: o,
});
const DATA = {
  label: "M",
  generatedAt: "2026-02-01T12:00:00-06:00",
  accounts: [{
    account: "a@x.com",
    config_dir: "~/.claude",
    totals: F4(10, 0, 0, 5),
    by_model: { "claude-opus-4-6": F4(10, 0, 0, 5) },
    by_day: { "2026-01-05": F4(10, 0, 0, 5) },
  }],
};

test("a REPORT.md that is already there is left alone", () => {
  const dir = machineFolder();
  writeMachineFolder(dir, "m1", DATA);
  const report = join(dir, "m1", "human-readable", "REPORT.md");
  assert.ok(existsSync(report), "the stub is written when nothing is there");

  writeFileSync(report, "# THE REAL REPORT\nwritten by deadreckon\n");
  writeMachineFolder(dir, "m1", DATA, { replace: true });
  assert.match(readFileSync(report, "utf8"), /THE REAL REPORT/,
    "a fleet write replaced a real report with its own stub");
});

test("the stub is still written when the folder has no report", () => {
  const dir = machineFolder();
  writeMachineFolder(dir, "m2", DATA);
  const report = join(dir, "m2", "human-readable", "REPORT.md");
  assert.ok(existsSync(report));
  assert.match(readFileSync(report, "utf8"), /starreckon/,
    "the stub names who wrote it, so a reader can tell it from a real report");
});
