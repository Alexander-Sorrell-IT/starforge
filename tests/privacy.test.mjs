// Privacy-of-our-own-output regression tests.
//
// These lock the four red-team findings about what starforge WRITES:
//   1. HIGH — `--accounts` / `--join-fleet` put the raw OAuth email address in
//      expanded-*.json and in the shareable HTML stats page.
//   2. MEDIUM — the transcript heuristic ran on .json only, so the ~57 KB stats
//      page and the SVG card were exempt while the printed note claimed
//      ".json .svg .html".
//   3. LOW — project labels and the machine hostname make a report a client
//      list; "safe to sync" was stated without qualification.
//   4. LOW — main().catch printed the raw Error, the one output path that
//      bypassed maskPath.
//
// Everything here runs against temp dirs or the real cli.mjs under a throwaway
// HOME. Nothing reads or writes the developer's own ~/.starforge.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accountPseudonym,
  maskIdentities,
  findEmail,
  maskText,
  maskPath,
  maskProjects,
  projectPseudonym,
  collectProjectLabels,
  MIN_MASKABLE_USER_LEN,
} from "../src/redact.mjs";
import { renderStatsPage } from "../src/statspage.mjs";
import { outputScrub, markupStrings } from "../src/verify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CLI = join(ROOT, "src", "cli.mjs");

// A string that trips the transcript heuristic: > 400 chars, > 40 spaces.
const PROSE =
  "user: ok so walk me through the accrual bug again, I think the interest " +
  "index is stale by one block and the liquidation path reads it before the " +
  "update so the borrower gets charged twice. assistant: right, the ordering " +
  "in the redeem path is what does it, and the fix is to accrue first and only " +
  "then read the index, otherwise every downstream check is looking at the " +
  "previous block's numbers and the whole invariant falls over quietly.";

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ---------------------------------------------------------------------------
// 1. redact.mjs — the identity layer
// ---------------------------------------------------------------------------

test("accountPseudonym is stable, machine-independent, and collision-resistant", () => {
  const p = accountPseudonym("casey.dev@example.com");
  assert.match(p, /^acct-[0-9a-f]{8}$/);
  assert.equal(p, accountPseudonym("casey.dev@example.com"), "must be deterministic");
  assert.ok(!p.includes("casey"), "must not carry the local part");
  assert.ok(!p.includes("@"), "must not look like an address");
  // The reason this is a hash and not "c***@example.com": an initial+domain mask
  // merges two real accounts into one label, which silently corrupts the
  // per-account floor metric.
  assert.notEqual(
    accountPseudonym("casey.dev@example.com"),
    accountPseudonym("carol@example.com")
  );
  // grouping key: same address on any machine -> same label, so a fleet merge
  // still lines the accounts up.
  assert.equal(accountPseudonym("a@b.co"), accountPseudonym("a@b.co"));
  assert.equal(accountPseudonym(null), accountPseudonym(undefined));
});

test("maskIdentities replaces every address in free text, consistently", () => {
  const text = "merged x@y.io with alex.sorrell+dev@sub.example.co.uk and x@y.io again";
  const out = maskIdentities(text);
  assert.equal(findEmail(out), null, `an address survived: ${out}`);
  assert.ok(out.includes(accountPseudonym("x@y.io")));
  assert.ok(out.includes(accountPseudonym("alex.sorrell+dev@sub.example.co.uk")));
  // same address -> same label, twice in one string
  assert.equal(out.split(accountPseudonym("x@y.io")).length - 1, 2);
  // non-addresses are left alone
  assert.equal(maskIdentities("no @ here, and user@ alone"), "no @ here, and user@ alone");
});

test("findEmail reports the first hit with its offset and carries no lastIndex state", () => {
  const text = "line one\nowner: real.person@corp.io reported it";
  const a = findEmail(text);
  assert.equal(a.value, "real.person@corp.io");
  assert.equal(text.slice(a.index, a.index + a.value.length), "real.person@corp.io");
  // Called twice, same answer — a shared /g regex object would skip the second.
  assert.deepEqual(findEmail(text), a);
  assert.equal(findEmail("nothing here"), null);
  assert.equal(findEmail(null), null);
});

// finding 4: the crash path
test("maskText masks a stack trace — the crash output people paste into bug reports", () => {
  const home = process.env.HOME || "";
  const stack =
    `Error: ENOTDIR: not a directory, mkdir '${home}/.starforge/reports'\n` +
    `    at Object.mkdirSync (node:fs:1372:26)\n` +
    `    at main (file://${home}/.npm/_npx/abc/node_modules/starforge-cli/src/cli.mjs:376:5)`;
  const out = maskText(stack);
  assert.ok(home.length > 1, "test needs a HOME to mask");
  assert.ok(!out.includes(home), `raw home survived the mask:\n${out}`);
  assert.ok(out.includes("~/.starforge/reports"));
});

// Found by re-running the leak hunt against the REAL ~/.starforge after the
// four reported findings were fixed: an audit log there contained the literal
// username, because the path that carried it was MANGLED —
// ".../-Users-<name>-.../token-usage" — and slash-delimited masking never saw
// it. Claude Code names every directory under ~/.claude/projects that way, so
// this is the common case, not an exotic one.
test("maskPath removes the username from a MANGLED path, not only a /Users/ path", (t) => {
  const user = userInfo().username;
  if (user.length < MIN_MASKABLE_USER_LEN) {
    t.skip(`username "${user}" is below the masking threshold on this machine`);
    return;
  }
  // the exact shape ~/.claude/projects uses
  const claudeProj = `/x/.claude/projects/-Users-${user}-Desktop-Bug/s.jsonl`;
  const masked = maskPath(claudeProj);
  assert.ok(!masked.includes(user), `username survived: ${masked}`);
  assert.ok(masked.includes("[user]"));
  // the real leak: a --join-fleet argv recorded in the run log
  const argv = `--join-fleet=/private/tmp/claude-501/-Users-${user}/scratch/token-usage`;
  assert.ok(!maskText(argv).includes(user), maskText(argv));
  // still exact on the ordinary forms
  assert.equal(maskPath(`/Users/${user}/Documents/x.ts`), "~/Documents/x.ts");
  // and it does not eat a longer name that merely starts with the username
  assert.ok(maskPath(`/x/${user}2extra/f`).includes(`${user}2extra`));
});

test("what maskPath leaves behind, output-scrub does not flag (shared threshold)", (t) => {
  const user = userInfo().username;
  if (user.length < MIN_MASKABLE_USER_LEN) {
    t.skip("username below the masking threshold");
    return;
  }
  const dir = scrubDir({
    "argv.json": JSON.stringify({
      argv: [maskText(`--join-fleet=/tmp/-Users-${user}-work/token-usage`)],
      read: [maskPath(`/x/.claude/projects/-Users-${user}-Desktop-Bug`)],
    }),
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const res = outputScrub(dir, { home: "/nonexistent-home", user });
  assert.deepEqual(res.findings, [], "the scrub must not flag what masking already handled");
});

// ---------------------------------------------------------------------------
// 2. statspage.mjs — the file people actually share
// ---------------------------------------------------------------------------

const pageInput = (over = {}) => ({
  agg: { total_sessions: 3, projects: [{ name: "Bug/USDai", sessions: 7 }], languages: {}, models: {} },
  accounts: [
    { configDir: "~/.claude", account: "casey.dev@example.com", onDisk: 10 },
    { configDir: "~/.claude-b", account: "dana.builder@example.com", onDisk: 20 },
  ],
  ...over,
});

test("stats page carries pseudonyms, never addresses, unless --show-accounts", () => {
  const html = renderStatsPage(pageInput());
  assert.equal(findEmail(html), null, "an address reached the shareable HTML page");
  assert.ok(html.includes(accountPseudonym("casey.dev@example.com")));
  assert.ok(html.includes(accountPseudonym("dana.builder@example.com")));

  const raw = renderStatsPage(pageInput({ showAccounts: true }));
  assert.ok(raw.includes("casey.dev@example.com"), "--show-accounts must actually show them");
});

test("the page pseudonymises addresses from ANY blob, including a foreign --fleet file", () => {
  // A fleet folder written by some other tool can carry addresses; the page is
  // the last line of defence, so the sanitising happens at render time, not
  // only in accounts.mjs.
  const html = renderStatsPage(
    pageInput({ accounts: null, fleet: [{ machine: "mini", owner: "someone.else@corp.io" }] })
  );
  assert.equal(findEmail(html), null);
  assert.ok(html.includes(accountPseudonym("someone.else@corp.io")));
});

// finding 3: say what the page contains, on the page
test("the page states what it discloses: project names + the identity policy", () => {
  const html = renderStatsPage(pageInput());
  assert.match(html, /PROJECT NAMES/);
  assert.match(html, /pseudonyms/i);
  assert.match(html, /cannot stop someone confirming a guess/i);
  const raw = renderStatsPage(pageInput({ showAccounts: true }));
  assert.match(raw, /RAW/);
});

// ---------------------------------------------------------------------------
// 3. verify.mjs outputScrub — the heuristic that skipped .html and .svg
// ---------------------------------------------------------------------------

function scrubDir(files) {
  const dir = tmp("sf-scrub-");
  mkdirSync(join(dir, "reports"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "reports", name), body);
  return dir;
}

test("the transcript heuristic fires in .html and .svg, not just .json", (t) => {
  const dir = scrubDir({
    "leak.json": JSON.stringify({ sample: PROSE }, null, 2),
    "leak.html": `<!doctype html><html><body><div class="x">${PROSE}</div></body></html>`,
    "leak.svg": `<svg xmlns="http://www.w3.org/2000/svg"><text x="4" y="9">${PROSE}</text></svg>`,
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const res = outputScrub(dir, { home: "/nonexistent-home", user: "" });
  assert.equal(res.pass, false);
  for (const ext of ["json", "html", "svg"])
    assert.ok(
      res.findings.some((f) => f.includes(`leak.${ext}`) && /prose-like/.test(f)),
      `.${ext} was exempt from the transcript heuristic: ${JSON.stringify(res.findings)}`
    );
});

test("a transcript hidden in a markup ATTRIBUTE is caught too", (t) => {
  const dir = scrubDir({
    "attr.html": `<!doctype html><html><body><img alt="${PROSE}"><p>hi</p></body></html>`,
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const res = outputScrub(dir, { home: "/nonexistent-home", user: "" });
  assert.ok(
    res.findings.some((f) => /attr alt/.test(f) && /prose-like/.test(f)),
    JSON.stringify(res.findings)
  );
});

test("markup extraction skips code and geometry, so a real page does not false-positive", () => {
  // What must be DROPPED: <script>/<style> bodies (long and space-heavy by
  // nature, and nothing renders them as prose) and path geometry attributes.
  const geometry = `M ${Array.from({ length: 200 }, (_, i) => `${i} ${i}`).join(" L ")}`;
  const dropped = markupStrings(
    `<style>${PROSE}</style><script>const s = "${PROSE}";</script>` +
      `<path d="${geometry}"/><p>visible</p>`
  );
  const joined = dropped.map((p) => p.s).join("\n");
  assert.ok(!joined.includes("walk me through"), "script/style bodies must be dropped");
  assert.ok(!dropped.some((p) => p.where === "attr d"), "path geometry must be dropped");
  assert.ok(dropped.some((p) => p.where === "text" && p.s === "visible"));

  // What must be KEPT: any other attribute value — an attribute is a perfectly
  // good place to hide a transcript.
  const kept = markupStrings(`<p title="${PROSE}">visible</p>`);
  assert.ok(kept.some((p) => p.where === "attr title" && p.s.includes("walk me through")));

  // whitespace is collapsed, so markup indentation cannot fake "prose"
  const indented = markupStrings("<p>\n\n      a      b\n</p>");
  assert.ok(indented.some((p) => p.s === "a b"));
  // entities are decoded, so &#32;-padding cannot hide text either
  assert.ok(markupStrings("<p>a&#32;&amp;&#32;b</p>").some((p) => p.s === "a & b"));
});

test("the real stats page and card pass the scrub (no false positives on our own output)", (t) => {
  const html = renderStatsPage(pageInput());
  const dir = scrubDir({ "stats.html": html });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const res = outputScrub(dir, { home: "/nonexistent-home", user: "" });
  assert.equal(res.pass, true, JSON.stringify(res.findings));
});

test("an email in ANY scanned output file is a finding, and the address is not echoed in full", (t) => {
  const dir = scrubDir({
    "expanded.json": JSON.stringify({ accounts: [{ account: "casey.dev@example.com" }] }),
    "stats.html": `<html><body><td>casey.dev@example.com</td></body></html>`,
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const res = outputScrub(dir, { home: "/nonexistent-home", user: "" });
  assert.equal(res.pass, false);
  assert.equal(res.findings.filter((f) => /email address/.test(f)).length, 2);
  // the finding itself must not reprint the address it is complaining about
  assert.ok(!res.findings.join("\n").includes("casey.dev@example.com"));
  assert.ok(res.findings.some((f) => f.includes("c***@example.com")));
});

// findings 2 + 3: the printed limits must match what the code actually does
test("output-scrub limits describe the real coverage, including what is kept by design", () => {
  const dir = tmp("sf-scrub-empty-");
  try {
    const limits = outputScrub(dir, { home: "/nonexistent-home", user: "" }).limits.join("\n");
    // finding 2: no longer "JSON only", and the exclusions are named
    assert.match(limits, /transcript heuristic/i);
    assert.match(limits, /\.html/);
    assert.match(limits, /\.svg/);
    assert.match(limits, /script|style/i);
    // finding 3: projects + hostname are disclosed as kept BY DESIGN, not hidden
    assert.match(limits, /project names/i);
    assert.match(limits, /hostname/i);
    assert.match(limits, /pseudonym/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. end to end: the real CLI, a throwaway HOME, a real OAuth email on disk
// ---------------------------------------------------------------------------

const EMAIL = "leak-canary@example.com";
// distinctive on purpose: every "did it leak" assertion below is a substring
// search for this exact label across every file the run writes.
const PROJECT = "Bounty/ACMECLIENT";

function fakeHome() {
  const home = tmp("sf-priv-home-");
  const proj = join(home, ".claude", "projects", "Bounty", "ACMECLIENT");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "session.jsonl"),
    [
      JSON.stringify({
        type: "user",
        timestamp: new Date().toISOString(),
        uuid: "u1",
        cwd: join(home, "Bounty", "ACMECLIENT"),
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        uuid: "u2",
        message: { model: "claude-opus-4", usage: { input_tokens: 10, output_tokens: 5 } },
      }),
    ].join("\n") + "\n"
  );
  // the ~/.claude quirk file: this is where the OAuth address really lives
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: EMAIL } })
  );
  return home;
}

function runCli(home, argv) {
  return spawnSync(process.execPath, [CLI, ...argv], {
    encoding: "utf8",
    timeout: 180000,
    env: { ...process.env, HOME: home },
  });
}

const outputsOf = (home) => {
  const dir = join(home, ".starforge", "reports");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((f) => ({ name: f, body: readFileSync(join(dir, f), "utf8") }));
};

test("end to end: --accounts --json --page writes NO address; the terminal still shows it", (t) => {
  const home = fakeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const r = runCli(home, ["--yes", "--no-providers", "--accounts", "--json", "--page"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);

  const files = outputsOf(home);
  assert.ok(files.length >= 3, `expected reports+page, got ${files.map((f) => f.name)}`);
  assert.ok(files.some((f) => f.name.startsWith("expanded-")));
  assert.ok(files.some((f) => f.name.endsWith(".html")));

  for (const f of files) {
    assert.ok(!f.body.includes(EMAIL), `${f.name} contains the raw OAuth address`);
    assert.equal(findEmail(f.body), null, `${f.name} contains an address-shaped string`);
  }
  const expanded = files.find((f) => f.name.startsWith("expanded-"));
  assert.ok(
    expanded.body.includes(accountPseudonym(EMAIL)),
    "the pseudonym must be present — the account row must not just vanish"
  );

  // the terminal is not a file: the address is printed there, next to the
  // pseudonym the files carry, so the two can be matched up by the user.
  assert.ok(r.stdout.includes(EMAIL), "the terminal table should still name the account");
  assert.ok(r.stdout.includes(accountPseudonym(EMAIL)));
  assert.match(r.stdout, /--show-accounts/);

  // finding 3: the run says what the reports name, rather than "masked paths only"
  assert.match(r.stdout, /PROJECTS/);
  assert.match(r.stdout, /hostname/);

  // and the scrub agrees: our own output dir is clean, findings and all
  const scrub = outputScrub(join(home, ".starforge"), { home, user: "" });
  assert.deepEqual(scrub.findings, []);
  assert.equal(scrub.pass, true);
  assert.match(scrub.notes.join(" "), /scanned \d+ file/);
});

test("end to end: --show-accounts writes the raw address, and verify then FAILS loudly", (t) => {
  const home = fakeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const r = runCli(home, [
    "--yes",
    "--no-providers",
    "--accounts",
    "--json",
    "--show-accounts",
  ]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const expanded = outputsOf(home).find((f) => f.name.startsWith("expanded-"));
  assert.ok(expanded.body.includes(EMAIL), "--show-accounts must be honoured");
  // the run says so in as many words
  assert.match(r.stdout, /RAW account email addresses/);

  // The opt-in is not a licence to stay quiet: the scrub reports the addresses.
  // Asserted in-process, so this does not depend on verify's OTHER checks.
  const scrub = outputScrub(join(home, ".starforge"), { home, user: "" });
  assert.equal(scrub.pass, false);
  assert.ok(
    scrub.findings.some((f) => /contains an email address/.test(f)),
    JSON.stringify(scrub.findings)
  );
  // and the real `verify` exits non-zero because of it
  const v = spawnSync(process.execPath, [CLI, "verify"], {
    encoding: "utf8",
    timeout: 180000,
    env: { ...process.env, HOME: home },
  });
  assert.notEqual(v.status, 0, "verify must not pass while addresses sit in output files");
});

// ---------------------------------------------------------------------------
// finding 3: project labels are a client list. Kept readable by default and
// disclosed everywhere; --no-projects is the switch that actually removes them.
// ---------------------------------------------------------------------------

test("maskProjects finds labels under BOTH shapes and replaces every occurrence", () => {
  const doc = {
    projects: [{ name: "Bounty/ACMECLIENT", sessions: 7 }, { name: "Desktop/x", sessions: 1 }],
    profile: {
      projects: [{ name: "Bounty/ACMECLIENT", sessions: 7 }],
      records: { longest_session: { project: "Bounty/ACMECLIENT" } },
      excluded_session: { project: "[excluded]" },
    },
    // exactly the shape cli.mjs hands writeMachineFolder for a provider row —
    // the fleet folder is the most-synced output there is
    sessions: [
      { cli: "gemini", session_id: "g1", account: "acct-deadbeef", project: "Only/HereAsAField" },
    ],
  };
  const labels = collectProjectLabels(doc);
  // found under projects[].name AND under a bare project: field
  assert.ok(labels.has("Bounty/ACMECLIENT"));
  assert.ok(labels.has("Only/HereAsAField"));
  assert.ok(labels.has("Desktop/x"));
  // already-anonymous sentinels are left alone
  assert.ok(!labels.has("[excluded]"));

  const out = maskProjects(doc);
  const json = JSON.stringify(out);
  for (const label of labels) assert.ok(!json.includes(label), `${label} survived`);
  // one label -> one pseudonym, in every shape it appeared in (grouping holds)
  const p = projectPseudonym("Bounty/ACMECLIENT");
  assert.equal(out.projects[0].name, p);
  assert.equal(out.profile.projects[0].name, p);
  assert.equal(out.profile.records.longest_session.project, p);
  assert.match(p, /^proj-[0-9a-f]{8}$/);
  assert.equal(out.profile.excluded_session.project, "[excluded]");
  assert.equal(out.sessions[0].project, projectPseudonym("Only/HereAsAField"));
  assert.equal(out.sessions[0].cli, "gemini"); // non-project fields untouched
  // counts survive, and the input is NOT mutated (the terminal still needs it)
  assert.equal(out.projects[0].sessions, 7);
  assert.equal(doc.projects[0].name, "Bounty/ACMECLIENT");
});

test("end to end: without --no-projects the label is in the files (control)", (t) => {
  const home = fakeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const r = runCli(home, ["--yes", "--no-providers", "--json", "--page"]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const files = outputsOf(home);
  assert.ok(
    files.some((f) => f.body.includes(PROJECT)),
    "control failed: the default run should carry readable project labels"
  );
  assert.match(r.stdout, /--no-projects/, "the default run must advertise the switch");
});

test("end to end: --no-projects removes the label from EVERY file it writes", (t) => {
  const home = fakeHome();
  const fleetDir = tmp("sf-fleet-");
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(fleetDir, { recursive: true, force: true });
  });
  const r = runCli(home, [
    "--yes",
    "--no-providers",
    "--json",
    "--page",
    "--card",
    "--no-projects",
    `--join-fleet=${fleetDir}`,
  ]);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);

  const fleetFiles = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else fleetFiles.push(p);
    }
  })(fleetDir);
  // Honest scope note: with --no-providers the Claude fleet rows carry no
  // `project` field at all today, so the project half of this is a guard
  // against that changing, not proof that the switch did work here. What IS
  // proven here is the identity half. The project half of the fleet payload is
  // covered directly by the maskProjects test above, which uses the fleet
  // session shape (provider rows DO carry `project`).
  assert.ok(fleetFiles.length > 0, "the fleet join must have written something");
  for (const f of fleetFiles) {
    const body = readFileSync(f, "utf8");
    assert.ok(!body.includes(PROJECT), `${f} still names the project`);
    assert.equal(findEmail(body), null, `${f} contains an address`);
  }

  const files = outputsOf(home);
  assert.ok(files.length >= 4, files.map((f) => f.name).join(","));
  for (const f of files)
    assert.ok(!f.body.includes(PROJECT), `${f.name} still names the project`);
  // and the numbers are still attributable
  const expanded = files.find((f) => f.name.startsWith("expanded-"));
  assert.ok(expanded.body.includes(projectPseudonym(PROJECT)));
  // snapshots too — they are written on every run
  const snapDir = join(home, ".starforge", "snapshots");
  for (const s of readdirSync(snapDir))
    assert.ok(!readFileSync(join(snapDir, s), "utf8").includes(PROJECT));

  // terminal keeps the real name (it is not a file), and says so
  assert.ok(r.stdout.includes(PROJECT));
  assert.match(r.stdout, /files get proj-<hash>/);
  // the page footer must not claim it prints project names verbatim
  const page = files.find((f) => f.name.endsWith(".html"));
  assert.ok(!/prints your PROJECT NAMES/.test(page.body));
  assert.match(page.body, /proj-&lt;hash&gt; pseudonyms/);
});

// finding 4, end to end
test("a crash prints a MASKED stack — no absolute home path in the trace", (t) => {
  const home = fakeHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // make ~/.starforge/reports a FILE so mkdirSync throws ENOTDIR with the
  // absolute path in both message and stack, on the one write path that is not
  // wrapped in a try/catch.
  mkdirSync(join(home, ".starforge"), { recursive: true });
  writeFileSync(join(home, ".starforge", "reports"), "not a directory");

  const r = runCli(home, ["--yes", "--no-providers", "--json"]);
  assert.equal(r.status, 1, `expected a crash: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /ENOTDIR|EEXIST|ENOENT/);
  assert.ok(
    !r.stderr.includes(home),
    `the raw home path reached stderr:\n${r.stderr}`
  );
  assert.ok(r.stderr.includes("~/.starforge/reports"), r.stderr);
});

// ---------------------------------------------------------------------------
// 5. the docs must not overclaim what a report contains (finding 3)
// ---------------------------------------------------------------------------

test("README describes report contents accurately, not 'masked paths only'", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.ok(
    !/contain masked paths only/i.test(readme),
    "'masked paths only' is false: reports name projects, the hostname, and account pseudonyms"
  );
  assert.match(readme, /hostname/i);
  assert.match(readme, /acct-|pseudonym/i);
  assert.match(readme, /--show-accounts/);
  // and the project-label tradeoff is named where the sync advice is given
  assert.match(readme, /project/i);
});
