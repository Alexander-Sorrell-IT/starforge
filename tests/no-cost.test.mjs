// This tool reports USAGE. It does not price your work.
//
// It used to. A retail estimate from an assumed per-Mtok table was printed on
// the tokens card, written into every JSON report as `retail_cost_usd`, and
// tiled on the HTML page — all labelled "assumed", which changes nothing: a
// number with a dollar sign on it gets quoted as a price. On this corpus it read
// ~$36,621, and that figure travelled into a document intended to be sent.
//
// It is wrong at the root, not just imprecise. The same model bills differently
// depending on the route it was reached through — direct, through Copilot,
// through another provider — so one table cannot be right for a single person,
// let alone across five machines. And a tool that makes no network calls cannot
// know what changed since the table was written.
//
// Tokens are a fact the API returned. The price of them is somebody else's
// number. These tests exist so it cannot come back by accident.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, "src");

// A currency FIGURE: "$1,234", "$34,191", "~$36,621", "$33.75". Deliberately
// not `\$\d+`, which matches a regex backreference — `"$1***@"` inside
// verify.mjs's email masker is not a price, and a check that flags it would get
// itself deleted. So: a thousands group, or cents, or three-plus digits.
const MONEY = /\$\s?\d{1,3}(?:,\d{3})+|\$\s?\d+\.\d{2}\b|\$\s?\d{3,}/;

test("no shipped module can produce a currency figure", () => {
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".mjs"))) {
    const src = readFileSync(join(SRC, f), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    assert.doesNotMatch(src, MONEY, `${f} builds a dollar figure — this tool reports usage, not cost`);
  }
});

test("the rate tables and the estimator are gone, not merely unused", () => {
  // Dead code is a standing invitation to re-enable it.
  for (const f of readdirSync(SRC).filter((n) => n.endsWith(".mjs"))) {
    const src = readFileSync(join(SRC, f), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    for (const banned of ["RETAIL_RATES", "DEFAULT_RATES", "estimateCost", "rateForModel", "retail_cost_usd"])
      assert.ok(!src.includes(banned), `${f} still carries ${banned}`);
  }
});

test("--rates is not a flag any more, and is refused rather than ignored", () => {
  // An unregistered flag must EXIT 2. Silently ignoring it would let someone
  // believe they had set rates that no longer exist.
  const r = spawnSync(process.execPath, [join(ROOT, "src", "cli.mjs"), "--yes", "--rates=1,2,3"], {
    encoding: "utf8",
    env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "sf-nc-")), NO_COLOR: "1" },
  });
  assert.equal(r.status, 2, `--rates must exit 2, got ${r.status}`);
  assert.match(r.stderr + r.stdout, /rates/, "and should name the flag it refused");
});

test("a full run prints no price, and says why", () => {
  const home = mkdtempSync(join(tmpdir(), "sf-nc-"));
  const dir = join(home, ".claude", "projects", "-w-a");
  mkdirSync(dir, { recursive: true });
  const rows = [];
  for (let d = 0; d < 4; d++) {
    const ts = `2026-07-1${d}T15:00:00.000Z`;
    rows.push(JSON.stringify({ type: "user", cwd: "/w/a", timestamp: ts, uuid: `u${d}`,
      message: { role: "user", content: "a prompt long enough to be counted" } }));
    rows.push(JSON.stringify({ type: "assistant", timestamp: ts, uuid: `m${d}`,
      message: { role: "assistant", id: `msg${d}`, model: "claude-opus-5",
        content: [{ type: "tool_use", name: "Bash", input: { file_path: "/w/a/x.py" } }],
        usage: { input_tokens: 5e6, output_tokens: 2e5, cache_read_input_tokens: 9e6, cache_creation_input_tokens: 1e5 } } }));
  }
  writeFileSync(join(dir, "s.jsonl"), rows.join("\n"));

  const r = spawnSync(process.execPath,
    [join(ROOT, "src", "cli.mjs"), "--yes", "--no-pace", "--json", "--profile"],
    { encoding: "utf8", env: { ...process.env, HOME: home, TZ: "America/Chicago", NO_COLOR: "1" } });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, MONEY, "a price reached the terminal");
  assert.match(r.stdout, /usage, not cost/, "the tokens card should say what it is refusing to do");

  // And nothing written to disk carries one either — the reports are the part
  // that gets attached to things.
  const reports = join(home, ".starreckon", "reports");
  for (const f of readdirSync(reports)) {
    const body = readFileSync(join(reports, f), "utf8");
    assert.doesNotMatch(body, MONEY, `${f} contains a currency figure`);
    assert.ok(!body.includes("retail_cost_usd"), `${f} still has retail_cost_usd`);
  }
});

test("the README does not advertise a cost estimate", () => {
  const md = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.ok(!md.includes("--rates"), "README still documents the --rates flag");
});
