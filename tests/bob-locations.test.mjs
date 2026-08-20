// bob runs as numbered instances, and this reader opened one of them.
//
// readBob took `pr.found[0]` and discarded the rest — the only reader in the
// file that did; the other five all iterate pr.found. And probe only ever
// returned the declared path, so there was nothing else in the list anyway.
// Two independent reasons the same data was invisible.
//
// On the machine this was written on: ~/.bob/db plus nine homes under
// ~/.bob-instances/<n>/, two of which held 11 tasks with row ids and inodes
// found nowhere else — 116,711,574 tokens, half of bob's real total.
// deadreckon reaches them through tool_roots, which has walked home for copies
// since its readers were fixed one at a time. starreckon did not, so the two
// programs gave two totals for one machine.
//
// MOST OF THIS FILE TESTS THE OPPOSITE ERROR. Counting a copy inflates the
// total, which is worse than missing one and is the bug this project keeps
// having to undo. The Claude transcripts in those same instance homes ARE
// hardlinked copies — 342 files, every inode already in the main home — so the
// merge has to make a copy contribute nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBob } from "../src/readers.mjs";

const { DatabaseSync } = await import("node:sqlite");

function makeDb(dir, tasks) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "bob.db"));
  db.exec("create table tasks (id text primary key, costs text)");
  for (const [id, input, output, cacheRead, cacheWrite] of tasks) {
    db.prepare("insert into tasks values (?,?)").run(
      id, JSON.stringify({ input, output, cacheRead, cacheWrite }));
  }
  db.close();
}

const home = () => mkdtempSync(join(tmpdir(), "bobloc-"));
const total = (r) => r.sessions.reduce((a, s) =>
  a + ["input", "cacheWrite", "cacheRead", "output"].reduce((x, k) => x + s.tokens[k], 0), 0);

test("a second bob database in an instance home is read", async () => {
  const h = home();
  makeDb(join(h, ".bob", "db"), [["t1", 100, 10, 0, 0]]);
  makeDb(join(h, ".bob-instances", "2", ".bob", "db"), [["t2", 500, 50, 0, 0]]);
  const r = await readBob(h);
  assert.equal(r.databases, 2);
  assert.deepEqual(r.sessions.map((s) => s.id).sort(), ["t1", "t2"]);
  assert.equal(total(r), 660);
});

test("a database holding the same ids adds nothing", async () => {
  const h = home();
  const rows = [["t1", 100, 10, 0, 0], ["t2", 200, 20, 0, 0]];
  makeDb(join(h, ".bob", "db"), rows);
  makeDb(join(h, ".bob-instances", "1", ".bob", "db"), rows);
  const r = await readBob(h);
  assert.equal(r.sessions.length, 2, "a copy is not two more sessions");
  assert.equal(total(r), 330, "a copy is not twice the tokens");
});

test("a truncated copy loses field by field to the fuller one", async () => {
  // Not first-wins: retention truncates one copy, and which directory the walk
  // reaches first must not decide the number.
  const h = home();
  makeDb(join(h, ".bob", "db"), [["t1", 100, 5, 0, 0]]);
  makeDb(join(h, ".bob-instances", "1", ".bob", "db"), [["t1", 900, 90, 0, 0]]);
  const r = await readBob(h);
  assert.equal(r.sessions.length, 1);
  assert.equal(total(r), 990);
});

test("the order the copies are found in does not change the answer", async () => {
  const mk = (first) => {
    const h = home();
    makeDb(join(h, ".bob", "db"), first ? [["t1", 900, 90, 0, 0]] : [["t1", 100, 5, 0, 0]]);
    makeDb(join(h, ".bob-instances", "1", ".bob", "db"),
           first ? [["t1", 100, 5, 0, 0]] : [["t1", 900, 90, 0, 0]]);
    return h;
  };
  const a = await readBob(mk(true));
  const b = await readBob(mk(false));
  assert.equal(total(a), total(b), "a number that moves with directory order is not a measurement");
});

test("one corrupt database does not lose the others", async () => {
  const h = home();
  makeDb(join(h, ".bob", "db"), [["t1", 100, 10, 0, 0]]);
  const bad = join(h, ".bob-instances", "9", ".bob", "db");
  mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "bob.db"), "this is not a database");
  const r = await readBob(h);
  assert.equal(r.sessions.length, 1, "the good database is still read");
  assert.equal(total(r), 110);
  assert.ok(r.unreadable.length >= 1, "and the bad one is NAMED, not dropped in silence");
});

test("every database failing is unreadable, never empty", async () => {
  // The distinction this system has got wrong 28 times: a store that is there
  // and cannot be read is not a tool nobody uses.
  const h = home();
  for (const d of [join(h, ".bob", "db"), join(h, ".bob-instances", "1", ".bob", "db")]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "bob.db"), "not a database");
  }
  const r = await readBob(h);
  assert.equal(r.state, "unreadable");
  assert.notEqual(r.state, "empty");
});

test("a machine with one database is unchanged", async () => {
  const h = home();
  makeDb(join(h, ".bob", "db"), [["t1", 100, 10, 0, 0]]);
  const r = await readBob(h);
  assert.equal(r.databases, 1);
  assert.equal(total(r), 110);
});

test("no bob at all is absent, and no bob.db is empty", async () => {
  assert.equal((await readBob(home())).state, "absent");
  const h = home();
  mkdirSync(join(h, ".bob", "db"), { recursive: true });
  assert.equal((await readBob(h)).state, "empty");
});

test("the walk is opt-in: a store that does not declare copies does not walk", async () => {
  const { storePaths, loadSources } = await import("../src/sources.mjs");
  const spec = loadSources();
  const h = home();
  mkdirSync(join(h, ".clawspring", "sessions", "daily"), { recursive: true });
  mkdirSync(join(h, "copy", ".clawspring", "sessions", "daily"), { recursive: true });
  const claw = spec.sources.find((s) => s.name === "clawspring");
  const paths = storePaths(claw.stores[0], h, spec);
  assert.ok(!paths.some((p) => p.includes(`${"copy"}/`)),
    `clawspring declares no copies_max_depth, so the copy must not be walked: ${paths}`);
});
