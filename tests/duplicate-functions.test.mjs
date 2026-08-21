// One name, two implementations, and nobody comparing them.
//
// Found by CROSS-REFERENCING two tools, not by either alone: mutation scored
// scan.mjs's computeStreaks at 0.0% across 36 mutants, and the reason nothing
// killed them is that tests/profile.test.mjs imports a computeStreaks from
// profile.mjs — a DIFFERENT function of the same name. The tests exercise one
// copy and the scan runs the other.
//
// The two had already drifted. Same machine, same data, two answers to "what is
// my current streak":
//
//   worked today and yesterday          scan 2   profile 2
//   worked YESTERDAY, not today         scan 2   profile 0
//   three days ending yesterday         scan 3   profile 0
//
// profile.mjs walks back from TODAY and returns 0 the moment today is not
// active; scan.mjs counts the run ending at the LAST ACTIVE DAY and only zeroes
// it if that was more than one day ago. Both are defensible products. Having
// both is not, and which one is right is the author's call.
//
// This test does not make that call. It asserts the CLASS: a name implemented
// twice must either be byte-identical, or be listed below with a reason. A
// duplicate that drifts silently is how the two answers happened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

// name -> why two implementations are allowed to differ.
const ALLOWED = {
  // Different signatures and different jobs; the shared name is a coincidence.
  temporal: "different signatures — temporal(stats, ts) vs temporal(col, src, ts)",

  // KNOWN OPEN, awaiting a ruling on which streak semantic is correct.
  // Delete this entry when one implementation is removed.
  computeStreaks: "DRIFTED — scan.mjs allows a streak to end yesterday, "
                + "profile.mjs requires today. Awaiting a ruling; see the header.",

  // OPEN QUESTION, recorded rather than fixed here. accounts.mjs's
  // listJsonl(root) does NOT sort its readdirSync; scan.mjs's
  // listJsonl(base, maxDepth) does. Unsorted means filesystem order, which is
  // what byCountThenKey exists in scan.mjs to prevent — "two machines with the
  // same corpus could disagree". Whether the order reaches a published number
  // through accounts.mjs has not been established.
  listJsonl: "different signatures; accounts.mjs does not sort its walk — OPEN",

  // Two answers to "can this machine confine a process", and the egress proof
  // rests on that answer. audit.mjs records what the run could do; confine.mjs
  // decides what it will do. Worth one of them calling the other — OPEN.
  detectConfinement: "audit.mjs records, confine.mjs decides — OPEN",

  // Genuinely different domains that share a short name.
  survey: "addons.mjs surveys optional layers; sources.mjs surveys stores",
  walk: "discover.mjs walks for stores; receipt.mjs walks a receipt tree",
  openSocket: "beacon.mjs opens a TCP probe; mdns.mjs opens a UDP multicast socket",
  esc: "daemon.mjs escapes for a plist; statspage.mjs escapes for HTML",
  readJson: "fleet.mjs guards a null path first; readers.mjs does not take one",
  lanIp: "mdns.mjs picks a multicast-capable interface; serve.mjs picks a servable one",

  // LATENT, NOT LIVE — and the distinction was checked, not assumed.
  // statspage.mjs's human returns NULL for an absent value; wrapped.mjs's does
  // `Number(n) || 0`, so null, undefined and NaN all render as "0" — absent
  // looking exactly like zero, on the card people SHARE. It also has no
  // trillion tier (1.5e12 reads "1500.0B") and prints "InfinityB".
  //
  // Every wrapped.mjs call site read so far guards first — the floor block
  // returns null unless floor and onDisk are both positive — so no absent value
  // reaches it today. That is a property of the CALLERS, not of the function,
  // and it is one refactor away from not being true.
  human: "statspage.mjs returns null for absent; wrapped.mjs returns 0. Latent "
       + "— callers guard today. See tests/human-format.test.mjs",
};

function bodies() {
  const found = new Map();
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".mjs"))) {
    const text = readFileSync(join(SRC, f), "utf8");
    const re = /^(?:export )?(?:async )?function (\w+)\(/gm;
    let m;
    while ((m = re.exec(text))) {
      const end = text.indexOf("\n}", m.index);
      if (end < 0) continue;
      const body = text.slice(m.index, end + 2);
      // COMPARE WHAT IT DOES, NOT HOW IT IS TYPED. The first version compared
      // raw bytes and flagged isDir and isFile as divergent across three files
      // — they are identical apart from being written on one line in two of
      // them and three lines in the third. A comparison on the wrong thing
      // reports differences that are not there, which is how a real one gets
      // lost in the noise.
      const norm = body.replace(/\/\/[^\n]*/g, " ").replace(/\s+/g, " ").trim();
      if (!found.has(m[1])) found.set(m[1], []);
      found.get(m[1]).push({ file: f, body, norm });
    }
  }
  return found;
}

test("a function implemented twice is identical, or listed with a reason", () => {
  const problems = [];
  for (const [name, impls] of bodies()) {
    if (impls.length < 2) continue;
    const same = impls.every((i) => i.norm === impls[0].norm);
    if (same || ALLOWED[name]) continue;
    problems.push(`${name}: ${impls.map((i) => `${i.file} (${i.body.length}b)`).join(" vs ")}`);
  }
  assert.deepEqual(problems, [],
    "these names have two DIFFERENT implementations and no recorded reason — "
    + "one will be fixed and the other will not");
});

test("an identical duplicate stays identical", () => {
  // activeDurationMs is byte-identical in scan.mjs and profile.mjs, 470 bytes,
  // each with its own MAX_ACTIVE_GAP_MIN = 15. Fix one and the scan and the
  // profile disagree about how long a session lasted.
  const impls = bodies().get("activeDurationMs") ?? [];
  assert.equal(impls.length, 2, "activeDurationMs no longer has exactly two copies");
  assert.equal(impls[0].norm, impls[1].norm,
    "the two copies of activeDurationMs have drifted apart");
});

test("every ALLOWED entry still names a real duplicate", () => {
  // An exemption for a duplicate that no longer exists is an exemption nobody
  // will notice going stale — and the next real duplicate of that name walks in
  // under it.
  for (const name of Object.keys(ALLOWED)) {
    const impls = bodies().get(name) ?? [];
    assert.ok(impls.length >= 2,
      `${name} is exempted as a duplicate and now has ${impls.length} implementation(s) — `
      + "remove the exemption");
  }
});
