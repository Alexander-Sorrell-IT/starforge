// Guards for the claims the census found UNGUARDED — batch 5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { sessionRecords } from "../src/scan.mjs";
import { machineFloor } from "../src/fleet.mjs";

// ── scan.mjs — an INVENTED session id is masked; a row's own id is not ──────
//
// When no row declares an id, parseClaudeFile falls back to
// <parent-dir>/<file-stem>, and a Claude project directory name is the user's
// WORKING PATH with the slashes rewritten to dashes: the home directory, the
// username and every project name, in one string.
//
// Writing that raw would put into a NEW file exactly what maskPath strips from
// every old one, and under --no-projects it would leak the project names the
// flag promises to hash — a privacy flag FAILING OPEN. An id a row declared is
// a vendor UUID and the join key, so it is emitted byte for byte.

const F4 = { in: 10, out: 5, cr: 0, cw: 0 };
function stats(id, fromRow) {
  return { sessions: new Map([[id, {
    idFromRow: fromRow, sources: new Set(["claude"]), project: "p",
    firstTs: 0, lastTs: 0, tok: F4,
  }]]) };
}

const INVENTED = `-home-${(homedir().split("/").filter(Boolean)[1] ?? "someuser")}-work-secret-client-project/chat-01`;

test("an id this scanner invented from a path is not written raw", () => {
  // WHAT THE DEFAULT ACTUALLY PROMISES, which is narrower than it first looks.
  // Project names are kept readable BY DEFAULT — they are most of a report's
  // value and the choice is disclosed in four places. What maskPath strips is
  // the HOME DIRECTORY AND THE USERNAME, which is what would otherwise be
  // written into a new file after being stripped from every old one.
  //
  // The first version of this test asserted the project name was gone too, and
  // failed against correct code. Asserting more than the program promises does
  // not make it safer; it makes the suite wrong in a way that gets "fixed" by
  // weakening the program.
  const [rec] = sessionRecords(stats(INVENTED, false));
  assert.notEqual(rec.session_id, INVENTED,
    "the working path was written into a new file verbatim");
  const user = homedir().split("/").filter(Boolean)[1];
  if (user) assert.ok(!rec.session_id.includes(user),
    `${rec.session_id} still carries the username`);
});

test("and under --no-projects it is pseudonymised outright", () => {
  const [rec] = sessionRecords(stats(INVENTED, false), { noProjects: true });
  assert.ok(!rec.session_id.includes("secret-client"),
    `--no-projects promises to hash project names and ${rec.session_id} carries one`);
  assert.notEqual(rec.session_id, INVENTED);
});

test("an id a ROW declared is emitted byte for byte — it is the join key", () => {
  const uuid = "b3f1c0de-0000-4000-8000-000000000001";
  const [rec] = sessionRecords(stats(uuid, true));
  assert.equal(rec.session_id, uuid,
    "masking a vendor UUID would break the join the counting path depends on");
});

test("id_source says which of the two every record is", () => {
  assert.equal(sessionRecords(stats("x", true))[0].id_source, "row");
  assert.equal(sessionRecords(stats(INVENTED, false))[0].id_source, "path",
    "without this the other side has to guess from whether it sees a slash");
});

// ── fleet.mjs — a floor is never below what was measured ────────────────────
//
// The floor is the counter plus the days after it, per account. Session totals
// raise `seen`, so the floor can never come out under a figure this machine
// actually measured. Summing per account is what makes that true across two
// profiles of one account; taking the last one instead silently drops the rest.

test("two profiles of one account are summed into the floor, not replaced", () => {
  const m = { accounts: [
    { account: "a@x.com", grand_total: 400, by_day: { "2026-01-05": 400 } },
  ]};
  const r = machineFloor(m, [
    { cli: "claude", account: "a@x.com", total: 1500 },
    { cli: "claude", account: "a@x.com", total: 2000 },
  ], []);
  assert.equal(r.claude, 3500,
    "one account's two profiles must add up — 2000 alone means the first was dropped");
  assert.ok(r.floor >= 3500, `floor ${r.floor} is below what was measured`);
});

test("the floor is never under the measured figure, counter or no counter", () => {
  const m = { accounts: [
    { account: "a@x.com", grand_total: 400, by_day: { "2026-01-05": 400 } },
  ]};
  const measured = [{ cli: "claude", account: "a@x.com", total: 9_000 }];
  for (const cache of [[], [{ account: "a@x.com", total: 10, last_computed: "2026-01-10" }]]) {
    const r = machineFloor(m, measured, cache);
    assert.ok(r.floor >= 9_000,
      `floor ${r.floor} is below the 9,000 this machine measured (cache: ${cache.length})`);
  }
});

test("accounts do not bleed into each other", () => {
  const m = { accounts: [
    { account: "a@x.com", grand_total: 1, by_day: { "2026-01-05": 1 } },
    { account: "b@x.com", grand_total: 1, by_day: { "2026-01-05": 1 } },
  ]};
  const r = machineFloor(m, [
    { cli: "claude", account: "a@x.com", total: 500 },
    { cli: "claude", account: "b@x.com", total: 700 },
  ], []);
  assert.equal(r.claude, 1200, "per-account totals must be kept apart, then added");
});
