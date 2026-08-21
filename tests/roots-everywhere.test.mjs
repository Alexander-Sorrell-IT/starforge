// Every path that scans, indexes or serves must resolve roots THE SAME WAY.
//
// `search` — the Cisco SecureBERT layer — read the raw `--roots` flag while
// scoreboard, serve and the scan itself all called effectiveRoots(). So a
// machine with extra_roots configured COUNTED those sessions and could never
// SEARCH them: the index and the total described different machines, and
// nothing said so. A search returning no hit for a session that exists reads
// exactly like a session that does not exist.
//
// This is the same defect as bob's nine unread databases, one layer up: the
// count and the discovery disagreed about where to look.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveRoots } from "../src/config.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.mjs");

test("no command resolves roots from the raw flag alone", () => {
  const src = readFileSync(CLI, "utf8").split("\n");
  const raw = [];
  src.forEach((line, i) => {
    // `const <something>roots = opt("roots")...` with no effectiveRoots on it.
    if (/const\s+\w*[Rr]oots?(List)?\s*=\s*opt\("roots"\)/.test(line)
        && !line.includes("effectiveRoots")
        // The line that FEEDS effectiveRoots is fine: it is the argument.
        && !src[i].includes("Roots(")) {
      raw.push(`cli.mjs:${i + 1}  ${line.trim().slice(0, 72)}`);
    }
  });
  assert.deepEqual(raw, [],
    "these resolve roots without the user's configured extra_roots, so they "
    + "look at a different machine than the scan does");
});

test("effectiveRoots adds the configured roots to whatever was passed", () => {
  const home = mkdtempSync(join(tmpdir(), "roots-"));
  mkdirSync(join(home, ".starreckon"), { recursive: true });
  writeFileSync(join(home, ".starreckon", "config.json"),
    JSON.stringify({ extra_roots: ["/other/home", "/third/home"] }));
  const got = effectiveRoots([], home);
  assert.ok(got.includes("/other/home"), `${JSON.stringify(got)} lost a configured root`);
  assert.ok(got.includes("/third/home"));
  assert.ok(got.includes(home), "the machine's own home must still be scanned");
});

test("an explicit --roots does not silently drop the configured ones", () => {
  // ADDITIVE, and config.mjs's header says so: "Optional and additive: the
  // local file scan ALWAYS runs". Someone passing --roots for one extra
  // directory must not lose the two they configured permanently.
  const home = mkdtempSync(join(tmpdir(), "roots2-"));
  mkdirSync(join(home, ".starreckon"), { recursive: true });
  writeFileSync(join(home, ".starreckon", "config.json"),
    JSON.stringify({ extra_roots: ["/configured"] }));
  const got = effectiveRoots(["/from-the-flag"], home);
  assert.ok(got.includes("/from-the-flag"));
  assert.ok(got.includes("/configured"),
    "passing --roots dropped the permanently configured roots");
});

test("no config means the home directory, and nothing missing", () => {
  const home = mkdtempSync(join(tmpdir(), "roots3-"));
  assert.deepEqual(effectiveRoots([], home), [home]);
});
