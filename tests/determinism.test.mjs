// Same bytes in, same bytes out.
//
// This is load-bearing for a tool whose argument is "do not trust me, check
// it". A number you cannot reproduce is not checkable, and two machines
// holding an identical corpus publishing different reports would end the
// argument on the spot.
//
// Two things used to leak filesystem order into the output:
//
//   1. listJsonl() called readdirSync() unsorted, and a session's project label
//      is taken from the FIRST cwd seen — so which project a session belonged
//      to depended on the order the OS happened to return names in.
//   2. every `sort((a,b) => b[1]-a[1])` is stable, so equal counts stayed in
//      insertion order — which was, again, filesystem order.
//
// Neither changed a total. Both changed what got PUBLISHED.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { byCountThenKey, discoverSources } from "../src/scan.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const tmp = () => mkdtempSync(join(tmpdir(), "sf-det-"));

// A corpus with deliberate TIES — three tools used the same number of times,
// three projects with the same session count. Ties are where insertion order
// becomes visible; a corpus without them cannot detect this class of bug.
function corpus(home, order = "abc") {
  const base = join(home, ".claude", "projects");
  const files = {
    a: { proj: "alpha", tools: ["Bash", "Read", "Edit"] },
    b: { proj: "bravo", tools: ["Read", "Edit", "Bash"] },
    c: { proj: "charlie", tools: ["Edit", "Bash", "Read"] },
  };
  for (const key of order) {
    const { proj, tools } = files[key];
    const dir = join(base, `-w-${proj}`);
    mkdirSync(dir, { recursive: true });
    const rows = [];
    const ts = `2026-03-0${order.indexOf(key) + 1}T14:00:00.000Z`;
    rows.push({ type: "user", cwd: `/w/${proj}`, timestamp: ts, uuid: `u-${key}`,
      message: { role: "user", content: "hi" } });
    rows.push({ type: "assistant", timestamp: ts, uuid: `a-${key}`,
      message: { role: "assistant", model: "claude-opus-5",
        content: tools.map((t) => ({ type: "tool_use", name: t })),
        usage: { input_tokens: 10, output_tokens: 5,
          cache_read_input_tokens: 1, cache_creation_input_tokens: 1 } } });
    writeFileSync(join(dir, `${key}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n"));
  }
  return home;
}

function scan(home) {
  const r = spawnSync(process.execPath, [join(ROOT, "src", "cli.mjs"), "--yes", "--no-pace", "--json"],
    { encoding: "utf8", env: { ...process.env, HOME: home, NO_COLOR: "1" } });
  const dir = join(home, ".starreckon", "reports");
  const f = readdirSync(dir).find((n) => n.startsWith("expanded-"));
  assert.ok(f, `no report written: ${r.stdout}${r.stderr}`);
  const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
  // Timestamps are the ONE thing allowed to differ between two runs.
  delete d.generated_at;
  delete d.scanned_at;
  if (d.profile) delete d.profile.generated_at;
  return d;
}

test("byCountThenKey is a total order — equal counts never tie", () => {
  const rows = [["zeta", 5], ["alpha", 5], ["mid", 9], ["beta", 5]];
  const once = [...rows].sort(byCountThenKey);
  const again = [...rows].reverse().sort(byCountThenKey);
  assert.deepEqual(once, again, "the same multiset must sort the same way from any start order");
  assert.deepEqual(once.map((r) => r[0]), ["mid", "alpha", "beta", "zeta"]);
});

test("discovery order is sorted on whatever filesystem it lands on", () => {
  // Two assertions, and the second one is a SOURCE assertion on purpose.
  //
  // Behavioural first: on this machine discovery does come back sorted.
  const home = corpus(tmp(), "cba");
  const paths = discoverSources([home]).map((f) => f.path);
  assert.ok(paths.length >= 3, `expected the fixture files, got ${paths.length}`);
  assert.deepEqual(paths, [...paths].sort(), "discovery order must be sorted");

  // That assertion alone is NOT enough, and saying so is the point. Deleting
  // the `.sort()` from listJsonl() leaves every test in this file green here,
  // because the filesystem under CI returns directories in name order already
  // — creating zulu/mike/alpha/delta and reading them back gives
  // alpha/delta/mike/zulu. POSIX promises no such thing; ext4 with htree
  // enabled returns hash order, and APFS and NFS each differ again. So the
  // machine that can expose this bug is not the machine that runs the tests,
  // and a green suite here would be evidence of nothing.
  //
  // Pinning the source is the only honest guard available: it cannot prove the
  // ORDER is right, but it does prove the line that guarantees it is still
  // there — which is the thing a refactor would quietly drop.
  const src = readFileSync(join(ROOT, "src", "scan.mjs"), "utf8");
  assert.match(
    src,
    /readdirSync\(dir\)\.sort\(\)/,
    "listJsonl must sort its directory read — without it, scan order is filesystem order"
  );
});

test("two scans of the same corpus produce byte-identical reports", () => {
  const a = scan(corpus(tmp()));
  const b = scan(corpus(tmp()));
  assert.equal(JSON.stringify(a), JSON.stringify(b), "same input must give the same report");
});

test("the report does not depend on the order the filesystem returns files", () => {
  // The same three sessions, created in two different orders. Before the sort
  // in listJsonl() this changed which project won a label and how ties broke.
  const a = scan(corpus(tmp(), "abc"));
  const b = scan(corpus(tmp(), "cba"));
  assert.deepEqual(a.tool_call_counts, b.tool_call_counts, "tied tool counts must not reorder");
  assert.deepEqual(a.projects, b.projects, "tied project lists must not reorder");
  assert.deepEqual(a.star_levels, b.star_levels, "the star must not depend on scan order");
  assert.equal(a.total_sessions, b.total_sessions);
});

test("a renamed file does not change the report, only its position on disk", () => {
  // Renaming reorders the directory without changing a single byte of content.
  const home = corpus(tmp());
  const before = scan(home);
  const dir = join(home, ".claude", "projects", "-w-alpha");
  renameSync(join(dir, "a.jsonl"), join(dir, "zzz.jsonl"));
  const after = scan(home);
  assert.deepEqual(after.tool_call_counts, before.tool_call_counts);
  assert.deepEqual(after.star_levels, before.star_levels);
  assert.equal(after.total_sessions, before.total_sessions);
});
