// @ts-nocheck
// What the scan can SEE.
//
// discoverSources hardcoded one profile per root — join(root,".claude") — and
// capped the walk at depth 2. On this machine that read 85 of 1,686 transcripts
// and left 5,875,900,498 tokens unread, and no flag reached the rest: --roots
// takes HOME directories and re-appends "/.claude", so passing a profile
// directory returned 0 files.
//
// Widening what is read is only safe if three other things hold, and each has
// its own test below:
//   1. deeper files must not be counted twice (creditUsage keys on message.id
//      across the whole scan — 323 of this machine's 46,723 distinct ids really
//      do appear in a second file)
//   2. a sub-agent transcript's project is the directory under projects/, not
//      its parent directory, which is literally "subagents" or "wf_<hex>" for
//      1,557 of the 1,686
//   3. a profile that discovery finds and the roots exclude must SAY so, never
//      look like a profile that is not there
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  discoverSources,
  emptyStats,
  finalize,
  parseClaudeFile,
  projectDirOf,
  projectFromPath,
} from "../src/scan.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "sf-cov-"));

const row = (id, over = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T15:00:00.000Z",
    uuid: `u-${id}`,
    message: {
      role: "assistant",
      id,
      model: "claude-opus-5",
      content: [{ type: "text", text: "x" }],
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 10,
      },
    },
    ...over,
  });

/** Write one transcript at <home>/<profile>/projects/<...segments>. */
function put(home, profile, segments, rows) {
  const dir = join(home, profile, "projects", ...segments.slice(0, -1));
  mkdirSync(dir, { recursive: true });
  const p = join(dir, segments[segments.length - 1]);
  writeFileSync(p, rows.join("\n"));
  return p;
}

const claudePaths = (roots) =>
  discoverSources(roots)
    .filter((s) => s.source === "claude_code")
    .map((s) => s.path);

// ---- 1: every profile, not just ".claude" ----------------------------------

test("all five Claude profiles under a root are scanned, not only .claude", () => {
  const home = tmp();
  const profiles = [".claude", ".claude-alt", ".my-claude", ".claude-it", ".claude-alt-api"];
  for (const p of profiles) put(home, p, ["-w-proj", "s.jsonl"], [row(`m-${p}`)]);
  const paths = claudePaths([home]);
  assert.equal(paths.length, 5, `one transcript per profile, got ${paths.length}`);
  for (const p of profiles)
    assert.ok(
      paths.some((f) => f.includes(`/${p}/`)),
      `${p} was not discovered — this is the 1,346-transcript gap`
    );
});

test("a root that IS a profile directory is scanned — --roots could not say this", () => {
  const home = tmp();
  put(home, ".claude-alt", ["-w-proj", "s.jsonl"], [row("m1")]);
  const paths = claudePaths([join(home, ".claude-alt")]);
  assert.equal(paths.length, 1, "passing the profile directory itself returned nothing");
});

// ---- 2: depth ---------------------------------------------------------------

test("sub-agent and workflow transcripts five levels below projects/ are read", () => {
  const home = tmp();
  // The two real layouts, at depth 3 and depth 5 below projects/.
  put(home, ".claude", ["-w-proj", "sess", "subagents", "agent-a1.jsonl"], [row("m1")]);
  put(
    home,
    ".claude",
    ["-w-proj", "sess", "subagents", "workflows", "wf_abc", "agent-a2.jsonl"],
    [row("m2")]
  );
  put(home, ".claude", ["-w-proj", "sess.jsonl"], [row("m3")]);
  assert.equal(claudePaths([home]).length, 3, "the nested transcripts were not reached");
});

// ---- 3: deeper cannot double count -----------------------------------------

test("one message id in two transcripts is credited once, not twice", async () => {
  // The same assistant message, written into a session file and into the
  // sub-agent file below it. Depth 2 could only ever see the first.
  const home = tmp();
  const a = put(home, ".claude", ["-w-proj", "sess.jsonl"], [row("msg_shared")]);
  const b = put(
    home,
    ".claude",
    ["-w-proj", "sess", "subagents", "agent-a1.jsonl"],
    [row("msg_shared")]
  );
  const stats = emptyStats();
  for (const p of [a, b]) await parseClaudeFile(p, stats, {});
  const out = finalize(stats);
  assert.equal(out.total_input_tokens, 100);
  assert.equal(out.total_output_tokens, 20);
  assert.equal(out.total_cache_read_tokens, 1000);
  assert.equal(out.total_cache_write_tokens, 10);
});

// ---- 4: the project of a nested transcript ---------------------------------

test("a nested transcript's project is its project directory, never 'subagents'", () => {
  const base = "/home/me/.claude/projects/-home-me-work";
  assert.equal(projectDirOf(`${base}/sess.jsonl`), "-home-me-work");
  assert.equal(projectDirOf(`${base}/sess/subagents/agent-a1.jsonl`), "-home-me-work");
  assert.equal(
    projectDirOf(`${base}/sess/subagents/workflows/wf_abc/agent-a2.jsonl`),
    "-home-me-work"
  );
  // Cowork has no "projects" component; the parent directory is the answer there.
  assert.equal(
    projectDirOf("/home/me/Library/Application Support/Claude/local-agent-mode-sessions/a/b/c.jsonl"),
    "b"
  );
  // A file directly in projects/ names no project, as before.
  assert.equal(projectFromPath("/home/me/.claude/projects/x.jsonl"), null);
});

test("three transcripts of one project are one project, not three", async () => {
  const home = tmp();
  const paths = [
    put(home, ".claude", ["-w-proj", "sess.jsonl"], [row("m1")]),
    put(home, ".claude", ["-w-proj", "sess", "subagents", "agent-a1.jsonl"], [row("m2")]),
    put(
      home,
      ".claude",
      ["-w-proj", "sess", "subagents", "workflows", "wf_abc", "agent-a3.jsonl"],
      [row("m3")]
    ),
  ];
  const stats = emptyStats();
  for (const p of paths.sort()) await parseClaudeFile(p, stats, {});
  const out = finalize(stats);
  assert.equal(out.projects_count, 1, "'subagents' and 'wf_abc' were counted as projects");
  assert.deepEqual(
    out.projects.map((p) => p.name),
    ["/w/proj"]
  );
});

// ---- 5: a profile outside the roots is named, not dropped -------------------

test("a profile the roots exclude is reported on stderr, not silently skipped", () => {
  // findConfigDirs honours $CLAUDE_CONFIG_DIR whenever homedir() equals the
  // root, and homedir() follows $HOME — so a fixture home pulls in whatever the
  // live environment points at. Reading it would make the scan a function of
  // the environment; dropping it in silence would make a profile that exists
  // look like one that does not.
  const home = tmp();
  const elsewhere = tmp();
  put(elsewhere, "profile", ["-w-other", "s.jsonl"], [row("m1")]);
  put(home, ".claude", ["-w-proj", "s.jsonl"], [row("m2")]);
  const saved = {
    HOME: process.env.HOME,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    write: process.stderr.write,
  };
  const lines = [];
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(elsewhere, "profile");
  process.stderr.write = (s) => (lines.push(String(s)), true);
  let paths;
  try {
    assert.equal(homedir(), home, "the $HOME override must reach os.homedir()");
    paths = claudePaths([home]);
  } finally {
    process.stderr.write = saved.write;
    process.env.HOME = saved.HOME;
    if (saved.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved.CLAUDE_CONFIG_DIR;
  }
  assert.equal(paths.length, 1, "only the transcript under the root is read");
  const note = lines.join("");
  assert.match(note, /NOT read/);
  assert.match(note, /--roots/);
  // Naming it is the point: a count of skipped profiles with no name is not
  // actionable.
  assert.ok(note.includes("profile"), `the skipped directory is not named: ${note}`);
});
