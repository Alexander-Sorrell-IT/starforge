// @ts-nocheck
// COPY_DIRS is ONE list living in two repositories, and NOTHING compared them.
//
// src/accounts.mjs:71-82 and deadreckon's analyze_tokens.py:46-56 each carry a
// paragraph saying the two lists are the same list. They were not. They
// differed by exactly one name — this side had `token-corpus`, the other had
// `deadreckon-record` — and the missing name let starreckon's depth-4 home walk
// descend into ~/deadreckon-record, the preservation tree holding FIVE
// machines' archives: 59,131 transcript files counted as this computer's work,
// against 1,855 files in the live profiles.
//
// Both comments were then rewritten to say "it is the union now, both names in
// both programs". `grep -rln COPY_DIRS tests/` still returned NOTHING. The
// documented invariant had no test, in either repository, which is exactly the
// state it was in when it cost 59,131 files. This file is that missing test.
//
// It is in two halves on purpose:
//
//   1. THE PIN (always runs, anywhere). starreckon's live COPY_DIRS must equal
//      the list written out below. A stranger's checkout has no deadreckon
//      beside it, so this is the only half that can hold there — and it holds
//      the right thing: an edit to accounts.mjs alone fails here, and the
//      failure message is the instruction to go and edit the other program.
//
//   2. THE LIVE COMPARISON (runs when a deadreckon checkout is reachable).
//      Parses analyze_tokens.py's literal and demands set equality. The pin
//      catches a one-sided edit; only this catches the two lists having been
//      allowed to drift apart before either pin was written.
//
// Half 2 skips when deadreckon is not on the machine. That is a real hole and
// it is named rather than hidden: a skipped test prints `# skip` in the summary
// and half 1 still fails on any one-sided edit. The counterpart pin belongs in
// deadreckon's own suite, which is where a stranger's copy of THAT program gets
// the same protection — the same split tests/conformance.test.mjs already uses
// for EXPECTED.json ("two repositories cannot see each other's checkouts, so
// each pins the digest it was built against").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COPY_DIRS } from "../src/accounts.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// The union, pinned. Changing this list is the deliberate act: whoever changes
// it must change deadreckon's analyze_tokens.COPY_DIRS in the same edit, or the
// live comparison below fails on any machine that has both checked out.
//
// The three repository names are the reason this list keeps moving. The
// programs were renamed and there are now THREE of them, not two:
// deadreckon-count (the numbers), deadreckon-record (the redacted corpus,
// formerly token-corpus — both spellings are kept because an old checkout on
// disk still answers to the old name), and deadreckon-transcripts, whose README
// says it holds "Raw AI CLI transcripts from every machine in the fleet" via
// git LFS. deadreckon-transcripts was in NEITHER list. It holds 0 .jsonl on
// this machine today — the LFS pointers have not been pulled — so it has cost
// nothing yet, which is the only reason adding it was cheap instead of another
// 59,131 files.
const PINNED = [
  "corpus",
  "merged",
  "token-corpus",
  "deadreckon-record",
  "deadreckon-transcripts",
  "node_modules",
  ".git",
  "archive",
  "snap",
  ".cache",
  ".local",
  "venv",
  ".venv",
].sort();

// Names pulled out of a `NAME = <bracket> … <bracket>` literal in source text.
//
// FAILS rather than returning an empty set when it matches nothing. An empty
// set compares equal to another empty set, so a parser that has quietly stopped
// seeing the literal — a reformat, a rename, a move to another file — would
// turn this whole file into two empty sets agreeing with each other. That
// failure mode (absent looking exactly like zero) is the one this project keeps
// re-committing; it does not get to happen here.
function literalNames(text, where, decl, open, close) {
  const at = text.indexOf(decl);
  assert.ok(at >= 0,
    `${where}: no \`${decl}\` found. The declaration was renamed, reformatted `
    + `or moved — fix this parser, do NOT let it return nothing, because `
    + `nothing compares equal to nothing and this test would go green while `
    + `the two lists drifted apart.`);
  const from = text.indexOf(open, at);
  const to = from < 0 ? -1 : text.indexOf(close, from);
  assert.ok(from >= 0 && to > from,
    `${where}: found \`${decl}\` but no ${open}…${close} literal after it.`);
  const names = [...text.slice(from + open.length, to).matchAll(/"([^"]*)"/g)]
    .map((m) => m[1]);
  assert.ok(names.length > 0,
    `${where}: the ${open}…${close} after \`${decl}\` held no quoted names.`);
  return new Set(names);
}

const sorted = (s) => [...s].sort();

test("starreckon's COPY_DIRS is exactly the pinned union", () => {
  assert.deepEqual(sorted(COPY_DIRS), PINNED,
    "src/accounts.mjs COPY_DIRS no longer matches the list pinned in this "
    + "test. If the change is deliberate: make the SAME change to deadreckon's "
    + "analyze_tokens.COPY_DIRS, then update PINNED here. The two lists are "
    + "documented as one list; the last time they were not, this scan walked "
    + "59,131 of another machine's transcripts.");
});

// Guards the parser used on the Python side by running it against a literal
// whose true value is imported above. If this passes and the cross-repo test
// fails, the lists really differ; if this fails, the parser is broken and the
// cross-repo verdict means nothing either way.
test("the literal parser reads accounts.mjs's real COPY_DIRS", () => {
  const parsed = literalNames(
    readFileSync(join(ROOT, "src", "accounts.mjs"), "utf8"),
    "src/accounts.mjs", "COPY_DIRS = new Set(", "[", "]");
  assert.deepEqual(sorted(parsed), sorted(COPY_DIRS),
    "the parser and the imported Set disagree about accounts.mjs — the parser "
    + "is reading the wrong literal, so its reading of analyze_tokens.py "
    + "cannot be trusted either.");
});

// Where a deadreckon checkout might be. DEADRECKON_REPO first so this can be
// pointed at a worktree; then the home-directory clone, which is where it lives
// on this fleet; then a sibling of this checkout.
function findAnalyzeTokens() {
  const cands = [
    process.env.DEADRECKON_REPO,
    join(homedir(), "deadreckon-count"),
    resolve(ROOT, "..", "deadreckon-count"),
    resolve(ROOT, "..", "..", "deadreckon-count"),
  ].filter(Boolean);
  for (const dir of cands) {
    const p = join(dir, "analyze_tokens.py");
    if (existsSync(p)) return p;
  }
  return null;
}

test("starreckon and deadreckon carry the SAME COPY_DIRS", (t) => {
  const py = findAnalyzeTokens();
  if (!py) {
    t.skip("no deadreckon checkout reachable (set DEADRECKON_REPO to compare). "
      + "The pin above still holds this side to the agreed list.");
    return;
  }
  const theirs = literalNames(readFileSync(py, "utf8"), py,
    "COPY_DIRS = {", "{", "}");
  const mine = sorted(COPY_DIRS);
  assert.deepEqual(sorted(theirs), mine,
    `${py} and src/accounts.mjs disagree about COPY_DIRS.\n`
    + `  only in deadreckon: ${sorted(theirs).filter((n) => !COPY_DIRS.has(n))}\n`
    + `  only in starreckon: ${mine.filter((n) => !theirs.has(n))}\n`
    + "Both files' comments say these are one list. A name either program "
    + "knows about is a copy tree, so the fix is the union in both — never "
    + "deleting a name from one to make this pass.");
});
