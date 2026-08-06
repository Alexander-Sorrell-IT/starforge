import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  staticScan,
  auditCheck,
  outputScrub,
  confinementCheck,
  runVerify,
  printVerify,
  STATIC_ALLOWLIST,
} from "../src/verify.mjs";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const tmp = () => mkdtempSync(join(tmpdir(), "sf-verify-"));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// NOTE: fixture strings below intentionally contain the forbidden tokens —
// this test file lives in tests/, which the static scan never reads.

function writeAllowlisted(dir) {
  writeFileSync(
    join(dir, "tripwire.mjs"),
    'import net from "node:net";\nimport dgram from "node:dgram";\nexport const armed = true;\n'
  );
  writeFileSync(
    join(dir, "confine.mjs"),
    'import { spawn } from "node:child_process";\nimport { connect } from "node:net";\nexport const launcher = true;\n'
  );
}

// ---- staticScan -------------------------------------------------------------

test("staticScan passes on a clean tree with intact allowlisted files", () => {
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
  assert.ok(res.limits.length >= 3);
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

test("staticScan does not flag verify.mjs itself (self-scan) on the real tree", () => {
  const res = staticScan(SRC_DIR);
  const selfHits = res.findings.filter((f) => f.includes("verify.mjs"));
  assert.deepStrictEqual(selfHits, [], JSON.stringify(selfHits));
  // and the real allowlisted safety files must be present with hits
  assert.ok(res.allowlist["tripwire.mjs"].hits > 0, "tripwire.mjs must have hits");
  assert.ok(res.allowlist["confine.mjs"].hits > 0, "confine.mjs must have hits");
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
    JSON.stringify({ total_sessions: 42, top_project: "Projects/starforge", path: "~/Documents/x" })
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
