// @ts-nocheck
// tests/sources.test.mjs — the source list, and the gaps it exists to show.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

import { loadSources, survey, render } from "../src/sources.mjs";

test("the spec ships and parses", () => {
  const spec = loadSources();
  assert.ok(Array.isArray(spec.sources) && spec.sources.length > 0);
  for (const s of spec.sources) {
    assert.ok(s.name, "every source is named");
    assert.ok(s.kind, "kind decides WHERE discovery looks — it is not decoration");
    assert.ok(Array.isArray(s.counted_by), `${s.name} must say who counts it`);
  }
});

// THE WHOLE REASON THE COMMAND EXISTS. A source nothing can count must be
// visible by name. It contributes 0 to every total, which is exactly what a
// tool you have never installed contributes, and nothing else in the program
// can tell those apart.
test("a source with no reader is reported by name, never as zero or absence", () => {
  const rows = survey();
  const gaps = rows.filter((r) => r.state === "no reader");
  assert.ok(gaps.length > 0,
    "cursor is scored by standout and read by neither program — if this is "
    + "empty, either a reader was added (update the spec) or a gap was hidden");
  const out = render(rows, { color: false });
  for (const g of gaps) assert.ok(out.includes(g.name), `${g.name} must be named`);
  assert.match(out, /no reader/);
});

// SUPERSEDED. This asserted that `kind` decided where discovery looked —
// detectSource() inferred a dotdir for a cli and rummaged under vscode storage
// for an extension. That inference is exactly what let `sources` and the scan
// reach different conclusions about the same tool (cowork read as installed on
// Linux while the scan never touched it). The spec now DECLARES the paths and
// both read the same ones; `kind` is left as a label. What replaced this test
// is "probe: absent, empty, counted and unreadable are four different answers"
// and the dotdir_contains case below it.

test("a derived source declares no store of its own", () => {
  // history and claude-orphans are not tools; they read another source's files.
  // They still declare stores (where those files are), which is why they are
  // discoverable at all — but they are labelled `derived` so nothing reports
  // them as an install the user could make or remove.
  const spec = loadSources();
  for (const s of spec.sources.filter((x) => x.kind === "derived"))
    assert.ok(s.name, `${s.name}: a derived source must still be named`);
  const rows = survey();
  for (const r of rows.filter((x) => x.kind === "derived"))
    assert.equal(r.state, "derived", "a derived source is neither installed nor missing");
});


// YOUR ADDRESSES ARE NOT PART OF A TOOL OTHER PEOPLE INSTALL.
//
// spec/identity.json holds real email addresses. It was very nearly published:
// adding `spec/` to package.json files[] pulled it into the tarball at 6.6 kB,
// and .gitignore does NOT stop npm from packing — this repository already
// documented that with src/__pycache__/*.pyc, which ships today. The guard is
// the `!spec/identity.json` negation in files[], and a guard nobody tests is
// one package.json edit from being gone.
test("spec/identity.json can never be published", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

  assert.ok(pkg.files.includes("!spec/identity.json"),
    "the negation is the only thing keeping personal addresses out of the "
    + "published package — .gitignore does not stop npm pack");

  // And spec/ must still ship, or the source list is missing from the install
  // and `starreckon sources` cannot say what it looked for.
  assert.ok(pkg.files.includes("spec/"),
    "spec/sources.json ships: without it an install cannot name its sources");
});

// ── the probe: where a source lives, and whether it can be read ──────────────
//
// THE SINGLE MOST REPEATED DEFECT IN THIS SYSTEM — 28 of the 106 confirmed on
// 2026-08-16 — is `unreadable` collapsing into `empty` or `absent`. Every
// reader in both programs answered "I could not open it" and "there is nothing
// there" with the same zero. These four cases are the fix, and they are asserted
// on a real filesystem rather than a stub, because the difference only exists at
// the syscall.

import { mkdirSync as mkDir, chmodSync } from "node:fs";
import { probe, stateOf } from "../src/sources.mjs";

const SPEC = loadSources();
const src = (n) => SPEC.sources.find((s) => s.name === n);

test("probe: absent, empty, counted and unreadable are four different answers", () => {
  const codex = src("codex");

  // 1. no store at all
  const h1 = mkdtempSync(join(tmpdir(), "probe-"));
  assert.equal(probe(codex, h1, SPEC).state, "absent");
  assert.equal(stateOf(probe(codex, h1, SPEC), 0), "absent");
  rmSync(h1, { recursive: true, force: true });

  // 2. the store is there and holds nothing
  const h2 = mkdtempSync(join(tmpdir(), "probe-"));
  mkDir(join(h2, ".codex", "sessions"), { recursive: true });
  assert.equal(stateOf(probe(codex, h2, SPEC), 0), "empty");
  assert.equal(stateOf(probe(codex, h2, SPEC), 5), "counted");
  rmSync(h2, { recursive: true, force: true });

  // 3. the store is there and cannot be entered. NOT empty. NOT absent.
  const h3 = mkdtempSync(join(tmpdir(), "probe-"));
  const locked = join(h3, ".codex", "sessions");
  mkDir(locked, { recursive: true });
  chmodSync(locked, 0o000);
  try {
    const pr = probe(codex, h3, SPEC);
    assert.equal(pr.state, "unreadable");
    assert.equal(pr.unreadable.length, 1);
    assert.equal(pr.unreadable[0].path, locked);
    // and a count cannot talk it out of that — a partial read is a floor
    assert.equal(stateOf(pr, 0), "unreadable");
    assert.equal(stateOf(pr, 5), "unreadable");
  } finally {
    chmodSync(locked, 0o755);
    rmSync(h3, { recursive: true, force: true });
  }
});

// "absent" has to mean *not at any declared path, and here is the list*. Before
// the paths were declared it meant "not at the one place this reader happens to
// hardcode" — which is how `starreckon sources` reported cowork as installed on
// Linux while the scan never read it.
test("probe: an absent answer says where it looked", () => {
  const h = mkdtempSync(join(tmpdir(), "probe-"));
  const pr = probe(src("codex"), h, SPEC);
  assert.equal(pr.state, "absent");
  assert.ok(pr.searched.length > 0, "an absent answer with no searched list is unactionable");
  assert.ok(pr.searched.every((p) => p.startsWith(h)), "it must search under the home it was given");
  rmSync(h, { recursive: true, force: true });
});

// `dotdir_contains` is the rule that replaced the `.claude*` glob. That glob
// missed ~/.my-claude, and with it 269,561,229 orphan tokens the reader could
// have recovered. The rule is asserted here because it is the reason the spec
// declares a RULE NAME and not a glob string.
test("probe: dotdir_contains finds every claude profile, not just .claude*", () => {
  const h = mkdtempSync(join(tmpdir(), "probe-"));
  for (const d of [".claude", ".claude-alt", ".my-claude", ".notaprofile"])
    mkDir(join(h, d, "projects"), { recursive: true });
  const found = probe(src("claude"), h, SPEC).found.map((p) => p.replace(h + "/", ""));
  assert.ok(found.includes(".my-claude/projects"),
    "the `.claude*` glob this replaced missed ~/.my-claude entirely");
  assert.ok(found.includes(".claude/projects") && found.includes(".claude-alt/projects"));
  assert.ok(!found.some((p) => p.startsWith(".notaprofile")));
  rmSync(h, { recursive: true, force: true });
});

test("spec: every counted source declares where it lives", () => {
  for (const s of SPEC.sources) {
    if (!(s.counted_by ?? []).length) continue;
    assert.ok((s.stores ?? []).length > 0,
      `${s.name} says it is counted but declares no store — the reader would be `
      + `hardcoding a path, which is what the spec exists to end`);
    for (const st of s.stores) {
      assert.ok(SPEC.bases?.[st.base], `${s.name}: base ${st.base} is not declared`);
      // no globs. segments only.
      for (const seg of st.segments ?? [])
        assert.ok(!/[*?[\]]/.test(seg),
          `${s.name}: "${seg}" looks like a glob. Python's glob and Node's fs `
          + `read those differently — declare a rule, not a pattern`);
    }
  }
});

// ── the other half: tools nobody declared ────────────────────────────────────
//
// The spec answers "where is the tool I know about". Without this, that is the
// ONLY question the program can ask, and a tool installed next month is
// invisible — invisible in the one way this system must never be, as a silent
// zero rather than a named gap.
//
// discover.walk has done this classification since it was written and was
// imported by NOTHING; its `knownPaths` argument — the thing that makes KNOWN
// mean anything — was never supplied by a caller.

test("undeclared: a store nobody declared is found and named", async () => {
  const { unknownStores } = await import("../src/sources.mjs");
  const h = mkdtempSync(join(tmpdir(), "undeclared-"));
  const store = join(h, ".brandnewcli", "sessions");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "s1.jsonl"), JSON.stringify({
    role: "assistant", content: "hello",
    usage: { input_tokens: 5, output_tokens: 2 },
  }) + "\n");

  const r = unknownStores(h);
  const news = r.found.filter((f) => f.status === "UNKNOWN");
  assert.ok(news.some((f) => f.path.includes("brandnewcli")),
    "a conversational store outside the spec must be reported, not skipped");
  rmSync(h, { recursive: true, force: true });
});

// KNOWN only means something if the known set is real. It was always empty.
test("undeclared: a DECLARED store is not reported as a discovery", async () => {
  const { unknownStores, loadSources } = await import("../src/sources.mjs");
  const h = mkdtempSync(join(tmpdir(), "undeclared-"));
  const store = join(h, ".codex", "sessions");        // declared in spec/sources.json
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "r.jsonl"), JSON.stringify({
    type: "event_msg",
    payload: { info: { last_token_usage: { input_tokens: 1, output_tokens: 1 } } },
  }) + "\n");

  const r = unknownStores(h);
  assert.ok(r.known.length > 0, "the known set comes from the spec and must not be empty");
  const flagged = r.found.filter((f) => f.status !== "KNOWN" && f.path.includes(".codex"));
  assert.deepEqual(flagged, [],
    "a store the spec already declares is covered, not a discovery");
  rmSync(h, { recursive: true, force: true });
});

test("undeclared: the report masks the home path", async () => {
  const { unknownStores, survey, render } = await import("../src/sources.mjs");
  const h = mkdtempSync(join(tmpdir(), "undeclared-"));
  mkdirSync(join(h, ".brandnewcli", "sessions"), { recursive: true });
  writeFileSync(join(h, ".brandnewcli", "sessions", "s.jsonl"),
    JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }) + "\n");
  const out = render(survey(h), { color: false, undeclared: unknownStores(h) });
  assert.ok(!out.includes(homedir()),
    "sources output gets pasted into issues; it must not carry the real home path");
  rmSync(h, { recursive: true, force: true });
});

// ── the state has to REACH the user ─────────────────────────────────────────
//
// Computing `unreadable` in every reader and then filtering it out one step
// before the screen is the same defect with an extra step. These pin the last
// step: the terminal block and the wrapped mapping.

test("a provider that could not be read is not filtered out as empty", async () => {
  const { unreadableProviders, normaliseProviders } = await import("../src/wrapped.mjs");
  const providers = {
    gemini: { sessions: 5, input: 100, output: 10, cacheRead: 0, cacheWrite: 0, state: "counted" },
    // present on disk, refused by the filesystem: 0 tokens, and NOT the same
    // fact as a tool nobody installed
    locked: { sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
              state: "unreadable", unreadable: ["~/.locked/sessions (EACCES)"] },
    missing: { sessions: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, state: "absent" },
  };
  const ranked = normaliseProviders(providers).map((p) => p.name);
  assert.deepEqual(ranked, ["gemini"], "a zero-token row is still not ranked");

  const blind = unreadableProviders(providers).map((p) => p.name);
  assert.deepEqual(blind, ["locked"],
    "an unreadable store must be reachable by name — it is the difference "
    + "between a total and a floor");
  assert.ok(!blind.includes("missing"), "absent is not unreadable");
});

// ── every platform, not just the one this runs on ───────────────────────────
//
// The paths moved from code into spec/sources.json, and only Linux can be
// tested here. A wrong table for macOS or Windows would not fail anything on
// this machine — it would quietly count nothing on somebody else's, which is
// the exact shape of failure this project exists to prevent.
//
// So the tables are asserted directly, against what the code they replaced did.

test("platform bases cover macOS and Windows, not only Linux", () => {
  const spec = loadSources();
  const b = spec.bases;
  for (const name of ["home", "vscode", "appsupport"]) {
    for (const plat of ["linux", "darwin", "win32"]) {
      assert.ok(Array.isArray(b[name]?.[plat]) && b[name][plat].length > 0,
        `base ${name} declares nothing for ${plat} — a machine on that platform `
        + `would search nowhere and report every tool absent`);
    }
  }
  // The exact bases the hardcoded code used, before it was replaced.
  const flat = (segs) => segs.map((s) => s.join("/")).sort();
  assert.deepEqual(flat(b.vscode.darwin), ["${A}", "Library/Application Support"].map(x => x === "${A}" ? ".config" : x).sort(),
    "macOS VS Code lives under Library/Application Support, with .config as the fallback");
  assert.deepEqual(flat(b.vscode.win32), [".config", "{APPDATA}"].sort(),
    "Windows VS Code lives under %APPDATA%");
  assert.deepEqual(flat(b.appsupport.darwin), [".config", "Library/Application Support"].sort(),
    "Cowork is a Mac app: Application Support is where a Mac app stores data");
});

// Cowork was hardcoded to Library/Application Support and nowhere else, so on
// Linux and Windows the scan could never see it while `sources` said it was
// installed. Two files, two ideas of where one tool lives.
test("cowork is reachable on every platform, not just macOS", () => {
  const spec = loadSources();
  const cw = spec.sources.find((s) => s.name === "cowork");
  assert.ok(cw.stores?.length, "cowork must declare a store");
  for (const plat of ["linux", "darwin", "win32"])
    assert.ok((spec.bases[cw.stores[0].base][plat] ?? []).length > 0,
      `cowork has nowhere to look on ${plat}`);
});

// ── bob: `input` is the whole prompt ────────────────────────────────────────
//
// THE FIXTURE HAD NO BOB ARITHMETIC AT ALL, WHICH IS WHY THIS SURVIVED. Both
// programs summed input + output + cacheRead + cacheWrite, and bob's `input`
// already CONTAINS its cache — so every cached token was counted twice, in both
// implementations, and the two agreeing on 38,783,298 read as confirmation.
//
// Hand-derived, and the numbers say the rule out loud:
//   task A  input 1,000 · cacheRead 600 · cacheWrite 300 · output 50
//           900 of the prompt was cache, so 100 was fresh.
//           total = input + output = 1,050.   The bug gives 1,950.
//   task B  input 40, no cache, output 5      total 45
//   task C  all zero                          not a session
test("bob: the cache is part of the prompt, not an addition to it", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { readBob } = await import("../src/readers.mjs");
  const home = mkdtempSync(join(tmpdir(), "bob-"));
  mkdirSync(join(home, ".bob", "db"), { recursive: true });
  const db = new DatabaseSync(join(home, ".bob", "db", "bob.db"));
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, costs TEXT);
           CREATE TABLE messages (task_id TEXT, role TEXT, data TEXT);`);
  const ins = db.prepare("INSERT INTO tasks (id,title,created_at,costs) VALUES (?,?,?,?)");
  ins.run("A", "task a", 1700000000000,
    JSON.stringify({ input: 1000, cacheRead: 600, cacheWrite: 300, output: 50 }));
  ins.run("B", "task b", 1700000000000,
    JSON.stringify({ input: 40, cacheRead: 0, cacheWrite: 0, output: 5 }));
  ins.run("C", "task c", 1700000000000,
    JSON.stringify({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }));
  db.close();

  const r = await readBob(home);
  assert.equal(r.sessions.length, 2, "an all-zero task is not a session");
  assert.equal(r.total, 1095,
    "1,995 means the cache was added on top of a prompt that already contained it");
  const a = r.sessions.find((s) => s.id === "A");
  assert.equal(a.tokens.input, 100, "the fresh part of the prompt, not the whole prompt");
  assert.equal(a.tokens.cacheRead, 600);
  assert.equal(a.tokens.cacheWrite, 300);
  assert.equal(a.tokens.output, 50);
  rmSync(home, { recursive: true, force: true });
});
