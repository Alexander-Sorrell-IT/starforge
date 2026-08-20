#!/usr/bin/env node
// Make each CLAIM false, and see whether anything notices.
//
// ~/reckon-exchange/CLAIMS.md lists 111 sentences these two programs state
// about themselves in the absolute — NEVER, ALWAYS, CANNOT, MUST. SIXTY-SEVEN
// OF THEM ARE IN THIS PROGRAM AND UNTIL NOW NOTHING COULD EVEN ASK. deadreckon
// has had claims_probe.py since 2026-08-20; this is its other half, and the
// first ten claims it asked about over there came back five unguarded.
//
// For each claim: a mutation that makes it FALSE, applied to a throwaway copy
// of the tree, with the suites that ought to notice run against it. A claim
// whose falsification changes nothing is UNGUARDED — the comment is the only
// thing holding it.
//
// NOT A TEST SUITE: A CENSUS. It prints what is guarded and what is not, and
// the unguarded ones are the work list.
//
//     node claims_probe.mjs              # all claims
//     node claims_probe.mjs layerlog     # only claims whose id matches
//     node claims_probe.mjs --serial     # one at a time, for debugging
//
// PARALLEL BY DEFAULT. Each claim already works in its own directory, so they
// are independent; running them one at a time was the single largest cost in
// the deadreckon census and it was all waiting, not thinking.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));

// [id, file, find, replace, suites that SHOULD notice]
const CLAIMS = [
  ["readers.mjs bob — every found store is read, not found[0]",
   "src/readers.mjs",
   '  const dbs = pr.found.map((d) => join(d, "bob.db")).filter((f) => existsSync(f));',
   '  const dbs = [join(pr.found[0], "bob.db")].filter((f) => existsSync(f));',
   ["tests/bob-locations.test.mjs"]],

  ["scan.mjs — a row with no message.id still has an identity: its uuid",
   "src/scan.mjs",
   '        : (typeof d.uuid === "string" && d.uuid ? `uuid:${d.uuid}` : null);',
   '        : null;',
   ["tests/claims-batch1.test.mjs", "tests/usage-dedup.test.mjs"]],

  ["redact.mjs — the account pseudonym never carries the address",
   "src/redact.mjs",
   '      .update(PSEUDONYM_SALT + String(identity ?? ""))',
   '      .update(String(identity ?? ""))',
   ["tests/claims-batch1.test.mjs", "tests/redact.test.mjs"]],

  // NOTE ON THIS MUTATION. It first read `replace: true` -> `replace: true ||
  // true`, which is the same value: the claim was never falsified and the
  // census dutifully reported UNGUARDED for a guard that works. A mutation
  // that does not change behaviour makes every test look absent, which is this
  // project's own signature defect wearing a census badge.
  ["fleet.mjs:770 — a real report is never clobbered by a stub",
   "src/fleet.mjs",
   "  const report = join(hrDir, \"REPORT.md\");\n  if (!existsSync(report)) {",
   "  const report = join(hrDir, \"REPORT.md\");\n  if (true) {",
   ["tests/claims-batch1.test.mjs", "tests/fleet.test.mjs"]],

  ["verify.mjs — markupStrings sees text a browser renders",
   "src/verify.mjs",
   '    .replace(/<script\\b[\\s\\S]*?<\\/script\\b[^>]*>/gi, blank)',
   '    .replace(/<script\\b[\\s\\S]*?<\\/script\\s*>/gi, blank)',
   ["tests/markup-close-tag.test.mjs"]],

  ["readers.mjs — a token count is finite, non-negative and integral",
   "src/readers.mjs",
   '  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;',
   '  return Number(v) || 0;',
   ["tests/token-count.test.mjs"]],

  ["scorecard.mjs — a signature that does not verify is rejected",
   "src/scorecard.mjs",
   "    return _verify(pubBytes, payloadBuf, sigBuf);",
   "    return true;",
   ["tests/scorecard-verify.test.mjs"]],

  ["sources.mjs — the copies walk is opt-in per store",
   "src/sources.mjs",
   "  if (!Number.isInteger(depth) || depth < 1 || !segs.length) return declared;",
   "  if (!segs.length) return declared;",
   ["tests/bob-locations.test.mjs"]],
];

// What a claim's sandbox needs. node_modules is SYMLINKED, not copied: it is
// the whole cost of the copy and nothing under test writes to it.
//
// THE DOCS ARE NOT OPTIONAL. Several suites assert that README.md and PROVE-IT
// describe what the code actually does — privacy.test.mjs checks the README's
// account of report contents — so a sandbox without them fails before any
// mutation and every claim it touches reads GUARDED for the wrong reason. This
// is the same trap that made Stryker unusable on suites reading outside the
// tree, and it is why probe() runs a BASELINE before mutating anything.
const COPY = ["src", "tests", "spec", "bin", "docs", "package.json", "knip.json",
              "README.md", "PROVE-IT.md", "MAPS.md", "PLAN.md", "ROADMAP.md",
              "LICENSE", "sonar-project.properties"];

function sandbox() {
  const d = mkdtempSync(join(tmpdir(), "claim-sr-"));
  for (const rel of COPY) {
    const from = join(ROOT, rel);
    if (existsSync(from)) cpSync(from, join(d, rel), { recursive: true });
  }
  const nm = join(ROOT, "node_modules");
  if (existsSync(nm)) { try { symlinkSync(nm, join(d, "node_modules")); } catch { /* optional */ } }
  return d;
}

function runSuites(dir, suites) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--test", ...suites],
                    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (b) => { out += b; });
    p.stderr.on("data", (b) => { out += b; });
    const timer = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 600_000);
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
    p.on("error", () => { clearTimeout(timer); resolve({ code: null, out }); });
  });
}

async function probe([id, file, find, replace, suites]) {
  const dir = sandbox();
  try {
    const p = join(dir, file);
    const before = readFileSync(p, "utf8");
    if (!before.includes(find))
      return { id, verdict: "ANCHOR MISSING", why: `\`${find.slice(0, 60)}\` is not in ${file}` };

    // BASELINE FIRST. A suite that was already failing would make every claim
    // look guarded, which is the census reporting the opposite of the truth.
    const base = await runSuites(dir, suites);
    if (base.code !== 0)
      return { id, verdict: "SUITE ALREADY RED", why: `${suites.join(" ")} fails before any mutation` };

    writeFileSync(p, before.replace(find, replace));
    const after = await runSuites(dir, suites);
    return after.code === 0
      ? { id, verdict: "UNGUARDED", why: `falsified, and ${suites.join(", ")} stayed green` }
      : { id, verdict: "GUARDED", why: `caught by ${suites.join(", ")}` };
  } catch (e) {
    return { id, verdict: "ERROR", why: e.message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const argv = process.argv.slice(2);
const serial = argv.includes("--serial");
const only = argv.filter((a) => !a.startsWith("--"))[0] ?? "";
const claims = only ? CLAIMS.filter((c) => c[0].includes(only)) : CLAIMS;

console.log(`\n  CLAIMS — ${claims.length} falsified, ${serial ? "one at a time" : `${Math.max(1, cpus().length - 2)} at a time`}\n`);
const results = await pool(claims, serial ? 1 : Math.max(1, cpus().length - 2), probe);

const MARK = { GUARDED: "GUARDED   ", UNGUARDED: "UNGUARDED ", "ANCHOR MISSING": "ANCHOR??  ",
               "SUITE ALREADY RED": "RED       ", ERROR: "ERROR     " };
for (const r of results) {
  console.log(`  ${MARK[r.verdict] ?? r.verdict}   ${r.id}`);
  console.log(`               ${r.why}`);
}
const bad = results.filter((r) => r.verdict !== "GUARDED");
console.log(`\n  ${results.length} claims, ${results.filter(r => r.verdict === "UNGUARDED").length} unguarded`
          + (bad.length !== results.filter(r => r.verdict === "UNGUARDED").length
             ? `, ${bad.length - results.filter(r => r.verdict === "UNGUARDED").length} could not be asked` : ""));
process.exit(0);
