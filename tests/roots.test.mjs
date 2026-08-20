// Every root, and each session once.
//
// scanPortedReaders read roots[0] and `break`ed, under a comment claiming extra
// roots were "merged by the caller". They were not: the caller merges what it
// is handed, and it was handed one root's worth. So `--roots=a,b` counted the
// five ported readers (claude-orphans, clawspring, lmstudio, bob, copilot-chat)
// and `history` from ONE root and said nothing about the rest — a smaller
// number with no line explaining it, which is this project's signature defect.
//
// Found by SonarQube's "invalid loop: its body allows only one iteration", the
// one rule in that run that pointed at structure rather than style.
//
// The opposite defect is equally real and this project has already paid for it:
// summing roots blindly counted four copied profiles as four machines' work,
// 37,196,921,021 against a true 11,414,194,297. So the third case below is not
// decoration — the same root named twice must not double.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanPortedReaders } from "../src/scanners.mjs";

function rootWith(tag, tokens) {
  const home = mkdtempSync(join(tmpdir(), "sr-roots-"));
  const dir = join(home, ".clawspring", "sessions", "daily", "2026-01-01");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `session_${tag}.json`), JSON.stringify({
    session_id: tag,
    total_input_tokens: tokens,
    total_output_tokens: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:10:00Z",
  }));
  return home;
}

const opts = () => ({ knownClaudeIds: new Set() });
const claw = (r) => r.providers.clawspring;
const rows = (r) => r.perSession.filter((x) => x.provider === "clawspring").length;

test("a second root is read, not skipped", async () => {
  const a = rootWith("a", 1000);
  const b = rootWith("b", 2000);
  const one = await scanPortedReaders([a], opts());
  const both = await scanPortedReaders([a, b], opts());

  assert.equal(claw(one).input, 1000, "the single-root case is the control and must hold first");
  assert.equal(claw(both).sessions, 2,
    "the second root's session is missing — the reader stopped at roots[0]");
  assert.equal(claw(both).input, 3000,
    "the second root's tokens are missing: 1000 means only the first root was read");
});

test("the same session under two roots is one session", async () => {
  const a = rootWith("a", 1000);
  const both = await scanPortedReaders([a, a], opts());
  assert.equal(claw(both).sessions, 1, "one root named twice counted as two sessions");
  assert.equal(claw(both).input, 1000,
    "2000 means roots are summed blindly — a copied profile would double the fleet total");
});

test("the row and the per-session list agree about what was counted", async () => {
  const a = rootWith("a", 1000);
  const b = rootWith("b", 2000);
  const r = await scanPortedReaders([a, b], opts());
  // Two views of one map: a row that says 2 while the list holds 1 is how a
  // total comes to disagree with the records it was built from.
  assert.equal(claw(r).sessions, rows(r),
    "the provider row and perSession disagree about how many sessions there are");
  const listed = r.perSession
    .filter((x) => x.provider === "clawspring")
    .reduce((n, x) => n + x.input, 0);
  assert.equal(claw(r).input, listed, "the row's tokens are not the sum of the rows it published");
});
