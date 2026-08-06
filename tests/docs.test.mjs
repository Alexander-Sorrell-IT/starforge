// Docs + packaging honesty tests.
//
// These lock in the fixes for the red-team's docs/packaging findings. They are
// deliberately blunt string checks: the failure mode they exist to prevent is a
// sentence in a doc that the code does not back, and the only way to catch that
// is to read the sentences.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (rel) => readFileSync(root + rel, "utf8");

const README = read("README.md");
const PROVE = read("PROVE-IT.md");
const CLI = read("src/cli.mjs");
const PKG = JSON.parse(read("package.json"));

// Fenced code blocks are what people copy/paste — held to a stricter standard
// than prose, which is allowed to *warn about* the wrong commands.
function codeBlockLines(md) {
  const out = [];
  let inBlock = false;
  for (const line of md.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      inBlock = !inBlock;
      continue;
    }
    if (inBlock) out.push(line);
  }
  return out;
}

// ---- finding: `npx starforge` runs a stranger's package ---------------------

test("package is named starforge-cli, and its bin matches", () => {
  assert.equal(PKG.name, "starforge-cli");
  assert.deepEqual(Object.keys(PKG.bin), ["starforge-cli"]);
});

test("no copy-pastable command in the docs invokes the squatted bare name", () => {
  // The risk is RUNNING the bare name: `npx starforge` fetches the unrelated
  // 2017 package, and `starforge verify` implies a binary that isn't ours. So
  // match command POSITION, not the token anywhere on the line — now that the
  // repo is public the docs legitimately contain the word in a clone URL and in
  // `cd starforge`, and neither of those executes anything. A blanket token
  // search would fail on those and tempt the next person to delete the guard.
  const bareName =
    /(?:^\s*(?:\$\s*)?|\bnpx\s+|\bnpm\s+exec\s+)starforge(?![-\w])/;
  for (const [name, md] of [["README.md", README], ["PROVE-IT.md", PROVE]]) {
    for (const line of codeBlockLines(md)) {
      assert.ok(
        !bareName.test(line),
        `${name}: copy-pastable line invokes the bare name \`starforge\`: ${line}`
      );
    }
  }
});

test("prose that mentions the bare npm name marks it as NOT this tool", () => {
  for (const [name, md] of [["README.md", README], ["PROVE-IT.md", PROVE]]) {
    for (const line of md.split("\n")) {
      if (!/npx\s+starforge(?!-cli)/.test(line)) continue;
      assert.ok(
        /not this tool|don't run it|stranger/i.test(line),
        `${name}: mentions \`npx starforge\` without warning it is not this tool: ${line}`
      );
    }
  }
});

test("docs disclose that starforge-cli is not published yet", () => {
  // The npx path is advertised; it must not be advertised as working today.
  for (const [name, md] of [["README.md", README], ["PROVE-IT.md", PROVE]]) {
    assert.match(md, /not published yet|not on npm yet/i, `${name} must disclose publish status`);
  }
  assert.match(README, /404/, "README should cite the npm 404 as the evidence");
});

test("the CLI's own usage header uses the real package name", () => {
  const header = CLI.split("import {")[0];
  assert.ok(!/npx\s+starforge(?!-cli)/.test(header) || /NOT this tool/.test(header));
  assert.match(header, /starforge-cli --yes/);
});

// ---- finding: banner asserts what the run cannot know -----------------------

test("banner does not assert 'Nothing leaves this machine'", () => {
  assert.ok(
    !CLI.includes("Nothing leaves this machine"),
    "the banner must not assert unconditionally what the same run's audit log records as unverified"
  );
  assert.match(CLI, /no process can prove that about itself/);
  assert.match(CLI, /starforge-cli prove/);
});

test("no headline asserts unconditional no-egress", () => {
  // Same class of overclaim as the banner: the tool cannot prove this about
  // itself, and syncing ~/.starforge or --join-fleet is deliberate egress.
  const phrase = /everything stays on your machine/i;
  assert.ok(!phrase.test(README), "README tagline must not assert no-egress unconditionally");
  assert.ok(!phrase.test(PKG.description), "package.json description must not either");
  assert.ok(!phrase.test(PROVE));
});

// ---- finding: assorted doc sentences the code does not back -----------------

test("README's secret-pattern count matches src/redact.mjs", () => {
  const src = read("src/redact.mjs");
  const block = src.slice(
    src.indexOf("const SECRET_PATTERNS = ["),
    src.indexOf("];", src.indexOf("const SECRET_PATTERNS = ["))
  );
  const patterns = block.split("\n").filter((l) => /^\s*\/.*\/[gimsuy]*,\s*(\/\/.*)?$/.test(l));
  assert.ok(patterns.length > 0, "failed to parse SECRET_PATTERNS out of redact.mjs");

  const stated = README.match(/(\d+)\s+secret regexes/);
  assert.ok(stated, "README must state the secret-regex count");
  assert.equal(
    Number(stated[1]),
    patterns.length,
    `README says ${stated?.[1]} secret regexes; redact.mjs has ${patterns.length}`
  );

  // …and the "plus labeled-assignment and ENV_VAR=value" extras are counted once.
  const total = README.match(/(\d+)\s+matchers in all/);
  assert.ok(total, "README must state the total matcher count");
  assert.equal(Number(total[1]), patterns.length + 2);
});

test("no doc claims there is zero network code in this tree", () => {
  for (const [name, md] of [["README.md", README], ["PROVE-IT.md", PROVE]]) {
    assert.ok(!/zero network code/i.test(md), `${name}: 'zero network code' is false — confine.mjs connects`);
    assert.ok(
      !/There is no network code in this source tree/i.test(md),
      `${name}: flat 'no network code' claim is false`
    );
  }
  assert.match(README, /only network code in this tree is one deliberate outbound probe/i);
});

test("README does not claim verify rescans everything on disk", () => {
  assert.ok(!/re-scans everything on disk/i.test(README));
  assert.match(README, /prints the exact scope it covered/i);
});

test("PROVE-IT's output-scrub row scopes its claim and does not promise a guarantee", () => {
  assert.match(PROVE, /read the scope it prints/i);
  assert.match(PROVE, /never "there is nothing to find"/i);
});

test("PROVE-IT's verbatim probe output includes the errno detail the code prints", () => {
  assert.match(PROVE, /egress attempt: TCP 1\.1\.1\.1:443/);
  assert.match(PROVE, /\(connect EPERM 1\.1\.1\.1:443 - Local \(0\.0\.0\.0:0\)\)/);
});

test("PROVE-IT drops the stale 'once wired into the published CLI' hedge", () => {
  assert.ok(!/once wired into the published CLI/i.test(PROVE));
});

test("MIT LICENSE ships and matches package.json", () => {
  assert.equal(PKG.license, "MIT");
  assert.ok(existsSync(root + "LICENSE"), "LICENSE file must exist");
  const lic = read("LICENSE");
  assert.match(lic, /MIT License/);
  assert.match(lic, /Permission is hereby granted, free of charge/);
  assert.ok(PKG.files.includes("LICENSE"), "LICENSE must be in package.json files[]");
  assert.match(README, /\[LICENSE\]\(LICENSE\)/);
});

// ---- finding: §5 tarball recipe hands the user a false verification ---------

test("PROVE-IT §5 uses npm's actual hash algorithms", () => {
  assert.match(PROVE, /shasum -a 1 /, "dist.shasum is SHA-1");
  assert.match(PROVE, /openssl dgst -sha512 -binary/, "dist.integrity is base64 SHA-512");
  for (const line of codeBlockLines(PROVE)) {
    assert.ok(
      !/shasum -a 256/.test(line),
      `SHA-256 can never match dist.shasum or dist.integrity: ${line}`
    );
  }
  assert.match(PROVE, /WITHOUT its "sha512-" prefix/);
});

test("PROVE-IT §5 gives the wrong-package failure branch and the unpublished branch", () => {
  assert.match(PROVE, /package\/src\//);
  assert.match(PROVE, /If there is no `package\/src\/`, you fetched a different package/);
  assert.match(PROVE, /npm pack --pack-destination/, "must give the recipe that works pre-publish");
});

// ---- finding: §3 tcpdump does not work on macOS ----------------------------

test("PROVE-IT §3 gives a macOS tcpdump form and marks '-i any' as Linux-only", () => {
  assert.match(PROVE, /sudo tcpdump -i en0 -n/);
  assert.match(PROVE, /macOS has \*\*no `any` device\*\*/);
  const lines = PROVE.split("\n");
  lines.forEach((line, i) => {
    if (!/tcpdump -i any/.test(line)) return;
    const context = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
    assert.match(
      context,
      /Linux|macOS has/,
      `'-i any' must be labeled Linux-only, near line ${i + 1}`
    );
  });
});

test("commands that need root are marked as needing root", () => {
  for (const line of codeBlockLines(PROVE)) {
    if (!/^\s*sudo /.test(line)) continue;
    assert.ok(/tcpdump/.test(line), `unexpected sudo command in the docs: ${line}`);
  }
  assert.match(PROVE, /NEEDS SUDO/);
  assert.match(PROVE, /no sudo needed/);
});

// ---- finding: undocumented prove subcommand + scripted proof ---------------

test("`prove` and bin/starforge-proof.sh are documented in both docs", () => {
  for (const [name, md] of [["README.md", README], ["PROVE-IT.md", PROVE]]) {
    assert.match(md, /bin\/starforge-proof\.sh/, `${name} must document the scripted proof`);
    assert.match(md, /\bprove\b/, `${name} must document the prove subcommand`);
  }
  assert.ok(existsSync(root + "bin/starforge-proof.sh"));
});

// The repo IS pushed now, so a clone instruction is honest and this guard has
// flipped: what must not be claimed is the half that is still false. npm has no
// starforge-cli on it, so nothing may read as though `npx starforge-cli` works
// today — that would send a reader to the registry for a package that isn't
// there (and the bare name `starforge` IS taken by an unrelated 2017 package,
// which is how a reader gets a stranger's code instead).
test("docs never imply the npm package is installable while it is unpublished", () => {
  for (const [name, md] of [["README.md", README], ["PROVE-IT.md", PROVE]]) {
    assert.match(
      md,
      /not published yet|not on npm yet|not published\s*\n?to npm yet/i,
      `${name} must disclose that npm publication has not happened`
    );
    // An `npx starforge-cli` line is allowed only in the future tense or inside
    // an explicit not-yet warning — never as a bare run instruction in a fenced
    // block, which is the thing people copy.
    for (const line of codeBlockLines(md)) {
      assert.ok(
        !/^\s*(\$\s*)?npx\s+starforge/.test(line),
        `${name}: a copyable line tells the reader to npx a package that is not published: ${line.trim()}`
      );
    }
  }
});

// ---- finding: the package must ship what the docs tell you to inspect ------

test("package.json files[] ships everything the docs reference", () => {
  for (const needed of ["src/", "bin/", "README.md", "PROVE-IT.md", "LICENSE"]) {
    assert.ok(PKG.files.includes(needed), `package.json files[] must include ${needed}`);
  }
  // tests/ ships on purpose — PROVE-IT §5 tells you to run them from the tarball.
  assert.ok(PKG.files.includes("tests/"));
  assert.match(PROVE, /node --test package\/tests\//);
  for (const entry of PKG.files) assert.ok(existsSync(root + entry), `files[] entry missing: ${entry}`);
});

test("package.json points at the project's home", () => {
  assert.match(PKG.repository.url, /github\.com\/Alexander-Sorrell-IT\/starforge/);
  assert.ok(PKG.homepage && PKG.bugs?.url);
});

// ---- finding: the README buried the differentiator and hid the artifacts ----
//
// These are ORDERING and PRESENCE tests, in that order of importance. The bug
// they exist to catch was not a missing sentence — the comparison was present,
// on line 48, under twenty lines of npm-naming apology. A presence-only test
// would have passed while the page still failed its one job.

const lineOf = (md, needle) => md.split("\n").findIndex((l) => l.includes(needle));

test("the README leads with the differentiator, not the npm-naming warning", () => {
  const diff = lineOf(README, "npx standout");
  const install = lineOf(README, "## Install");
  const squat = lineOf(README, "resure");
  assert.ok(diff >= 0, "README must name what it is being compared against");
  assert.ok(install >= 0 && squat >= 0, "README must still carry the Install/squat section");
  assert.ok(
    diff < install,
    `the standout comparison (line ${diff + 1}) must come before Install (line ${install + 1})`
  );
  assert.ok(
    diff < squat,
    `the standout comparison (line ${diff + 1}) must come before the squat warning (line ${squat + 1})`
  );
  assert.ok(
    diff <= 40,
    `the differentiator must be above the fold; found on line ${diff + 1}`
  );
});

test("the npm-squat warning is kept — demoted, not deleted, and still adjacent to Usage", () => {
  // HONESTY: the warning is true and load-bearing. Moving it is fine; losing it
  // is not, and it must sit where someone about to type a command will see it.
  assert.match(README, /resure/, "the squatting maintainer must still be named");
  assert.match(README, /don't run it/i, "the README must still say not to run the bare name");
  const install = lineOf(README, "## Install");
  const usage = lineOf(README, "## Usage");
  assert.ok(install < usage, "Install must sit above Usage");
  assert.ok(
    usage - install <= 20,
    `Install must be compressed and adjacent to Usage; it spans ${usage - install} lines`
  );
});

test("README showcases the kernel proof with BOTH sides of the positive control", () => {
  const CONFINE = read("src/confine.mjs");
  // Quoted verbatim from the code that prints them — and checked against that
  // code, so a reworded probe cannot leave a stale transcript in the README.
  for (const s of [
    "— egress is OPEN in this context",
    "on connect() — the kernel refused before any packet could leave",
  ]) {
    assert.ok(README.includes(s), `README must quote the probe verdict verbatim: ${s}`);
    assert.ok(
      CONFINE.includes(s),
      `src/confine.mjs no longer prints "${s}" — the README's quoted output has drifted from the code`
    );
  }
  assert.match(README, /NOT BLOCKED/, "the outside-the-sandbox control must be shown");
  assert.match(README, /result: BLOCKED/, "the inside-the-sandbox refusal must be shown");
});

test("README showcases the star card and the stats page", () => {
  for (const needle of [/--card/, /--page/, /star-<date>\.svg/, /stats-<date>\.html/]) {
    assert.match(README, needle, `README must document ${needle}`);
  }
  assert.match(README, /SKILL OVERVIEW/, "describe what the card actually renders");
  assert.match(README, /JUDGMENT SIGNALS/, "describe what the page actually renders");
});

test("README states publication status and how to run it today, up top", () => {
  const head = README.split("\n").slice(0, 32).join("\n");
  assert.match(head, /\*\*Status:\*\*/, "a Status line must sit near the top");
  // Two different facts, and they must not be collapsed into one: the source is
  // live on GitHub, the npm package is not published. A reader who assumes the
  // second from the first goes to the registry and finds someone else's 2017
  // package under the bare name.
  assert.match(head, /not published\s*\n?to npm yet|not published to npm yet/i);
  assert.match(
    head,
    /github\.com\/Alexander-Sorrell-IT\/starforge/,
    "the Status line must name where the source actually is"
  );
  assert.doesNotMatch(
    head,
    /not pushed yet/i,
    "the repo IS pushed — this claim is stale and must be removed, not softened"
  );
  assert.match(head, /node src\/cli\.mjs/, "say how to run it from a checkout");
});

test("the standout upload figures are attributed and dated, never asserted bare", () => {
  // These numbers were read from someone else's published bundle and cannot be
  // re-derived from this tree. Stating them is fair; stating them as though we
  // measured them is not.
  const lines = README.split("\n");
  const idx = lines.findIndex((l) => /500/.test(l) && /exchange pair/i.test(l));
  assert.ok(idx >= 0, "README must state the exchange-pair figure it is comparing against");
  const para = lines.slice(Math.max(0, idx - 6), idx + 6).join("\n");
  assert.match(para, /bundle/i, "the figure must name where it was read from");
  assert.match(para, /20\d\d/, "the figure must be dated — a vendor can change it any release");
});

// ---- finding: PROVE-IT §4 credited runConfined(), which the CLI never calls -

test("PROVE-IT §4 does not credit runConfined() with a path a user reaches", () => {
  assert.match(
    PROVE,
    /nothing in the CLI calls it/i,
    "PROVE-IT must say plainly that runConfined() is not on any user-reachable path"
  );
  // What makes that sentence true. If someone wires runConfined into the CLI
  // (a genuinely nice `--confined` demo), this fails loudly instead of leaving
  // the doc quietly wrong in the other direction.
  assert.ok(
    !/\brunConfined\b/.test(CLI),
    "src/cli.mjs now references runConfined — PROVE-IT §4 must be rewritten to match"
  );
  assert.match(PROVE, /bin\/starforge-proof\.sh/);
});

test("PROVE-IT states the three-way exit-code contract verify itself prints", () => {
  const VERIFY = read("src/verify.mjs");
  assert.match(PROVE, /2`? = \*\*verify itself crashed\*\*|`2` = \*\*verify itself crashed/);
  assert.match(VERIFY, /2 = verify itself crashed/, "verify must still print that contract");
  assert.match(PROVE, /SKIP \(nothing to inspect — NOT a pass\)/);
  assert.match(VERIFY, /nothing to inspect — NOT a pass/, "the SKIP badge text must still exist");
});

// The README prints one whole terminal frame and calls it verbatim output. That
// claim rots the moment the renderer's size, ramp or layout changes, and a
// stale picture of your own product is the kind of thing a reader checks first.
// So: regenerate the frame and require the doc to contain it byte for byte.
test("the star frame printed in the README is exactly what renderStar produces", async () => {
  const { renderStar } = await import("../src/star.mjs");
  // The levels the README's caption names.
  const frame = renderStar([4.8, 4.6, 4.7, 4.4, 4.5], {
    color: false,
    status: "scan complete",
  });
  assert.ok(
    README.includes(frame),
    "README's verbatim star frame no longer matches renderStar(). Regenerate it:\n" +
      "  node -e 'import(\"./src/star.mjs\").then(({renderStar})=>console.log(renderStar([4.8,4.6,4.7,4.4,4.5],{color:false,status:\"scan complete\"})))'\n" +
      "and paste the result into both fenced star blocks."
  );
  // And the dimensions the prose states must be the dimensions it actually has.
  const rows = frame.split("\n");
  const cols = Math.max(...rows.map((r) => r.length));
  assert.ok(
    README.includes(`${cols}×${rows.length}`),
    `README must state the real frame size (${cols}×${rows.length})`
  );
});
