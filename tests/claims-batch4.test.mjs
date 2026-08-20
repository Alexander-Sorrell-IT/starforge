// Guards for the claims the census found UNGUARDED — batch 4.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contactLines } from "../src/contact.mjs";
import { maskProjects } from "../src/redact.mjs";
import { scanPortedReaders } from "../src/scanners.mjs";

// ── contact.mjs — a field fits whole or is skipped ──────────────────────────
//
// The wrapped card has a 260-byte budget. A field that does not fit is dropped
// ENTIRELY, because a half-email is worse than no email: it looks like contact
// details and cannot be used, and the reader cannot tell which.

test("a field that does not fit is absent, not cut short", () => {
  const email = "averyveryverylongaddress@example-domain-name.com";
  const lines = contactLines({ email }, 10);   // budget far below the field
  assert.deepEqual(lines, [], "a field was emitted inside a budget it does not fit");
});

test("a field that fits is emitted whole", () => {
  const email = "a@b.co";
  const lines = contactLines({ email }, 200);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(email), `${lines[0]} does not carry the whole value`);
});

test("no emitted line is a prefix of the value it came from", () => {
  // The shape of the defect: a truncation produces a line that STARTS like the
  // real one and is shorter. Assert against that directly.
  const contact = { email: "someone@example.com", site: "https://example.com/a/very/long/path" };
  for (const budget of [0, 5, 12, 25, 40, 60, 200]) {
    for (const line of contactLines(contact, budget)) {
      const value = Object.values(contact).find((v) => line.includes(v));
      assert.ok(value !== undefined,
        `"${line}" at budget ${budget} carries no complete field value — it is a truncation`);
    }
  }
});

// ── redact.mjs — maskProjects never mutates its input ───────────────────────
//
// The terminal has already printed the real project names by the time this
// runs. Mutating the caller's object would mask the live report in place, and
// the caller has no way to know it happened.

test("maskProjects returns a new structure and leaves the original alone", () => {
  const input = { projects: ["alpha/beta", "gamma/delta"], nested: { p: ["alpha/beta"] } };
  const before = JSON.stringify(input);
  const out = maskProjects(input, new Set(["alpha/beta", "gamma/delta"]));
  assert.equal(JSON.stringify(input), before,
    "the caller's object was rewritten in place");
  assert.notEqual(JSON.stringify(out), before, "nothing was masked at all");
});

test("the arrays inside are copies, not the same arrays", () => {
  const arr = ["alpha/beta"];
  const input = { projects: arr };
  const out = maskProjects(input, new Set(["alpha/beta"]));
  assert.notEqual(out.projects, arr, "the returned array IS the input array");
  assert.deepEqual(arr, ["alpha/beta"], "the input array's contents changed");
});

test("a frozen input does not throw", () => {
  // The strongest statement of the rule: if nothing is written, freezing
  // changes nothing. In strict mode a write to a frozen array throws, so this
  // fails loudly rather than silently on any in-place assignment.
  const input = Object.freeze({ projects: Object.freeze(["alpha/beta"]) });
  assert.doesNotThrow(() => maskProjects(input, new Set(["alpha/beta"])));
});

// ── scanners.mjs — the published row and the per-session list agree ─────────
//
// providers[name] is what a report leads with; perSession is the list a reader
// can check it against. If they disagree, one of them is wrong and nothing in
// the output says which.

function clawspringHome(rows) {
  const h = mkdtempSync(join(tmpdir(), "agree-"));
  const d = join(h, ".clawspring", "sessions", "daily", "x");
  mkdirSync(d, { recursive: true });
  for (const [id, n] of rows) {
    writeFileSync(join(d, `session_${id}.json`),
      JSON.stringify({ session_id: id, total_input_tokens: n, total_output_tokens: 0 }));
  }
  return h;
}

test("the row's totals are the sum of its own per-session rows", async () => {
  const home = clawspringHome([["a", 100], ["b", 250], ["c", 7]]);
  const r = await scanPortedReaders([home], { knownClaudeIds: new Set() });
  for (const [name, row] of Object.entries(r.providers)) {
    const mine = r.perSession.filter((s) => s.provider === name);
    if (!row.sessions && !mine.length) continue;
    assert.equal(row.sessions, mine.length,
      `${name}: the row says ${row.sessions} sessions and the list holds ${mine.length}`);
    for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
      const summed = mine.reduce((a, s) => a + (s[k] ?? 0), 0);
      assert.equal(row[k], summed,
        `${name}.${k}: the row publishes ${row[k]} and its own sessions sum to ${summed}`);
    }
  }
});

test("and it holds when a provider has exactly one session", () => {
  // The one-session case is where a dropped-first-element bug hides: the row
  // reads 0 while the list holds one, and every multi-session check still
  // passes.
  return scanPortedReaders([clawspringHome([["only", 42]])], { knownClaudeIds: new Set() })
    .then((r) => {
      const row = r.providers.clawspring;
      const mine = r.perSession.filter((s) => s.provider === "clawspring");
      assert.equal(mine.length, 1);
      assert.equal(row.input, 42, `the row publishes ${row.input} for a single 42-token session`);
    });
});
