// tests/addons.test.mjs — the optional add-ons and their offline licence.
//
// The states are the point. This project's oldest and most repeated defect is
// two different facts rendering as one, so every test below exists to keep a
// pair of states apart rather than to check that the happy path works.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync, sign as edSign } from "node:crypto";

import {
  ADDONS, locate, licencePath, readLicence, survey, renderSurvey,
} from "../src/addons.mjs";

// A throwaway issuer for the tests. The real private key is not in this
// repository and must never be — these exercise the verification logic, not
// the production key.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const TEST_KEY = publicKey.export({ type: "spki", format: "der" }).toString("base64");

function home() {
  const d = mkdtempSync(join(tmpdir(), "addons-test-"));
  mkdirSync(join(d, ".starreckon"), { recursive: true });
  return d;
}

function licence(claim, { key = privateKey } = {}) {
  const payload = Buffer.from(JSON.stringify(claim), "utf-8").toString("base64");
  return {
    payload,
    signature: edSign(null, Buffer.from(payload, "base64"), key).toString("base64"),
  };
}

function put(h, doc) {
  writeFileSync(licencePath(h), typeof doc === "string" ? doc : JSON.stringify(doc));
}

// ── the licence states ────────────────────────────────────────────────────────

test("no licence file is `none`, and grants nothing", () => {
  const h = home();
  const l = readLicence(h, { issuerKey: TEST_KEY });
  assert.equal(l.status, "none");
  assert.deepEqual(l.addons, []);
  rmSync(h, { recursive: true, force: true });
});

test("a valid licence grants exactly what it names", () => {
  const h = home();
  put(h, licence({ subject: "A", addons: ["wikia", "fleet"], expires: "2999-01-01" }));
  const l = readLicence(h, { issuerKey: TEST_KEY });
  assert.equal(l.status, "valid");
  assert.deepEqual(l.addons.sort(), ["fleet", "wikia"]);
  rmSync(h, { recursive: true, force: true });
});

test('"*" grants every add-on, so shipping a new one needs no reissue', () => {
  const h = home();
  put(h, licence({ subject: "A", addons: ["*"], expires: "2999-01-01" }));
  const l = readLicence(h, { issuerKey: TEST_KEY });
  assert.deepEqual(l.addons.sort(), ADDONS.map(a => a.name).sort());
  rmSync(h, { recursive: true, force: true });
});

// EXPIRED AND INVALID MUST NOT COLLAPSE. One is a customer whose renewal
// lapsed and the other is a forgery, and telling a paying customer their
// licence is forged is the worse of the two mistakes.
test("an expired licence is `expired`, never `invalid`", () => {
  const h = home();
  put(h, licence({ subject: "A", addons: ["*"], expires: "2000-01-01" }));
  const l = readLicence(h, { issuerKey: TEST_KEY });
  assert.equal(l.status, "expired");
  assert.deepEqual(l.addons, [], "an expired licence grants nothing");
  rmSync(h, { recursive: true, force: true });
});

test("a licence signed by the wrong key is `invalid`, never `expired`", () => {
  const h = home();
  const other = generateKeyPairSync("ed25519").privateKey;
  put(h, licence({ subject: "A", addons: ["*"], expires: "2999-01-01" }, { key: other }));
  const l = readLicence(h, { issuerKey: TEST_KEY });
  assert.equal(l.status, "invalid");
  assert.deepEqual(l.addons, []);
  rmSync(h, { recursive: true, force: true });
});

test("editing the payload of a real licence invalidates it", () => {
  const h = home();
  const doc = licence({ subject: "A", addons: ["wikia"], expires: "2999-01-01" });
  const tampered = Buffer.from(
    JSON.stringify({ subject: "A", addons: ["*"], expires: "2999-01-01" }), "utf-8",
  ).toString("base64");
  put(h, { payload: tampered, signature: doc.signature });
  assert.equal(readLicence(h, { issuerKey: TEST_KEY }).status, "invalid");
  rmSync(h, { recursive: true, force: true });
});

// A VERIFIED SIGNATURE OVER GARBAGE MUST NOT READ AS A GRANT. If the signed
// bytes are not a claim, "valid" would be a signature check that succeeded
// while the thing it authorises is unknown — which is worse than a failure,
// because it looks like success.
test("a correctly signed payload that is not a claim is `malformed`", () => {
  const h = home();
  const payload = Buffer.from("not json at all", "utf-8").toString("base64");
  put(h, {
    payload,
    signature: edSign(null, Buffer.from(payload, "base64"), privateKey).toString("base64"),
  });
  const l = readLicence(h, { issuerKey: TEST_KEY });
  assert.equal(l.status, "malformed");
  assert.deepEqual(l.addons, []);
  rmSync(h, { recursive: true, force: true });
});

test("a file that is not a licence at all is `malformed`, not a crash", () => {
  const h = home();
  put(h, "{{{ not json");
  assert.equal(readLicence(h, { issuerKey: TEST_KEY }).status, "malformed");
  put(h, { hello: "world" });
  assert.equal(readLicence(h, { issuerKey: TEST_KEY }).status, "malformed");
  rmSync(h, { recursive: true, force: true });
});

// ── locating an executable ────────────────────────────────────────────────────

test("locate reports the PATH it searched, so `absent` is actionable", () => {
  const got = locate("definitely-not-a-real-binary", { PATH: "/a:/b:/c" });
  assert.equal(got.path, null);
  assert.deepEqual(got.searched, ["/a", "/b", "/c"]);
});

test("locate on an empty PATH searches nothing and says so", () => {
  const got = locate("anything", {});
  assert.equal(got.path, null);
  assert.deepEqual(got.searched, []);
});

// ABSENT AND UNREACHABLE ARE DIFFERENT FACTS. Every pip add-on here is an
// editable install rooted on a removable mount, so an unplugged drive leaves
// the launcher on PATH pointing at nothing. Calling that "not installed" tells
// somebody to reinstall a tool they already own.
test("a dangling entry on PATH is unreachable, not absent", () => {
  const d = mkdtempSync(join(tmpdir(), "addons-path-"));
  const bin = join(d, "ghost-tool");
  symlinkSync(join(d, "target-that-does-not-exist"), bin);
  const got = locate("ghost-tool", { PATH: d });
  assert.equal(got.path, bin, "it was found on PATH");
  assert.equal(got.usable, false, "and it cannot be used");
  rmSync(d, { recursive: true, force: true });
});

// ── the survey ────────────────────────────────────────────────────────────────

test("without a licence every add-on is `locked` and nothing is searched for", () => {
  const h = home();
  const s = survey(h, { env: { PATH: "/usr/bin" }, issuerKey: TEST_KEY });
  assert.ok(s.addons.length > 0);
  for (const a of s.addons) {
    assert.equal(a.state, "locked", `${a.name} should be locked`);
    assert.equal(a.searched, null,
      "an unlicensed install must not inventory the machine");
  }
  rmSync(h, { recursive: true, force: true });
});

test("licensed and installed is `ready`; licensed and missing is `absent`", () => {
  const h = home();
  const d = mkdtempSync(join(tmpdir(), "addons-bin-"));
  writeFileSync(join(d, "wikia"), "#!/bin/sh\n");
  chmodSync(join(d, "wikia"), 0o755);
  put(h, licence({ subject: "A", addons: ["*"], expires: "2999-01-01" }));

  const s = survey(h, { env: { PATH: d }, issuerKey: TEST_KEY });
  const by = Object.fromEntries(s.addons.map(a => [a.name, a.state]));
  assert.equal(by.wikia, "ready");
  assert.equal(by.enforcement, "absent");
  rmSync(h, { recursive: true, force: true });
  rmSync(d, { recursive: true, force: true });
});

// THE BOUNDARY, NOT A TIER. sitemap-mcp is an outbound HTTP client by design.
// starreckon's whole verifiable claim is that its scan path opens no socket,
// so an installed-and-licensed sitemap must still never be marked runnable
// from here.
test("an outbound-by-design tool is `external` even when installed and licensed", () => {
  const h = home();
  const d = mkdtempSync(join(tmpdir(), "addons-bin-"));
  for (const n of ["sitemap-mcp", "filelens-mcp"]) {
    writeFileSync(join(d, n), "#!/bin/sh\n");
    chmodSync(join(d, n), 0o755);
  }
  put(h, licence({ subject: "A", addons: ["*"], expires: "2999-01-01" }));

  const s = survey(h, { env: { PATH: d }, issuerKey: TEST_KEY });
  const by = Object.fromEntries(s.addons.map(a => [a.name, a.state]));
  assert.equal(by.sitemap, "external");
  assert.equal(by.filelens, "external");
  rmSync(h, { recursive: true, force: true });
  rmSync(d, { recursive: true, force: true });
});

test("no add-on declares itself runnable here and outbound at the same time", () => {
  for (const a of ADDONS) {
    if (a.kind === "npx") {
      assert.equal(a.runsHere, false,
        `${a.name} is an MCP server: it is spawned by an MCP client, not by this CLI`);
    }
  }
});

test("every add-on's binary name is declared, because one differs from its package", () => {
  const differing = ADDONS.filter(a => a.bin !== a.pkg);
  assert.ok(differing.length > 0,
    "cli-wikia installs `wikia` — if this ever becomes empty the registry has "
    + "been rewritten to derive bin from pkg, which produces a false `absent`");
  for (const a of ADDONS) assert.ok(a.bin && typeof a.bin === "string");
});

// ── rendering ─────────────────────────────────────────────────────────────────

test("the render never prints a bare zero for a tool that was never looked for", () => {
  const h = home();
  const out = renderSurvey(survey(h, { env: { PATH: "/usr/bin" }, issuerKey: TEST_KEY }),
                           { color: false });
  assert.match(out, /no licence file/);
  assert.match(out, /not covered by the licence/);
  assert.doesNotMatch(out, /\b0\b/, "no count should appear for an unsearched tool");
  rmSync(h, { recursive: true, force: true });
});

test("the render names the licence file so an unlicensed user knows where it goes", () => {
  const h = home();
  const out = renderSurvey(survey(h, { env: { PATH: "/usr/bin" }, issuerKey: TEST_KEY }),
                           { color: false });
  assert.ok(out.includes(licencePath(h)));
  rmSync(h, { recursive: true, force: true });
});

// ── cowork ────────────────────────────────────────────────────────────────────
//
// Cowork is Claude's Mac app, and its store is an ordinary Application Support
// directory holding ordinary Claude Code profiles seven levels down. It cannot
// exist on the Linux box this was written on, so the tree is built here
// instead: the shape is from the store layout, and building it is what proves
// the discovery walks it rather than a Mac being present.
test("cowork: finds the nested profiles inside the app's store", async () => {
  const { coworkProfileDirs } = await import("../src/readers.mjs");
  const home = mkdtempSync(join(tmpdir(), "cowork-"));
  // <config-base>/Claude/local-agent-mode-sessions/<account>/<org>/local_<uuid>/.claude/projects/<enc>/<id>.jsonl
  const base = join(home, ".config", "Claude", "local-agent-mode-sessions");
  const proj = join(base, "acct-1", "org-1", "local_abc", ".claude", "projects", "-w-alpha");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "s1.jsonl"), "{}\n");

  const r = coworkProfileDirs(home);
  assert.equal(r.state, "counted");
  assert.equal(r.dirs.length, 1);
  assert.ok(r.dirs[0].endsWith(join("local_abc", ".claude")));
  rmSync(home, { recursive: true, force: true });
});

test("cowork: a store with no session profiles is empty, not absent", async () => {
  const { coworkProfileDirs } = await import("../src/readers.mjs");
  const home = mkdtempSync(join(tmpdir(), "cowork-"));
  mkdirSync(join(home, ".config", "Claude", "local-agent-mode-sessions"), { recursive: true });
  const r = coworkProfileDirs(home);
  assert.equal(r.state, "empty", "the app is installed and has recorded nothing");
  assert.equal(r.dirs.length, 0);
  rmSync(home, { recursive: true, force: true });
});

test("cowork: no store at all is absent, and absent is not zero usage", async () => {
  const { coworkProfileDirs } = await import("../src/readers.mjs");
  const home = mkdtempSync(join(tmpdir(), "cowork-"));
  const r = coworkProfileDirs(home);
  assert.equal(r.state, "absent");
  assert.deepEqual(r.roots, [], "nothing was found because there is nothing there");
  rmSync(home, { recursive: true, force: true });
});
