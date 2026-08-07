// How many projects you worked in.
//
// This read 1 on a corpus holding 401 project directories, and ENGINEERING — an
// axis scored partly on project count — was measuring the shape of the export
// instead of the person. Three separate causes, each of which alone was enough:
//
//   1. cwd was redacted to the single string "/workspace" in every row, and the
//      project was derived from cwd only. The 401 DIRECTORIES survived intact.
//   2. the fallback session id was the file's BASENAME, so 83 different
//      projects that each contained a "journal.jsonl" merged into one session.
//   3. a sub-agent transcript carries its PARENT's session id while living in
//      its own project directory, so session-derived counting credited only
//      whichever directory happened to be read first.
//
// None of them threw, and the number stayed plausible throughout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyStats, parseClaudeFile, finalize, projectFromPath } from "../src/scan.mjs";

const ts = (d = 1) => `2026-07-${String(d).padStart(2, "0")}T15:00:00.000Z`;

function row(over = {}) {
  return JSON.stringify({
    type: "assistant", timestamp: ts(), uuid: Math.random().toString(36).slice(2),
    message: { role: "assistant", id: `m${Math.random()}`, model: "claude-opus-5",
      content: [{ type: "text", text: "x" }],
      usage: { input_tokens: 10, output_tokens: 5 } },
    ...over,
  });
}

/** Build ~/.claude/projects/<dir>/<file>.jsonl trees and scan them. */
async function scan(files) {
  const home = mkdtempSync(join(tmpdir(), "sf-proj-"));
  const stats = emptyStats();
  const paths = [];
  for (const [dir, name, rows] of files) {
    const d = join(home, ".claude", "projects", dir);
    mkdirSync(d, { recursive: true });
    const p = join(d, `${name}.jsonl`);
    writeFileSync(p, rows.join("\n"));
    paths.push(p);
  }
  for (const p of paths.sort()) await parseClaudeFile(p, stats, {});
  return finalize(stats);
}

test("the project directory is used when cwd cannot tell projects apart", async () => {
  // The exact corpus shape: distinct directories, one shared redacted cwd.
  const out = await scan([
    ["-workspace-p0001", "s1", [row({ cwd: "/workspace" })]],
    ["-workspace-p0002", "s2", [row({ cwd: "/workspace" })]],
    ["-workspace-p0003", "s3", [row({ cwd: "/workspace" })]],
  ]);
  assert.equal(out.projects_count, 3, "three directories are three projects");
});

test("an informative cwd still wins, so ordinary scans are unchanged", async () => {
  // Where cwd says something real it is the better label — it is the un-encoded
  // path. The directory is a fallback, not a replacement.
  const out = await scan([
    ["-home-me-alpha", "s1", [row({ cwd: "/home/me/alpha" })]],
    ["-home-me-beta", "s2", [row({ cwd: "/home/me/beta" })]],
  ]);
  assert.equal(out.projects_count, 2);
  // The label must come from cwd ("me/alpha"), not from the encoded directory
  // name ("-home-me-alpha" -> "/home/me/alpha" is the same place, but cwd is the
  // un-encoded source and survives project names that contain dashes).
  assert.deepEqual(
    out.projects.map((p) => p.name).sort(),
    ["me/alpha", "me/beta"]
  );
});

test("same-named transcripts in different projects are different sessions", async () => {
  // 83 projects each had a journal.jsonl and all 83 became one session.
  const out = await scan([
    ["-workspace-p0001", "journal", [row({ cwd: "/workspace" })]],
    ["-workspace-p0002", "journal", [row({ cwd: "/workspace" })]],
    ["-workspace-p0003", "journal", [row({ cwd: "/workspace" })]],
  ]);
  assert.equal(out.total_sessions, 3, "a basename is not a session identity");
  assert.equal(out.projects_count, 3);
});

test("a sub-agent transcript does not swallow its sibling projects", async () => {
  // agent-*.jsonl carries the PARENT's sessionId but sits in its own directory.
  // Session-derived counting credited only the first directory read.
  const sid = "3798c011-49df-47f2-b36d-6d2aaa0a1b5f";
  const out = await scan([
    ["-workspace-p0286", sid, [row({ cwd: "/workspace", sessionId: sid })]],
    ["-workspace-p0083", "agent-a5013d0e", [row({ cwd: "/workspace", sessionId: sid })]],
    ["-workspace-p0179", "agent-a0991b12", [row({ cwd: "/workspace", sessionId: sid })]],
  ]);
  assert.equal(out.total_sessions, 1, "they really are one session");
  assert.equal(out.projects_count, 3, "but they are three projects");
});

test("a project with no cwd at all is still counted", async () => {
  const out = await scan([
    ["-workspace-p0001", "s1", [row()]],
    ["-workspace-p0002", "s2", [row()]],
  ]);
  assert.equal(out.projects_count, 2);
});

test("projectFromPath decodes the directory, and refuses what is not one", () => {
  assert.equal(projectFromPath("/h/.claude/projects/-home-me-alpha/s.jsonl"), "me/alpha");
  assert.equal(projectFromPath("/h/.claude/projects/-workspace-p0007/s.jsonl"), "/workspace/p0007");
  for (const bad of ["", null, undefined, "s.jsonl"])
    assert.equal(projectFromPath(bad), null, `${JSON.stringify(bad)} is not a project path`);
});

test("the count is the union of both witnesses, never their sum", async () => {
  // Two files in ONE directory must not count twice.
  const out = await scan([
    ["-workspace-p0001", "a", [row({ cwd: "/workspace" })]],
    ["-workspace-p0001", "b", [row({ cwd: "/workspace" })]],
  ]);
  assert.equal(out.projects_count, 1);
});

test("finalize still reports the true count when sessions carry projects directly", () => {
  // The other caller shape: sessions built without files at all. The union must
  // not have broken it.
  const stats = emptyStats();
  for (let i = 0; i < 37; i++)
    stats.sessions.set(`s${i}`, {
      firstTs: 1e12, lastTs: 1e12 + 6e4, minutes: new Set([1]),
      project: `p${i}`, models: new Map(), tok: { in: 1, out: 1, cr: 0, cw: 0 },
      tools: 0, turns: 0, source: "claude_code",
      exts: new Map(), hours: new Array(24).fill(0), days: new Set(["2001-09-09"]),
    });
  const out = finalize(stats);
  assert.equal(out.projects.length, 20, "the DISPLAY list stays capped");
  assert.equal(out.projects_count, 37, "the SCORE input is the real number");
});

test("a project whose folder name contains a dash is ONE project", async () => {
  // The union counts two witnesses: projectLabel(cwd) and projectFromPath(dir).
  // Claude Code encodes the working directory by replacing every separator with
  // a dash, so decoding cannot tell a separator from a dash that was always in
  // the name: "-srv-code-starforge-cli" decodes to "starforge/cli" while the cwd
  // reads "code/starforge-cli". Two spellings, one project, counted twice — and
  // projects_count feeds the ENGINEERING axis, so the star inflated.
  //
  // Every earlier test in this file was blind to it: they either use the
  // uninformative cwd "/workspace" (where the directory wins for the session
  // too, so both witnesses match by construction) or "-home-me-alpha", which has
  // no dash inside a segment and decodes byte-identically.
  const out = await scan([["-srv-code-my-app", "a", [row({ cwd: "/srv/code/my-app" })]]]);
  assert.equal(out.projects_count, 1, "one directory and one cwd are one project");
  const many = await scan(
    [...Array(6)].map((_, i) => [`-srv-code-app-${i}`, "s", [row({ cwd: `/srv/code/app-${i}` })]])
  );
  assert.equal(many.projects_count, 6, "six dashed projects are six, not twelve");
});

test("aliasing does not re-merge projects a sub-agent spans", async () => {
  // The obvious fix — alias dirProject onto s.project — collapses these three
  // back to one, because one shared sessionId maps every directory onto whichever
  // was read first. The alias must be keyed off the FILE's own cwd.
  const sid = "3798c011-49df-47f2-b36d-6d2aaa0a1b5f";
  const out = await scan([
    ["-srv-code-my-app", sid, [row({ cwd: "/srv/code/my-app", sessionId: sid })]],
    ["-srv-code-other-app", "agent-a1", [row({ cwd: "/srv/code/other-app", sessionId: sid })]],
    ["-srv-code-third-app", "agent-a2", [row({ cwd: "/srv/code/third-app", sessionId: sid })]],
  ]);
  assert.equal(out.total_sessions, 1, "still one session");
  assert.equal(out.projects_count, 3, "but three projects, each with a dash");
});
