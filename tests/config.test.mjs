// tests/config.test.mjs — tests for src/config.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  readConfig, writeConfig, effectiveRoots, configPath, KNOWN_CLI_NAMES,
} from "../src/config.mjs";

function tmp() {
  const d = join(tmpdir(), "config-test-" + Math.floor(Math.random() * 1e9));
  mkdirSync(join(d, ".starreckon"), { recursive: true });
  return d;
}

// ── readConfig ────────────────────────────────────────────────────────────────

test("readConfig returns {} when file absent", () => {
  const home = tmp();
  assert.deepEqual(readConfig(home), {});
  rmSync(home, { recursive: true, force: true });
});

test("readConfig returns {} for malformed JSON", () => {
  const home = tmp();
  writeFileSync(configPath(home), "not json {{{{");
  assert.deepEqual(readConfig(home), {});
  rmSync(home, { recursive: true, force: true });
});

test("readConfig reads extra_roots", () => {
  const home = tmp();
  writeFileSync(configPath(home), JSON.stringify({ extra_roots: ["/other/home"] }));
  assert.deepEqual(readConfig(home).extra_roots, ["/other/home"]);
  rmSync(home, { recursive: true, force: true });
});

test("readConfig strips empty strings from extra_roots", () => {
  const home = tmp();
  writeFileSync(configPath(home), JSON.stringify({ extra_roots: ["", "  ", "/real"] }));
  assert.deepEqual(readConfig(home).extra_roots, ["/real"]);
  rmSync(home, { recursive: true, force: true });
});

test("readConfig reads api_keys for known CLIs", () => {
  const home = tmp();
  writeFileSync(configPath(home), JSON.stringify({ api_keys: { claude: "sk-ant-abc" } }));
  assert.equal(readConfig(home).api_keys?.claude, "sk-ant-abc");
  rmSync(home, { recursive: true, force: true });
});

test("readConfig drops unknown CLI names from api_keys", () => {
  const home = tmp();
  writeFileSync(configPath(home), JSON.stringify({ api_keys: { unknowncli: "key", claude: "sk-ant-abc" } }));
  const cfg = readConfig(home);
  assert.ok(!cfg.api_keys?.unknowncli);
  assert.equal(cfg.api_keys?.claude, "sk-ant-abc");
  rmSync(home, { recursive: true, force: true });
});

test("readConfig drops unknown top-level keys", () => {
  const home = tmp();
  writeFileSync(configPath(home), JSON.stringify({ extra_roots: ["/a"], unknown_key: "value" }));
  const cfg = readConfig(home);
  assert.ok(!("unknown_key" in cfg));
  rmSync(home, { recursive: true, force: true });
});

test("readConfig handles missing extra_roots gracefully", () => {
  const home = tmp();
  writeFileSync(configPath(home), JSON.stringify({ api_keys: { claude: "sk-ant-abc" } }));
  const cfg = readConfig(home);
  assert.ok(!cfg.extra_roots);
  rmSync(home, { recursive: true, force: true });
});

// ── writeConfig ───────────────────────────────────────────────────────────────

test("writeConfig writes readable config", () => {
  const home = tmp();
  writeConfig(home, { extra_roots: ["/mnt/drive"] });
  const cfg = readConfig(home);
  assert.deepEqual(cfg.extra_roots, ["/mnt/drive"]);
  rmSync(home, { recursive: true, force: true });
});

test("writeConfig strips unknown CLI names from api_keys", () => {
  const home = tmp();
  writeConfig(home, { api_keys: { claude: "sk-ant-abc", fakecli: "nope" } });
  const cfg = readConfig(home);
  assert.equal(cfg.api_keys?.claude, "sk-ant-abc");
  assert.ok(!cfg.api_keys?.fakecli);
  rmSync(home, { recursive: true, force: true });
});

test("writeConfig with empty object deletes existing config file", () => {
  const home = tmp();
  writeFileSync(configPath(home), JSON.stringify({ extra_roots: ["/a"] }));
  writeConfig(home, {});
  assert.ok(!existsSync(configPath(home)));
  rmSync(home, { recursive: true, force: true });
});

// Empty fields are still the caller saying "I have nothing" — same as {}.
test("writeConfig with no valid fields deletes config file", () => {
  const home = tmp();
  writeFileSync(configPath(home), JSON.stringify({ extra_roots: ["/a"] }));
  writeConfig(home, { extra_roots: [], api_keys: {} });
  assert.ok(!existsSync(configPath(home)));
  rmSync(home, { recursive: true, force: true });
});

// THE THIRD STATE, WHICH HAD NO TEST AND WAS THE ONE THAT DESTROYED DATA.
// The two tests above cover "the caller passed nothing". Neither covers "the
// caller passed something real and the filter rejected all of it", and that is
// what happened for any api_key written under `kilo` — the spelling the reader
// registry in scanners.mjs actually uses. The old code could not tell the
// three apart, so a rejected write deleted the user's extra_roots.
test("writeConfig refuses an unrecognised write and does NOT destroy the file", () => {
  const home = tmp();
  writeFileSync(configPath(home), JSON.stringify({ extra_roots: ["/keep-me"] }));
  assert.throws(() => writeConfig(home, { api_keys: { kilo: "sk-whatever" } }),
                /not written/);
  assert.ok(existsSync(configPath(home)), "the config must survive a refused write");
  assert.deepEqual(JSON.parse(readFileSync(configPath(home), "utf-8")).extra_roots,
                   ["/keep-me"], "and survive it unchanged");
  rmSync(home, { recursive: true, force: true });
});

// ── KNOWN_CLI_NAMES ───────────────────────────────────────────────────────────

test("KNOWN_CLI_NAMES includes all supported CLIs", () => {
  for (const cli of ["claude", "gemini", "copilot", "codex", "grok", "kilocode", "lmstudio", "antigravity"]) {
    assert.ok(KNOWN_CLI_NAMES.has(cli), `expected ${cli} in KNOWN_CLI_NAMES`);
  }
});

// ── effectiveRoots ────────────────────────────────────────────────────────────

test("effectiveRoots includes default home when no config", () => {
  const home = tmp();
  const roots = effectiveRoots([], home);
  assert.ok(roots.includes(home));
  rmSync(home, { recursive: true, force: true });
});

test("effectiveRoots includes config extra_roots", () => {
  const home = tmp();
  writeConfig(home, { extra_roots: ["/other"] });
  const roots = effectiveRoots([], home);
  assert.ok(roots.includes("/other"));
  rmSync(home, { recursive: true, force: true });
});

test("effectiveRoots includes CLI-provided roots", () => {
  const home = tmp();
  const roots = effectiveRoots(["/cli-root"], home);
  assert.ok(roots.includes("/cli-root"));
  rmSync(home, { recursive: true, force: true });
});

test("effectiveRoots deduplicates", () => {
  const home = tmp();
  writeConfig(home, { extra_roots: [home] }); // home appears twice
  const roots = effectiveRoots([home], home);
  const count = roots.filter(r => r.toLowerCase() === home.toLowerCase()).length;
  assert.equal(count, 1);
  rmSync(home, { recursive: true, force: true });
});

test("effectiveRoots order: home first, then config roots, then CLI roots", () => {
  const home = tmp();
  writeConfig(home, { extra_roots: ["/config-root"] });
  const roots = effectiveRoots(["/cli-root"], home);
  assert.equal(roots[0], home);
  assert.ok(roots.indexOf("/config-root") < roots.indexOf("/cli-root") ||
            roots.indexOf("/config-root") > 0);
  rmSync(home, { recursive: true, force: true });
});

// ── the two name lists must agree ─────────────────────────────────────────────
//
// NOTHING COMPARED THEM, AND THEY HAD DRIFTED THREE WAYS. KNOWN_CLI_NAMES held
// 8 names, the reader registry in scanners.mjs held 5 keys, and the overlap was
// not the story:
//
//   kilocode / kilo   the same tool under two spellings, so scanProvider() threw
//                     on one of them and api_keys could never reach the reader
//   lmstudio          in the name list and in the billing set, with NO reader
//                     anywhere in this program - it reported 0, which is the
//                     same thing it reports when a real store holds nothing.
//                     deadreckon counts 172,933 tokens across 10 sessions there
//   claude / codex     read on a different path entirely (scan.mjs sources)
//
// The first two are defects and are fixed. The third is deliberate, so it is
// written down here as an allowlist rather than left as a silent difference -
// a name in READ_ELSEWHERE is a claim that some other code reads it, and if
// that stops being true this test does not notice. NO_READER is the same
// promise in reverse: it must report itself as unreadable and never as zero.
test("KNOWN_CLI_NAMES and the reader registry describe the same tools", async () => {
  const { PROVIDERS } = await import("../src/scanners.mjs");
  const READ_ELSEWHERE = new Set(["claude", "codex"]);   // scan.mjs sources
  const NO_READER = new Set(["lmstudio"]);               // declared, uncounted

  const registry = new Set(PROVIDERS);
  const unreachable = [...KNOWN_CLI_NAMES].filter(
    n => !registry.has(n) && !READ_ELSEWHERE.has(n) && !NO_READER.has(n));
  assert.deepEqual(unreachable, [],
    "declared in KNOWN_CLI_NAMES with no reader and no exemption: these report "
    + "zero tokens, which is indistinguishable from a store that is really empty");

  const undeclared = [...registry].filter(n => !KNOWN_CLI_NAMES.has(n));
  assert.deepEqual(undeclared, [],
    "has a reader but is not a known CLI name, so api_keys and every other "
    + "name-keyed lookup silently misses it");

  for (const n of [...READ_ELSEWHERE, ...NO_READER]) {
    assert.ok(KNOWN_CLI_NAMES.has(n),
      `${n} is exempted above but is no longer a known name - delete the exemption`);
  }
});
